import express from "express";
import { once } from "node:events";
import { runtimeDependencies } from "../server.js";
import { mountCanvasRoutes } from "../routes/canvas.js";
import { mountClustersRoutes } from "../routes/clusters.js";
import { mountMcpRoutes } from "../routes/mcp.js";
import { BackendAIEngine } from "../../src/engine/AIEngine.ts";
import { debug, error } from "../lib/logger.js";

const collectHandlers = (mountFn, method, path, deps) => {
  const router = express.Router();
  mountFn(router, deps);
  const layer = router.stack.find(
    (item) => item.route && item.route.path === path && item.route.methods?.[method]
  );
  if (!layer) {
    throw new Error(`Route ${method.toUpperCase()} ${path} not found`);
  }
  return {
    method,
    path,
    handlers: layer.route.stack
      .filter((entry) => entry.method === method)
      .map((entry) => entry.handle),
  };
};

const collectRouteMap = (mountFn, deps) => {
  const router = express.Router();
  mountFn(router, deps);
  const map = new Map();
  for (const layer of router.stack) {
    if (!layer.route) continue;
    const methods = Object.entries(layer.route.methods || {}).filter(([, enabled]) => enabled);
    for (const [method] of methods) {
      map.set(
        `${method}:${layer.route.path}`,
        layer.route.stack.map((entry) => entry.handle)
      );
    }
  }
  return map;
};

const runHandlers = async (handlers, { path, method, body, headers, userId }) => {
  const lowerHeaders = {};
  for (const [key, value] of Object.entries(headers || {})) {
    lowerHeaders[key.toLowerCase()] = value;
  }
  if (userId && !lowerHeaders["x-user-id"]) {
    lowerHeaders["x-user-id"] = String(userId);
  }

  const req = {
    path,
    method: method.toUpperCase(),
    body,
    headers: lowerHeaders,
    user: { id: lowerHeaders["x-user-id"] || "anonymous" },
    auth: {},
    params: {},
    query: {},
    get(name) {
      return this.headers?.[String(name).toLowerCase()];
    },
  };

  return await new Promise((resolve, reject) => {
    let statusCode = 200;
    let resolved = false;
    const headersOut = {};

    const finalize = (payload) => {
      if (resolved) return;
      resolved = true;
      resolve({ status: statusCode, body: payload, headers: headersOut });
    };

    const res = {
      status(code) {
        statusCode = code;
        return this;
      },
      set(field, value) {
        headersOut[String(field).toLowerCase()] = value;
        return this;
      },
      setHeader(field, value) {
        headersOut[String(field).toLowerCase()] = value;
        return this;
      },
      getHeader(field) {
        return headersOut[String(field).toLowerCase()];
      },
      write() {
        return this;
      },
      end(payload) {
        finalize(payload);
      },
      json(payload) {
        finalize(payload);
      },
      send(payload) {
        finalize(payload);
      },
    };

    const next = (err) => {
      if (err) {
        if (resolved) return;
        resolved = true;
        reject(err);
        return;
      }
      callNext();
    };

    let index = 0;
    const callNext = () => {
      if (index >= handlers.length) {
        finalize(undefined);
        return;
      }
      const handler = handlers[index++];
      try {
        if (handler.length >= 3) {
          handler(req, res, next);
        } else {
          const maybePromise = handler(req, res);
          if (maybePromise && typeof maybePromise.then === "function") {
            maybePromise
              .then(() => {
                if (!resolved) callNext();
              })
              .catch((error) => {
                if (!resolved) reject(error);
              });
          } else if (!resolved) {
            callNext();
          }
        }
      } catch (error) {
        if (!resolved) reject(error);
      }
    };

    callNext();
  });
};

const normalizeError = (result, defaultMessage) => {
  if (result.status < 400) {
    return result.body;
  }
  const body = result.body;
  const message =
    body && typeof body === "object" && typeof body.error === "string"
      ? body.error
      : defaultMessage || `Request failed with status ${result.status}`;
  const error = new Error(message);
  error.status = result.status;
  if (body && typeof body === "object" && body.details !== undefined) {
    error.details = body.details;
  }
  throw error;
};

/**
 * Creates a Helix RAG SDK instance for canvas-based knowledge graph operations.
 *
 * @param {Object} [options={}] - Configuration options
 * @param {Function} [options.resolveUser] - Custom user resolution function from headers
 * @param {Object} [options.runtime] - Runtime dependencies override
 * @returns {Object} SDK instance with methods: syncCanvas, refreshClusters, callMcp, traverseCluster
 *
 * @example
 * const sdk = createHelixRagSDK();
 * await sdk.syncCanvas({ boardId: 'board-123', excalidrawData: {...} });
 * const clusters = await sdk.refreshClusters({ boardId: 'board-123' });
 */
