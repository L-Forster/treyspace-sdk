/**
 * MCP Traversal Manager
 *
 * Manages Model Context Protocol (MCP) connections and tool execution.
 * Handles session initialization, connection pooling, and tool routing
 * to the SDK façade's MCP endpoints.
 *
 * MCP tools allow querying the Helix graph database for cluster details,
 * element traversal, and graph operations.
 */

import { buildAuthHeadersFromReq, getProxyBaseFromReq, type RequestLike } from "./util.js";

interface ConnectionEntry {
  id: string;
  created: number;
  status: "active" | "completed";
}

/**
 * Backend MCP Traversal Manager
 *
 * Manages MCP sessions for graph database queries.
 * Maintains connection pool and routes tool calls to SDK façade.
 */
export class BackendMCPTraversalManager {
  private readonly req: RequestLike;
  private readonly onEvent?: (status: string) => void;
  private readonly signal?: AbortSignal;
  private readonly proxyBase: string;
  private readonly connections = new Map<string, ConnectionEntry>();

  constructor(req: RequestLike, onEvent?: (status: string) => void, signal?: AbortSignal) {
    this.req = req;
    this.onEvent = onEvent;
    this.signal = signal;
    this.proxyBase = getProxyBaseFromReq(req);
  }

  /**
   * Calls an MCP tool via the /api/mcp-bridge endpoint
   *
   * @param tool - Tool name (e.g., "mcp:init", "mcp:cluster_traverse")
   * @param args - Tool arguments
   * @returns Tool execution result
   *
   * Proxies to SDK façade's MCP implementation.
   */
  private async callMCPBridge(tool: string, args: Record<string, unknown>) {
    const requestBody = { tool, arguments: args };
    const headers = buildAuthHeadersFromReq(this.req, true);
    const resp = await fetch(`${this.proxyBase}/api/mcp-bridge`, {
      method: "POST",
      headers,
      body: JSON.stringify(requestBody),
      signal: this.signal,
    });
    if (!resp.ok) {
      const text = await resp.text().catch(() => "");
      throw new Error(`Tool error: ${resp.status} - ${text}`);
    }
    return (await resp.json()) as any;
  }

  /**
   * Executes an MCP tool with automatic connection management
   *
   * @param toolName - Tool name (with or without mcp_ prefix)
   * @param args - Tool arguments
   * @returns Tool execution result
   *
   * Automatically initializes MCP connection if needed.
   * Injects connection_id into tool arguments.
   */
  async executeTool(toolName: string, args: any) {
    const bridgeToolName = toolName.startsWith("mcp_")
      ? toolName.replace("mcp_", "mcp:")
      : toolName;
    const toolArgs = typeof args === "string" ? JSON.parse(args || "{}") : args;

    if (!toolArgs.connection_id && bridgeToolName !== "mcp:init") {
      let activeConnectionId = Array.from(this.connections.values()).find(
        (c) => c.status === "active"
      )?.id;
      if (!activeConnectionId) {
        try {
          const initResponse = await this.callMCPBridge("mcp:init", {});
          activeConnectionId = initResponse?.result?.connection_id || initResponse?.result;
          if (activeConnectionId) {
            this.connections.set(activeConnectionId, {
              id: activeConnectionId,
              created: Date.now(),
              status: "active",
            });
          }
        } catch (error) {
          this.onEvent?.(`MCP init failed: ${(error as Error).message}`);
        }
      }
      if (activeConnectionId) {
        toolArgs.connection_id = activeConnectionId;
      }
    }

    if (bridgeToolName === "mcp:init") {
      const response = await this.callMCPBridge(bridgeToolName, {});
      const connectionId = response?.result?.connection_id || response?.result;
      if (connectionId) {
        this.connections.set(connectionId, {
          id: connectionId,
          created: Date.now(),
          status: "active",
        });
      }
      return response;
    }

    return this.callMCPBridge(bridgeToolName, toolArgs);
  }

  /**
   * Cleans up active MCP connections
   *
   * @returns {Promise<void>}
   *
   * Calls mcp:reset for all active connections.
   * Should be called when pipeline completes or errors.
   */
  async cleanup() {
    const headers = buildAuthHeadersFromReq(this.req, true);
    for (const conn of this.connections.values()) {
      if (conn.status === "active") {
        try {
          await fetch(`${this.proxyBase}/api/mcp-bridge`, {
            method: "POST",
            headers,
            body: JSON.stringify({
              tool: "mcp:reset",
              arguments: { connection_id: conn.id },
            }),
          });
          conn.status = "completed";
        } catch (error) {
          this.onEvent?.(`Failed to reset MCP session ${conn.id}: ${(error as Error).message}`);
        }
      }
    }
  }
}
