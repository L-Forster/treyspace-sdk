/**
 * AI Engine - Main RAG Pipeline Orchestrator
 *
 * Coordinates the full retrieval-augmented generation pipeline:
 * 1. Summarizes chat history for context
 * 2. Retrieves semantic clusters from Helix via SDK façade
 * 3. Generates cluster descriptions using LLM
 * 4. Orchestrates tool selection (cluster traversal)
 * 5. Streams final LLM response with full canvas context
 *
 * This is the core of the canvas-aware AI system.
 */

import { BackendAIOrchestrator } from "./AIOrchestrator.js";
import { BackendClusterService } from "./ClusterService.js";
import { extractId, extractIds, extractClusterId, findClusterById } from "./idHelpers.js";
import { BackendMCPTraversalManager } from "./MCPTraversalManager.js";
import { buildAuthHeadersFromReq, getProxyBaseFromReq, type RequestLike } from "./util.js";

// LLM configuration constants
const MAX_INPUT_LENGTH = 10_000;
const MAX_HISTORY_LENGTH = 20_000;
const HISTORY_SUMMARY_TOKENS = 256;
const DEFAULT_MODEL = "gpt-5-mini";
const MAIN_MODEL = "gpt-5";
const MAX_RESPONSE_TOKENS = 4_000;

interface Message {
  role: string;
  content: string;
}

interface AskParams {
  userMessage: string;
  settings?: Record<string, unknown>;
  history?: Message[];
  signal?: AbortSignal;
  onEvent?: (status: string) => void;
  onText?: (text: string) => void;
  emitControl?: (event: string, payload: Record<string, unknown>) => void;
  userSelectedContext?: unknown;
}

/**
 * Sanitizes user input to prevent injection attacks
 *
 * @param value - Input string to sanitize
 * @returns Sanitized string
 *
 * Truncates to MAX_INPUT_LENGTH and escapes code block markers.
 */
