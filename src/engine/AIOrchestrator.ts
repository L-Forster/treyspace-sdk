/**
 * AI Orchestrator - Tool Selection & Execution
 *
 * Responsible for intelligent tool selection in the RAG pipeline.
 * Uses an LLM to decide which cluster(s) to traverse based on the user's query.
 *
 * This component acts as a "router" that determines the most relevant
 * semantic clusters to provide as context for the final response.
 */

import { BackendMCPTraversalManager } from "./MCPTraversalManager.js";
import { buildAuthHeadersFromReq, getProxyBaseFromReq, type RequestLike } from "./util.js";

// Tool selection LLM configuration
const ORCHESTRATOR_MODEL = "gpt-5-mini";
const ORCHESTRATOR_MAX_TOKENS = 1_000;

interface ChatMessage {
  role: string;
  content: string;
}

interface ClusterData {
  relational_clusters?: any[];
  semantic_clusters?: any[];
  distance_clusters?: any[];
}

/**
 * Backend AI Orchestrator
 *
 * Selects and executes the appropriate MCP tool for a given user query.
 * Uses function calling to intelligently route to cluster traversal or skip tools.
 */
export class BackendAIOrchestrator {
  private readonly req: RequestLike;
  private readonly boardId?: string;
  private readonly proxyBase: string;

  constructor(req: RequestLike, boardId?: string) {
    this.req = req;
    this.boardId = boardId;
    this.proxyBase = getProxyBaseFromReq(req);
  }

  private responsesEndpoint() {
    return `${this.proxyBase.replace(/\/$/, "")}/v1/responses`;
  }

  /**
   * Builds a human-readable summary of available clusters
   *
   * @param clusterData - Cluster data from Helix
   * @returns Formatted string listing all clusters with descriptions
   *
   * Creates a text summary that the LLM can use to choose which cluster to traverse.
   */
  private buildClusterInfo(clusterData: ClusterData | undefined) {
    if (!clusterData) {
      return "No relevant groups of elements available";
    }
    const clusters = [
      ...(clusterData.relational_clusters || []).map((c: any) => ({ ...c, type: "relational" })),
      ...(clusterData.semantic_clusters || []).map((c: any) => ({ ...c, type: "semantic" })),
      ...(clusterData.distance_clusters || []).map((c: any) => ({ ...c, type: "distance" })),
    ];
    if (clusters.length === 0) {
      return "No relevant groups of elements available";
    }
    return `Available groups of elements:\n${clusters
      .map((cluster: any) => {
        const actualId = String(cluster.id || cluster.cluster_id || "").replace(
          /^(relational_|semantic_|distance_)/,
          ""
        );
        const description = cluster.description || "No description";
        const count =
          cluster.member_count || (Array.isArray(cluster.members) ? cluster.members.length : 0);
        return `- ${actualId}: ${description} (${count} elements)`;
      })
      .join("\n")}`;
  }