export const createHelixRagSDK = (options = {}) => {
  const {
    requireAuth,
    ensureBoardEditor,
    ensureOwnsBoard,
    withBoardLock,
    crypto,
    callHelix,
    toElementsArray,
    dedupeByExternalIdLatest,
    consolidateLabelsIntoShapes,
    isConnector,
    clusterCache,
    textVecCache,
    boardCache,
    saveBoardToDisk,
    saveBoardToDiskMulti,
    hydrateBoardCacheFromDiskMulti,
    normalizeElement,
    getAllBoardElements,
    cosineSim,
    bboxOf,
    toFiniteNumber,
    toFiniteInt,
    reconcileHelixToCache,
    MAX_PAYLOAD_BYTES,
    MAX_ELEMENTS_PER_SYNC,
    HELIX_SAFE_MODE,
    BOARDS_DIRS,
    ensureDir,
    fsp,
    path: pathModule,
    withDistributedLock,
  } = options.runtime || runtimeDependencies;

  const userResolver =
    options.resolveUser ||
    ((headers = {}) => headers["x-user-id"] || headers["x-user"] || "anonymous");

  const baseDeps = {
    requireAuth: (req, _res, next) => {
      const resolved = userResolver(req.headers || {});
      req.user = { id: resolved || "anonymous" };
      next();
    },
    ensureBoardEditor,
    ensureOwnsBoard,
    withBoardLock,
    crypto,
    callHelix,
    toElementsArray,
    dedupeByExternalIdLatest,
    consolidateLabelsIntoShapes,
    isConnector,
    clusterCache,
    textVecCache,
    boardCache,
    saveBoardToDisk,
    saveBoardToDiskMulti,
    hydrateBoardCacheFromDiskMulti,
    normalizeElement,
    getAllBoardElements,
    bboxOf,
    cosineSim,
    toFiniteNumber,
    toFiniteInt,
    reconcileHelixToCache,
    MAX_PAYLOAD_BYTES,
    MAX_ELEMENTS_PER_SYNC,
    HELIX_SAFE_MODE,
    BOARDS_DIRS,
    ensureDir,
    fsp,
    path: pathModule,
    withDistributedLock,
  };

  const canvasRoute = collectHandlers(mountCanvasRoutes, "post", "/api/canvas/sync", baseDeps);
  const clusterRoute = collectHandlers(mountClustersRoutes, "post", "/api/clusters", baseDeps);
  const clusterTraverseRoute = collectHandlers(
    mountClustersRoutes,
    "post",
    "/api/clusters/traverse",
    baseDeps
  );
  const mcpRoutes = collectRouteMap(mountMcpRoutes, baseDeps);

  const invoke = async (route, payload, context = {}) => {
    const { handlers, path, method } = route;
    const result = await runHandlers(handlers, {
      path,
      method,
      body: payload,
      headers: context.headers,
      userId: context.userId,
    });
    return normalizeError(result, `Request to ${method.toUpperCase()} ${path} failed`);
  };

  const invokeMcp = async (resource, payload, context = {}) => {
    const key = `post:/api/mcp/${resource}`;
    if (!mcpRoutes.has(key)) {
      throw new Error(`Unknown MCP route: ${resource}`);
    }
    const handlers = mcpRoutes.get(key);
    const result = await runHandlers(handlers, {
      path: `/api/mcp/${resource}`,
      method: "post",
      body: payload,
      headers: context.headers,
      userId: context.userId,
    });
    return normalizeError(result, `MCP route ${resource} failed`);
  };

  return {
    deps: baseDeps,
    async syncCanvas(payload, context) {
      return await invoke(canvasRoute, payload, context);
    },
    async refreshClusters(payload, context) {
      return await invoke(clusterRoute, payload, context);
    },
    async callMcp(resource, payload, context) {
      return await invokeMcp(resource, payload, context);
    },
    async traverseCluster(payload, context) {
      return await invoke(clusterTraverseRoute, payload, context);
    },
  };
};

let activeServer;