const sanitize = (value: string) =>
  value.slice(0, MAX_INPUT_LENGTH).replace(/```/g, "\u0060\u0060\u0060").trim();

/**
 * Backend AI Engine
 *
 * Main class for processing canvas-aware LLM requests.
 * Handles the complete RAG pipeline from cluster retrieval to streaming responses.
 */
export class BackendAIEngine {
  private readonly req: RequestLike;
  private readonly boardId?: string;
  private readonly proxyBase: string;
  private readonly clusterService: BackendClusterService;
  private readonly orchestrator: BackendAIOrchestrator;

  constructor(req: RequestLike, { boardId }: { boardId?: string } = {}) {
    this.req = req;
    this.boardId = boardId;
    this.proxyBase = getProxyBaseFromReq(req);
    this.clusterService = new BackendClusterService(req, boardId);
    this.orchestrator = new BackendAIOrchestrator(req, boardId);
  }

  private responsesEndpoint() {
    return `${this.proxyBase.replace(/\/$/, "")}/v1/responses`;
  }

  /**
   * Summarizes chat history into a concise context string
   *
   * @param messages - Array of chat messages
   * @returns Summarized history (max 300 chars) or empty string
   *
   * Uses a small fast model (gpt-5-mini) to condense chat history.
   * Returns empty string on error to gracefully degrade.
   */
  async summarizeHistory(messages: Message[] | undefined): Promise<string> {
    try {
      if (!messages || messages.length === 0) return "";
      const lines = messages
        .filter(
          (message) =>
            message && typeof message.role === "string" && typeof message.content === "string"
        )
        .map((message) => `${message.role}: ${sanitize(message.content)}`)
        .join("\n");

      const instructions = [
        "You are a chat history summarizer. Your role is strictly limited to:",
        "- Summarizing provided chat history in <=300 characters",
        "- Focusing only on user goals and diagram constraints",
        "- Outputting plain text summary only",
        "",
        "CHAT HISTORY TO SUMMARIZE:",
      ].join("\n");

      const response = await fetch(this.responsesEndpoint(), {
        method: "POST",
        headers: buildAuthHeadersFromReq(this.req, true),
        body: JSON.stringify({
          model: DEFAULT_MODEL,
          instructions,
          input: lines.slice(0, MAX_HISTORY_LENGTH),
          stream: false,
          tool_choice: "none",
          max_output_tokens: HISTORY_SUMMARY_TOKENS,
        }),
      });
      if (!response.ok) return "";
      const json = (await response.json().catch(() => ({}))) as Record<string, unknown>;
      const text =
        (json?.output_text as string) ||
        ((json?.choices as Array<{ message?: { content?: string } }>)?.[0]?.message
          ?.content as string) ||
        "";
      return typeof text === "string" ? text.trim() : "";
    } catch {
      return "";
    }
  }

  /**
   * Checks if cluster data contains any non-empty clusters
   *
   * @param clusterData - Cluster data object
   * @returns true if clusters exist
   *
   * Checks all three cluster types: relational, semantic, distance.
   */
  private hasClusters(clusterData: any) {
    try {
      return (
        (Array.isArray(clusterData?.relational_clusters) &&
          clusterData.relational_clusters.length > 0) ||
        (Array.isArray(clusterData?.distance_clusters) &&
          clusterData.distance_clusters.length > 0) ||
        (Array.isArray(clusterData?.semantic_clusters) && clusterData.semantic_clusters.length > 0)
      );
    } catch {
      return false;
    }
  }

  /**
   * Main RAG pipeline execution
   *
   * @param params - Pipeline parameters
   * @param params.userMessage - User's question about the canvas
   * @param params.history - Chat history for context
   * @param params.signal - AbortSignal for cancellation
   * @param params.onEvent - Callback for status updates
   * @param params.onText - Callback for streaming text chunks
   * @param params.emitControl - Callback for UI control events (highlighting)
   *
   * Orchestrates the complete RAG flow:
   * 1. Summarize history
   * 2. Initialize MCP connection
   * 3. Retrieve/generate clusters
   * 4. Select and execute traversal tool
   * 5. Stream final LLM response with context
   */
  async pipeline({ userMessage, history = [], signal, onEvent, onText, emitControl }: AskParams) {
    if (!userMessage?.trim()) return;

    const summarizedHistory = await this.summarizeHistory(history);
    if (summarizedHistory) {
      onEvent?.(`UPDATE: history_summary: ${summarizedHistory}`);
    }

    const lastMessages = Array.isArray(history) ? history.slice(-2) : [];
    const traversalManager = new BackendMCPTraversalManager(this.req, onEvent, signal);

    try {
      await traversalManager.executeTool("mcp_init", {});
    } catch (error) {
      onEvent?.(`MCP INIT WARNING: ${(error as Error).message}`);
    }

    let clusterData = await this.clusterService.getCanvasClusters();
    if (this.hasClusters(clusterData)) {
      clusterData = await this.clusterService.generateClusterDescriptions(clusterData, onEvent);
    }

    if (!this.hasClusters(clusterData)) {
      onEvent?.("ACTION: No clusters found; creating clusters via mcp_clusters…");
      try {
        const result = await traversalManager.executeTool("mcp_clusters", {
          boardId: this.boardId,
        });
        clusterData = result?.result || result;
        onEvent?.("Generating cluster descriptions…");
        clusterData = await this.clusterService.generateClusterDescriptions(clusterData, onEvent);
      } catch (error) {
        onEvent?.(`ERROR: failed to build clusters: ${(error as Error).message}`);
        onText?.("I had trouble building an understanding of the diagram. Could you try again?");
        return;
      }
    }

    if (!this.hasClusters(clusterData)) {
      onEvent?.("ERROR: clusters are still not available after rebuild attempt.");
      onText?.(
        "I'm having trouble analyzing the canvas, responses may be inaccurate. \n\n _Generating response based on available information..._ \n\n"
      );
    }

    const clusterSummary = this.clusterService.summarizeCluster(clusterData);
    const clusterContext = `=== CLUSTERS SUMMARY ===\n${clusterSummary}`;

    let toolResultsContext = "";
    try {
      onEvent?.("Choosing and executing tool…");
      const toolResult = await this.orchestrator.chooseAndExecuteMCPTool(
        userMessage,
        clusterData,
        summarizedHistory,
        lastMessages,
        onEvent,
        signal
      );

      if (toolResult?.no_tools_needed) {
        onEvent?.("Skipping tools - using basic cluster context");
      } else if (clusterData) {
        const clusterType = (toolResult as any)?.cluster_type || (toolResult as any)?.clusterType;
        const clusters = [
          ...(clusterData?.relational_clusters || []),
          ...(clusterData?.semantic_clusters || []),
          ...(clusterData?.distance_clusters || []),
        ];
        const toolCluster = toolResult as any;
        const clusterId = extractClusterId(toolCluster);

        const highlightIds = new Set<string>();
        if (clusterId) {
          const usedCluster = findClusterById(clusters, clusterId);
          if (usedCluster) {
            extractIds((usedCluster as any).memberIds).forEach((id) => highlightIds.add(id));
            extractIds((usedCluster as any).member_ids).forEach((id) => highlightIds.add(id));
            extractIds((usedCluster as any).members).forEach((id) => highlightIds.add(id));
          }
        }
        extractIds(toolCluster?.memberIds).forEach((id) => highlightIds.add(id));
        extractIds(toolCluster?.member_ids).forEach((id) => highlightIds.add(id));
        extractIds(toolCluster?.members).forEach((id) => highlightIds.add(id));

        if (highlightIds.size === 0 && clusters.length > 0) {
          const fallbackCluster = clusterId
            ? findClusterById(clusters, clusterId) || clusters[0]
            : clusters[0];
          if (fallbackCluster) {
            extractIds((fallbackCluster as any).memberIds).forEach((id) => highlightIds.add(id));
            extractIds((fallbackCluster as any).member_ids).forEach((id) => highlightIds.add(id));
            extractIds((fallbackCluster as any).members).forEach((id) => highlightIds.add(id));
          }
        }

        const elementIds = Array.from(highlightIds);
        if (elementIds.length > 0) {
          onEvent?.(`Highlighting ${elementIds.length} elements from relevant cluster…`);
          emitControl?.("highlight", {
            elementIds,
            options: { color: "#ff6b35", width: 3, style: "dashed" },
          });
        }

        if (clusterType === "distance" || clusterType === "semantic") {
          toolResultsContext = `\n=== RAW ${clusterType.toUpperCase()} CLUSTER RESULT ===\n${JSON.stringify(
            toolCluster,
            null,
            2
          )}\n`;
        } else {
          const members = (toolResult as any)?.members || [];
          const edges = (toolResult as any)?.connections || (toolResult as any)?.edges || [];
          const memberIds = new Set(extractIds(members));
          const filteredEdges = edges.filter((edge: any) => {
            const fromId = extractId(edge, ['from', 'from_id', 'source']);
            const toId = extractId(edge, ['to', 'to_id', 'target']);
            return fromId && toId && memberIds.has(fromId) && memberIds.has(toId);
          });
          toolResultsContext = `\n=== RELATIONAL CLUSTER ===\n${JSON.stringify(
            { ...toolCluster, connections: filteredEdges },
            null,
            2
          )}\n`;
        }
      }
    } catch (error) {
      onEvent?.(`Tool execution failed: ${(error as Error).message}`);
    }

    const finalContext = [clusterContext, toolResultsContext].filter(Boolean).join("\n\n");
    const instructions = [
      "You are an AI assistant for canvas/diagram analysis.",
      "- Use the provided cluster summaries and tool results to answer the user question.",
      "- Focus on structure, relationships, and content of the diagram.",
      "- If information is missing, state what additional context would help.",
      "",
      "USER QUESTION:",
      userMessage,
      "",
      "CLUSTER CONTEXT:",
      finalContext,
    ].join("\n");

    const response = await fetch(this.responsesEndpoint(), {
      method: "POST",
      headers: buildAuthHeadersFromReq(this.req, true),
      body: JSON.stringify({
        model: MAIN_MODEL,
        instructions,
        input: userMessage,
        stream: true,
        max_output_tokens: MAX_RESPONSE_TOKENS,
      }),
      signal,
    });

    if (!response.body) {
      onText?.("I was unable to generate a response.");
      return;
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder("utf-8");
    let buffer = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";
      for (const line of lines) {
        if (!line.startsWith("data:")) continue;
        const payload = line.slice(5).trim();
        if (payload === "[DONE]") return;
        try {
          const json = JSON.parse(payload);
          const text = json?.output_text || json?.choices?.[0]?.delta?.content || json?.delta || "";
          if (text) onText?.(text);
        } catch {
          if (payload) onText?.(payload);
        }
      }
    }
  }
}