  /**
   * Intelligently selects and executes the appropriate MCP tool
   *
   * @param userMessage - User's query
   * @param clusterData - Available clusters
   * @param summarizedHistory - Condensed chat history
   * @param lastMessages - Recent chat messages for context
   * @param onEvent - Status callback
   * @param signal - Cancellation signal
   * @returns Tool execution result or null
   *
   * Uses function calling to let an LLM decide:
   * - Which cluster to traverse (mcp_cluster_traverse)
   * - Or whether no tools are needed (no_tools_needed)
   */
  async chooseAndExecuteMCPTool(
    userMessage: string,
    clusterData: ClusterData,
    summarizedHistory: string,
    lastMessages: ChatMessage[],
    onEvent?: (status: string) => void,
    signal?: AbortSignal
  ) {
    onEvent?.("LLM: Deciding what tool to use...");

    const clusterInfo = this.buildClusterInfo(clusterData);
    const lastTwoLines = (Array.isArray(lastMessages) ? lastMessages : [])
      .filter((message) => message && typeof message.content === "string")
      .map((message) => `${message.role}: ${message.content}`)
      .join("\n");

    const instructions = `You are an expert canvas analysis agent. Your goal is to select the correct tool to answer the user's question about a diagram by following these rules:

1.  **Analyze Intent:** Read the user's question and the message history to understand what they are asking for.
2.  **Review Canvas Context:** The provided descriptions of element groups are high-level summaries. They do not contain detailed element data or connection information. Do NOT reveal technical terms like "relational," "semantic," "distance," or "spatial" when referring to these groups.
3.  **Select a Tool:**
    *   You **MUST** call \`mcp_cluster_traverse\` if the user's question is about the diagram's content, structure, or relationships. For general questions like "explain the diagram," choose the largest or most relevant group of elements to traverse.
    *   You should **ONLY** call \`no_tools_needed\` for questions that are not about the diagram at all (e.g., "hello", "who are you?").

IMPORTANT: When calling mcp_cluster_traverse, use the cluster_id exactly as shown in the available groups list (e.g., "r_1", "s_1", "d_1"). Do NOT reveal these IDs to the user.

You must call one of the provided functions.

AVAILABLE MCP TOOLS:
- mcp_cluster_traverse: Traverse a specific group of elements by ID to get its detailed members and connections.
- no_tools_needed: Use only when the user's question is not about the diagram.`;

    const prompt = `MESSAGE HISTORY:
${summarizedHistory ? `- Summary: ${summarizedHistory}\n` : ""}${lastTwoLines ? `- Last Messages:\n${lastTwoLines}\n` : ""}

USER QUESTION: "${userMessage}"

AVAILABLE GROUPS OF ELEMENTS:
${clusterInfo}`;

    const headers = buildAuthHeadersFromReq(this.req, true);
    const response = await fetch(this.responsesEndpoint(), {
      method: "POST",
      headers,
      body: JSON.stringify({
        model: ORCHESTRATOR_MODEL,
        instructions,
        input: prompt,
        stream: false,
        max_output_tokens: ORCHESTRATOR_MAX_TOKENS,
        tool_choice: "required",
        tools: [
          {
            type: "function",
            name: "no_tools_needed",
            description: "No MCP tools needed for this simple question",
            parameters: {
              type: "object",
              properties: {
                reasoning: {
                  type: "string",
                  description: "Why no tools are needed",
                },
              },
              required: ["reasoning"],
              additionalProperties: false,
            },
            strict: true,
          },
          {
            type: "function",
            name: "mcp_cluster_traverse",
            description:
              "Traverse a specific group of elements to list members and connections (for anything beyond listing the element text, e.g., understanding relationships in groups / diagrams). Use group IDs like 'r_1', 's_1', 'd_1' (without the type prefix).",
            parameters: {
              type: "object",
              properties: { boardId: { type: "string" }, cluster_id: { type: "string" } },
              required: ["boardId", "cluster_id"],
              additionalProperties: false,
            },
            strict: true,
          },
        ],
      }),
      signal,
    });

    if (!response.ok) {
      throw new Error(`Responses API error: ${response.status}`);
    }

    const result = (await response.json()) as { output?: string | unknown[] };
    const outputArray =
      typeof result.output === "string" ? JSON.parse(result.output) : result.output;
    const functionCall = Array.isArray(outputArray)
      ? (outputArray.find((item: { type?: string }) => item?.type === "function_call") as
          | { name?: string; arguments?: string }
          | undefined)
      : undefined;

    if (!functionCall) return null;

    const args = JSON.parse(functionCall.arguments || "{}") as Record<string, unknown>;
    onEvent?.("Analyzing your request...");

    if (functionCall.name === "no_tools_needed") {
      onEvent?.("Ready to respond.");
      return { no_tools_needed: true, reasoning: args?.reasoning };
    }

    const traversalManager = new BackendMCPTraversalManager(this.req, onEvent, signal);
    if (this.boardId) args.boardId = this.boardId;
    const toolResult = await traversalManager.executeTool(functionCall.name ?? "", args);
    onEvent?.("Processing complete.");
    return toolResult?.result || toolResult;
  }
}