/**
 * Starts the Helix SDK facade server for handling canvas sync and clustering requests.
 *
 * @param {Object} [options={}] - Server configuration options
 * @param {Object} [options.runtime] - Runtime dependencies override
 * @param {number} [options.port=0] - Port to listen on (0 for random available port)
 * @returns {Promise<Object>} Server info with { server, port, app }
 *
 * @example
 * const serverInfo = await startHelixFacadeServer({ port: 3001 });
 * debug(`Server running on port ${serverInfo.port}`);
 */
export const startHelixFacadeServer = async (options = {}) => {
  if (activeServer) return activeServer;

  const deps = { ...runtimeDependencies, ...(options.runtime || {}) };
  const sdk = createHelixRagSDK({ runtime: deps });
  const app = express();
  const jsonLimit =
    typeof deps.MAX_PAYLOAD_BYTES === "number" ? deps.MAX_PAYLOAD_BYTES : 10_000_000;
  app.use(express.json({ limit: jsonLimit }));
  const wrap = (fn) => async (req, res) => {
    try {
      const result = await fn(req.body, { headers: req.headers, userId: req.headers["x-user-id"] });
      res.json(result);
    } catch (error) {
      const status = (error && error.status) || 500;
      res.status(status).json({ error: error?.message || String(error), details: error?.details });
    }
  };

  app.post("/api/canvas/sync", wrap(sdk.syncCanvas));
  app.post("/api/clusters", wrap(sdk.refreshClusters));
  app.post("/api/clusters/traverse", wrap(sdk.traverseCluster));

  const normalizeTool = (tool) => {
    if (!tool) return "";
    if (tool.startsWith("mcp:")) return tool.slice(4);
    if (tool.startsWith("mcp_")) return tool.slice(4);
    return tool;
  };

  app.post("/api/mcp-bridge", async (req, res) => {
    try {
      const tool = String(req.body?.tool || req.body?.name || "");
      const resource = normalizeTool(tool);
      const args =
        req.body?.arguments && typeof req.body.arguments === "object" ? req.body.arguments : {};

      if (resource === "cluster_traverse") {
        const result = await sdk.traverseCluster(args, {
          headers: req.headers,
          userId: req.headers["x-user-id"],
        });
        return res.json(result);
      }

      const result = await sdk.callMcp(resource, args, {
        headers: req.headers,
        userId: req.headers["x-user-id"],
      });
      res.json(result);
    } catch (error) {
      const status = (error && error.status) || 500;
      res.status(status).json({ error: error?.message || String(error), details: error?.details });
    }
  });

  const port = options.port ?? 0;
  const server = app.listen(port);
  await once(server, "listening");
  const address = server.address();
  const resolvedPort = typeof address === "object" && address ? address.port : port;
  activeServer = { server, port: resolvedPort, app };
  return activeServer;
};

/**
 * Stops the currently running Helix SDK facade server.
 *
 * @returns {Promise<void>}
 */
export const stopHelixFacadeServer = async () => {
  if (!activeServer) return;
  await new Promise((resolve, reject) => {
    activeServer.server.close((err) => {
      if (err) reject(err);
      else resolve();
    });
  });
  activeServer = undefined;
};

let backendServerProcess;

/**
 * Starts the backend pipeline server for AI-powered canvas analysis.
 *
 * @param {string} helixRagUrl - URL of the Helix RAG server to connect to
 * @returns {Promise<Object>} Server info with { port }
 * @private
 */
export const startPipelineBackend = async (helixRagUrl) => {
  if (backendServerProcess) return backendServerProcess;

  const { spawn } = await import("child_process");
  const { fileURLToPath } = await import("url");
  const { dirname, join } = await import("path");

  const __dirname = dirname(fileURLToPath(import.meta.url));
  const backendPath = join(__dirname, "../../src/index.js");

  return new Promise((resolve, reject) => {
    const proc = spawn("node", [backendPath], {
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, PORT: "8787", HELIX_RAG_URL: helixRagUrl },
    });

    // Track process immediately so cleanup works even if startup fails
    backendServerProcess = proc;
    let started = false;

    proc.stdout.on("data", (data) => {
      const output = data.toString();
      debug("[Backend]:", output.trim());
      if (output.includes("listening on") && !started) {
        started = true;
        resolve({ port: 8787 });
      }
    });

    proc.stderr.on("data", (data) => {
      error("[Backend Error]:", data.toString());
    });

    proc.on("error", (err) => {
      if (!started) {
        backendServerProcess = undefined;
        reject(err);
      }
    });

    proc.on("exit", (code) => {
      backendServerProcess = undefined;
      if (!started) {
        reject(new Error(`Backend exited with code ${code}`));
      }
    });

    setTimeout(() => {
      if (!started) {
        proc.kill("SIGKILL");
        backendServerProcess = undefined;
        reject(new Error("Backend server timeout"));
      }
    }, 10000);
  });
};

/**
 * Stops the currently running backend pipeline server.
 *
 * @returns {Promise<void>}
 * @private
 */
export const stopPipelineBackend = async () => {
  if (!backendServerProcess) return;
  try {
    backendServerProcess.kill("SIGTERM");
    await new Promise((resolve) => setTimeout(resolve, 100));
    if (!backendServerProcess.killed) {
      backendServerProcess.kill("SIGKILL");
    }
  } catch (err) {
    // Process might already be dead
  }
  backendServerProcess = undefined;
};

const buildSnapshot = (elements = []) => ({
  type: "excalidraw",
  version: 2,
  source: "executeFullPipeline",
  elements,
});

/**
 * Executes the full RAG pipeline: syncs canvas data, generates clusters, and runs AI analysis.
 *
 * @param {Object} params - Pipeline parameters
 * @param {string} params.boardId - Unique board identifier
 * @param {string} params.userMessage - User's query about the canvas
 * @param {Array} [params.history=[]] - Chat history for context
 * @param {Array} [params.elements] - Canvas elements to sync
 * @param {Function} [params.callHelix] - Custom Helix API caller
 * @param {Object} [params.runtime] - Runtime dependencies override
 * @param {string} [params.userId] - User identifier
 * @param {Object} [params.headers={}] - Additional HTTP headers
 * @returns {Promise<Object>} Result with { text, port, baseUrl }
 *
 * @example
 * const result = await executeFullPipeline({
 *   boardId: 'board-123',
 *   userMessage: 'Explain this diagram',
 *   elements: canvasElements,
 *   userId: 'user-456'
 * });
 * debug(result.text);
 */
export const executeFullPipeline = async ({
  boardId,
  userMessage,
  history = [],
  elements,
  callHelix,
  runtime: runtimeOverrides,
  userId,
  headers = {},
}) => {
  if (!boardId) throw new Error("boardId is required");
  if (!(userMessage && userMessage.trim())) throw new Error("userMessage is required");

  const runtime = { ...runtimeDependencies, ...(runtimeOverrides || {}) };
  if (callHelix) runtime.callHelix = callHelix;

  // Start SDK server first
  const serverInfo = await startHelixFacadeServer({ runtime });
  const baseUrl = `http://127.0.0.1:${serverInfo.port}`;

  // Now start backend server with HELIX_RAG_URL pointing to SDK server
  await startPipelineBackend(baseUrl);

  const lowerCaseHeaders = Object.fromEntries(
    Object.entries(headers || {}).map(([key, value]) => [String(key).toLowerCase(), value])
  );
  if (userId) {
    lowerCaseHeaders["x-user-id"] = String(userId);
  } else if (!lowerCaseHeaders["x-user-id"]) {
    lowerCaseHeaders["x-user-id"] = "anonymous";
  }

  try {
    if (Array.isArray(elements) && elements.length > 0) {
      await fetch(`${baseUrl}/api/canvas/sync`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...lowerCaseHeaders,
        },
        body: JSON.stringify({ boardId, excalidrawData: buildSnapshot(elements) }),
      });
    }

    const backendUrl =
      process.env.AI_BACKEND_PUBLIC_BASE ||
      process.env.AI_BACKEND_URL ||
      process.env.TREYSPACE_BACKEND_URL ||
      process.env.VITE_AI_BACKEND_URL ||
      process.env.VITE_TREYSPACE_BACKEND_URL ||
      "http://localhost:8787";

    const backendHost = backendUrl.replace(/^https?:\/\//, "").replace(/\/.*$/, "");
    const backendProtocol = backendUrl.startsWith("https") ? "https" : "http";

    const req = {
      protocol: backendProtocol,
      headers: {
        host: backendHost,
        ...lowerCaseHeaders,
      },
      get(name) {
        return this.headers[String(name).toLowerCase()];
      },
    };

    const engine = new BackendAIEngine(req, { boardId });
    let text = "";

    await engine.pipeline({
      userMessage,
      history,
      onText: (chunk) => {
        if (typeof chunk === "string") text += chunk;
      },
    });

    return {
      text: text.trim(),
      port: serverInfo.port,
      baseUrl,
    };
  } finally {
    await stopHelixFacadeServer();
    await stopPipelineBackend();
  }
};
