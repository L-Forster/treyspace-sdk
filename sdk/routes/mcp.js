// MCP routes extracted; keep behaviour by passing required helpers via deps

import { SPATIAL_CONSTANTS } from "../lib/helpers.js";

export function mountMcpRoutes(app, deps) {
  const {
    requireAuth,
    crypto,
    callHelix,
    toElementsArray,
    dedupeByExternalIdLatest,
    withDistributedLock,
  } = deps;

  const mcpSessions = new Map();
  const newConnectionId = () =>
    `mcp_${crypto.randomUUID?.() || Math.random().toString(36).slice(2)}`;
  const getSession = (connectionId) => mcpSessions.get(connectionId);

  const ensureSession = (req, res, connectionId) => {
    const s = getSession(connectionId);
    if (!s) {
      res.status(404).json({ error: "Invalid connection_id" });
      return null;
    }
    if (s.userId !== req.user?.id) {
      res.status(403).json({ error: "Forbidden" });
      return null;
    }
    return s;
  };

  // Lightweight helpers for element/edge operations
  const normalizeElement = (el) => {
    if (!el || typeof el !== "object") return null;
    const kindLower = String(el.kind || el.type || "").toLowerCase();
    const isConn = kindLower === "arrow" || kindLower === "line";
    return {
      externalId: String(el.externalId || el.id || ""),
      boardId: String(el.boardId || ""),
      kind: String(el.kind || el.type || ""),
      x: Number(el.x || 0),
      y: Number(el.y || 0),
      w: Number(el.w ?? el.width ?? 0),
      h: Number(el.h ?? el.height ?? 0),
      angle: Number(el.angle || 0),
      strokeColor: String(el.strokeColor || ""),
      backgroundColor: String(el.backgroundColor || ""),
      strokeWidth: Number(el.strokeWidth || 1),
      fillStyle: String(el.fillStyle || "solid"),
      roughness: Number(el.roughness || 0),
      opacity: Number(el.opacity || 100),
      text: String(el.text || ""),
      link: String(el.link || ""),
      locked: Boolean(el.locked),
      version: Number(el.version || 1),
      updated: Number(el.updated || 0),
      index: Number(el.index ?? el.idx ?? 0),
      startBindingId: isConn
        ? String(el.startBindingId || (el.startBinding && el.startBinding.elementId) || "")
        : String(el.startBindingId || ""),
      endBindingId: isConn
        ? String(el.endBindingId || (el.endBinding && el.endBinding.elementId) || "")
        : String(el.endBindingId || ""),
      frameId: el.frameId ? String(el.frameId) : "",
      containerId: el.containerId ? String(el.containerId) : "",
    };
  };

  const isConnectorKind = (el) => {
    const k = String(el?.kind || el?.type || "").toLowerCase();
    return k === "arrow" || k === "line";
  };

  const centerOf = (e) => ({
    x: Number(e.x || 0) + Number(e.w || 0) / 2,
    y: Number(e.y || 0) + Number(e.h || 0) / 2,
  });

  const loadBoardElements = async (boardId) => {
    const raw = await callHelix("getBoardElements", { boardExtId: String(boardId) });
    const arr = dedupeByExternalIdLatest(toElementsArray(raw));
    return arr.map(normalizeElement).filter(Boolean);
  };

  const listEdgesForBoard = async (boardId) => {
    const elements = await loadBoardElements(boardId);
    if (!elements.length) return [];
    const edges = [];
    const items = [...elements].sort((a, b) => a.index - b.index);
    for (let i = 0; i < items.length; i++) {
      for (let j = i + 1; j < items.length; j++) {
        const a = items[i];
        const b = items[j];
        const ac = centerOf(a);
        const bc = centerOf(b);
        const dx = bc.x - ac.x;
        const dy = bc.y - ac.y;
        const dist = Math.sqrt(dx * dx + dy * dy);
        if (dist < SPATIAL_CONSTANTS.NEAR_DISTANCE) {
          edges.push({ type: "NEAR", from: a.externalId, to: b.externalId, distance: dist });
        }
        const overlapX = Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x));
        const overlapY = Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y));
        const isAlignedH = overlapY > 0;
        const isAlignedV = overlapX > 0;
        if (isAlignedH) {
          const gap = b.x - (a.x + a.w);
          if (gap > 0 && gap < SPATIAL_CONSTANTS.DIRECTIONAL_GAP)
            edges.push({
              type: "DIRECTIONAL",
              from: a.externalId,
              to: b.externalId,
              dir: "E",
              gap,
              overlap: overlapY,
            });
          const gapL = a.x - (b.x + b.w);
          if (gapL > 0 && gapL < SPATIAL_CONSTANTS.DIRECTIONAL_GAP)
            edges.push({
              type: "DIRECTIONAL",
              from: b.externalId,
              to: a.externalId,
              dir: "E",
              gap: gapL,
              overlap: overlapY,
            });
        }
        if (isAlignedV) {
          const gap = b.y - (a.y + a.h);
          if (gap > 0 && gap < SPATIAL_CONSTANTS.DIRECTIONAL_GAP)
            edges.push({
              type: "DIRECTIONAL",
              from: a.externalId,
              to: b.externalId,
              dir: "S",
              gap,
              overlap: overlapX,
            });
          const gapT = a.y - (b.y + b.h);
          if (gapT > 0 && gapT < SPATIAL_CONSTANTS.DIRECTIONAL_GAP)
            edges.push({
              type: "DIRECTIONAL",
              from: b.externalId,
              to: a.externalId,
              dir: "S",
              gap: gapT,
              overlap: overlapX,
            });
        }
      }
    }
    for (const el of elements) {
      if (isConnectorKind(el) && el.startBindingId && el.endBindingId)
        edges.push({
          type: "FLOWS_TO",
          from: el.startBindingId,
          to: el.endBindingId,
          via: el.externalId,
        });
      if (el.startBindingId)
        edges.push({
          type: "BINDS_TO",
          from: el.externalId,
          to: el.startBindingId,
          kind: "arrow_start",
        });
      if (el.endBindingId)
        edges.push({
          type: "BINDS_TO",
          from: el.externalId,
          to: el.endBindingId,
          kind: "arrow_end",
        });
      if (el.containerId) {
        if (String(el.kind || "").toLowerCase() === "text")
          edges.push({ type: "TEXT_OF", from: el.externalId, to: el.containerId });
        else edges.push({ type: "CONTAINS", from: el.containerId, to: el.externalId });
      }
    }
    return edges;
  };

  app.post("/api/mcp/init", requireAuth, async (req, res) => {
    try {
      const userId = req.user?.id;
      const id = newConnectionId();
      mcpSessions.set(id, { userId, items: [], itemType: "node", cursor: 0, history: [] });
      res.json({ connection_id: id });
    } catch (e) {
      res.status(500).json({ error: e.message || "Failed to init MCP" });
    }
  });

  app.post("/api/mcp/reset", requireAuth, async (req, res) => {
    const { connection_id } = req.body || {};
    if (!connection_id) return res.status(400).json({ error: "Missing connection_id" });
    mcpSessions.delete(connection_id);
    res.json({ ok: true });
  });

  app.post("/api/mcp/schema_resource", requireAuth, async (_req, res) => {
    try {
      const schema = {
        nodes: [
          {
            name: "Element",
            properties: {
              externalId: "String",
              boardId: "String",
              kind: "String",
              x: "F64",
              y: "F64",
              w: "F64",
              h: "F64",
              text: "String",
            },
          },
          { name: "Board", properties: { externalId: "String", name: "String" } },
        ],
        edges: [
          { name: "FLOWS_TO" },
          { name: "NEAR" },
          { name: "DIRECTIONAL" },
          { name: "BINDS_TO" },
          { name: "CONTAINS" },
          { name: "TEXT_OF" },
        ],
      };
      const mcp_tools = [
        { name: "mcp:init", method: "POST", path: "/api/mcp/init" },
        { name: "mcp:reset", method: "POST", path: "/api/mcp/reset" },
        { name: "mcp:schema_resource", method: "POST", path: "/api/mcp/schema_resource" },
        { name: "mcp:exec_query", method: "POST", path: "/api/mcp/exec_query" },
        { name: "mcp:filter_items", method: "POST", path: "/api/mcp/filter_items" },
        { name: "mcp:search_vector", method: "POST", path: "/api/mcp/search_vector" },
        { name: "mcp:collect", method: "POST", path: "/api/mcp/collect" },
        { name: "mcp:n_from_type", method: "POST", path: "/api/mcp/n_from_type" },
        { name: "mcp:e_from_type", method: "POST", path: "/api/mcp/e_from_type" },
        { name: "mcp:out_step", method: "POST", path: "/api/mcp/out_step" },
        { name: "mcp:in_step", method: "POST", path: "/api/mcp/in_step" },
        { name: "mcp:out_e_step", method: "POST", path: "/api/mcp/out_e_step" },
        { name: "mcp:in_e_step", method: "POST", path: "/api/mcp/in_e_step" },
        { name: "mcp:next", method: "POST", path: "/api/mcp/next" },
        { name: "mcp:multi_hop_traversal", method: "POST", path: "/api/mcp/multi_hop_traversal" },
        { name: "mcp:flow_paths", method: "POST", path: "/api/mcp/flow_paths" },
        { name: "mcp:collect_subgraph", method: "POST", path: "/api/mcp/collect_subgraph" },
        { name: "mcp:region_subgraph", method: "POST", path: "/api/mcp/region_subgraph" },
        {
          name: "mcp:semantic_layout_search",
          method: "POST",
          path: "/api/mcp/semantic_layout_search",
        },
        { name: "mcp:explain_selection", method: "POST", path: "/api/mcp/explain_selection" },
        { name: "mcp:graph_overview", method: "POST", path: "/api/mcp/graph_overview" },
        { name: "mcp:get_element_context", method: "POST", path: "/api/mcp/get_element_context" },
        {
          name: "mcp:analyze_canvas_structure",
          method: "POST",
          path: "/api/mcp/analyze_canvas_structure",
        },
        { name: "mcp:flow_extract", method: "POST", path: "/api/mcp/flow_extract" },
        { name: "mcp:pattern_detect", method: "POST", path: "/api/mcp/pattern_detect" },
        { name: "mcp:canvas_understanding", method: "POST", path: "/api/mcp/canvas_understanding" },
        { name: "mcp:create-element", method: "POST", path: "/api/mcp/create-element" },
        { name: "mcp:connect-elements", method: "POST", path: "/api/mcp/connect-elements" },
      ];
      res.json({ schema, mcp_tools });
    } catch (e) {
      res.status(500).json({ error: e.message || "schema_resource failed" });
    }
  });

  app.post("/api/mcp/exec_query", requireAuth, async (req, res) => {
    try {
      const { name, params } = req.body || {};
      if (!name || typeof name !== "string") return res.status(400).json({ error: "Missing name" });
      const result = await callHelix(name, params || {});
      res.json(result);
    } catch (e) {
      res.status(500).json({ error: e.message || "Query failed" });
    }
  });

  app.post("/api/mcp/filter_items", requireAuth, async (req, res) => {
    try {
      const { connection_id } = req.body || {};
      const s = ensureSession(req, res, connection_id);
      if (!s) return;
      res.json({ ok: true, items: s.items || [] });
    } catch (e) {
      res.status(500).json({ error: e.message || "Filter failed" });
    }
  });

  app.post("/api/mcp/search_vector", requireAuth, async (req, res) => {
    try {
      const { connection_id, data } = req.body || {};
      const s = ensureSession(req, res, connection_id);
      if (!s) return;
      const qVec = Array.isArray(data?.vector) ? data.vector.map((v) => Number(v)) : null;
      const k = Math.max(1, Math.min(50, Number(data?.k || 10)));
      const minScore = Number(data?.min_score || -1);
      if (!Array.isArray(qVec) || !qVec.length)
        return res.status(400).json({ error: "Missing vector" });
      let results = [];
      if (Array.isArray(s.items)) {
        for (const it of s.items) {
          if (Array.isArray(it?.vector)) {
            const dot = it.vector.reduce((acc, v, i) => acc + v * (qVec[i] || 0), 0);
            const na = Math.sqrt(it.vector.reduce((a, v) => a + v * v, 0)) || 1;
            const nb = Math.sqrt(qVec.reduce((a, v) => a + v * v, 0)) || 1;
            const score = dot / (na * nb);
            results.push({ ...it, score });
          }
        }
      }
      results = results
        .filter((r) => typeof r.score !== "number" || r.score >= minScore)
        .sort((a, b) => Number(b.score || 0) - Number(a.score || 0))
        .slice(0, k);
      res.json({ ok: true, results, count: results.length });
    } catch (e) {
      res.status(500).json({ error: e.message || "Search failed" });
    }
  });

  app.post("/api/mcp/collect", requireAuth, async (req, res) => {
    try {
      const { connection_id, range } = req.body || {};
      const s = ensureSession(req, res, connection_id);
      if (!s) return;
      const start = Math.max(0, Number(range?.start || 0));
      const end = Number(range?.end || -1);
      const arr = Array.isArray(s.items) ? s.items : [];
      const slice = end >= 0 ? arr.slice(start, Math.min(end, arr.length)) : arr.slice(start);
      res.json(slice);
    } catch (e) {
      res.status(500).json({ error: "collect failed" });
    }
  });

  // Load nodes of a specific type (or all)
  app.post("/api/mcp/n_from_type", requireAuth, async (req, res) => {
    try {
      const { connection_id, data } = req.body || {};
      const s = ensureSession(req, res, connection_id);
      if (!s) return;
      const boardId = String(data?.boardId || s.boardId || "");
      if (!boardId) return res.status(400).json({ error: "Missing boardId" });
      s.boardId = boardId;
      const nodeType = String(data?.node_type || "all").toLowerCase();
      const elements = await loadBoardElements(boardId);
      const items = elements.filter((e) => {
        if (nodeType === "all" || nodeType === "element") return true;
        return String(e.kind || "").toLowerCase() === nodeType;
      });
      s.items = items;
      s.itemType = "node";
      s.cursor = 0;
      res.json({ ok: true, node_type: nodeType, count: items.length });
    } catch (e) {
      res.status(500).json({ error: e.message || "n_from_type failed" });
    }
  });

  // Load edges of a specific type
  app.post("/api/mcp/e_from_type", requireAuth, async (req, res) => {
    try {
      const { connection_id, data } = req.body || {};
      const s = ensureSession(req, res, connection_id);
      if (!s) return;
      const boardId = String(data?.boardId || s.boardId || "");
      if (!boardId) return res.status(400).json({ error: "Missing boardId" });
      s.boardId = boardId;
      const edgeType = String(data?.edge_type || "").toUpperCase();
      let edges = await listEdgesForBoard(boardId);
      if (edgeType) edges = edges.filter((e) => String(e.type || "").toUpperCase() === edgeType);
      s.items = edges;
      s.itemType = "edge";
      s.cursor = 0;
      res.json({ ok: true, count: edges.length });
    } catch (e) {
      res.status(500).json({ error: e.message || "e_from_type failed" });
    }
  });

  const stepNeighbors = async (boardId, ids, dir, edgeLabel) => {
    const edges = await listEdgesForBoard(boardId);
    const label = String(edgeLabel || "").toUpperCase();
    const byFrom = new Map();
    const byTo = new Map();
    for (const e of edges) {
      const t = String(e.type || "").toUpperCase();
      if (label && t !== label) continue;
      if (!byFrom.has(e.from)) byFrom.set(e.from, []);
      if (!byTo.has(e.to)) byTo.set(e.to, []);
      byFrom.get(e.from).push(e);
      byTo.get(e.to).push(e);
    }
    const out = new Set();
    if (dir === "out") {
      for (const id of ids) {
        const arr = byFrom.get(String(id)) || [];
        for (const e of arr) out.add(e.to);
      }
    } else {
      for (const id of ids) {
        const arr = byTo.get(String(id)) || [];
        for (const e of arr) out.add(e.from);
      }
    }
    const elements = await loadBoardElements(boardId);
    const byId = new Map(elements.map((e) => [e.externalId, e]));
    return Array.from(out)
      .map((id) => byId.get(String(id)))
      .filter(Boolean);
  };

  app.post("/api/mcp/out_step", requireAuth, async (req, res) => {
    try {
      const { connection_id, data } = req.body || {};
      const s = ensureSession(req, res, connection_id);
      if (!s) return;
      const boardId = String(data?.boardId || s.boardId || "");
      if (!boardId) return res.status(400).json({ error: "Missing boardId" });
      s.boardId = boardId;
      const ids = (s.items || [])
        .map((x) => x?.externalId)
        .filter(Boolean)
        .slice(0, 200);
      const items = await stepNeighbors(boardId, ids, "out", data?.edge_label);
      s.items = items;
      s.itemType = "node";
      s.cursor = 0;
      res.json({ ok: true, count: items.length });
    } catch (e) {
      res.status(500).json({ error: e.message || "out_step failed" });
    }
  });

  app.post("/api/mcp/in_step", requireAuth, async (req, res) => {
    try {
      const { connection_id, data } = req.body || {};
      const s = ensureSession(req, res, connection_id);
      if (!s) return;
      const boardId = String(data?.boardId || s.boardId || "");
      if (!boardId) return res.status(400).json({ error: "Missing boardId" });
      s.boardId = boardId;
      const ids = (s.items || [])
        .map((x) => x?.externalId)
        .filter(Boolean)
        .slice(0, 200);
      const items = await stepNeighbors(boardId, ids, "in", data?.edge_label);
      s.items = items;
      s.itemType = "node";
      s.cursor = 0;
      res.json({ ok: true, count: items.length });
    } catch (e) {
      res.status(500).json({ error: e.message || "in_step failed" });
    }
  });

  app.post("/api/mcp/out_e_step", requireAuth, async (req, res) => {
    try {
      const { connection_id } = req.body || {};
      const s = ensureSession(req, res, connection_id);
      if (!s) return;
      if (s.itemType !== "edge")
        return res.status(400).json({ error: "Current items are not edges" });
      const boardId = String(s.boardId || "");
      const elements = boardId ? await loadBoardElements(boardId) : [];
      const byId = new Map(elements.map((e) => [e.externalId, e]));
      const items = (s.items || []).map((e) => byId.get(String(e.to))).filter(Boolean);
      s.items = items;
      s.itemType = "node";
      s.cursor = 0;
      res.json({ ok: true, count: items.length });
    } catch (e) {
      res.status(500).json({ error: e.message || "out_e_step failed" });
    }
  });

  app.post("/api/mcp/in_e_step", requireAuth, async (req, res) => {
    try {
      const { connection_id } = req.body || {};
      const s = ensureSession(req, res, connection_id);
      if (!s) return;
      if (s.itemType !== "edge")
        return res.status(400).json({ error: "Current items are not edges" });
      const boardId = String(s.boardId || "");
      const elements = boardId ? await loadBoardElements(boardId) : [];
      const byId = new Map(elements.map((e) => [e.externalId, e]));
      const items = (s.items || []).map((e) => byId.get(String(e.from))).filter(Boolean);
      s.items = items;
      s.itemType = "node";
      s.cursor = 0;
      res.json({ ok: true, count: items.length });
    } catch (e) {
      res.status(500).json({ error: e.message || "in_e_step failed" });
    }
  });

  app.post("/api/mcp/next", requireAuth, async (req, res) => {
    try {
      const { connection_id } = req.body || {};
      const s = ensureSession(req, res, connection_id);
      if (!s) return;
      const arr = Array.isArray(s.items) ? s.items : [];
      if (s.cursor >= arr.length) return res.json({ item: null });
      const item = arr[s.cursor++];
      res.json({ item });
    } catch (e) {
      res.status(500).json({ error: e.message || "next failed" });
    }
  });

  app.post("/api/mcp/multi_hop_traversal", requireAuth, async (req, res) => {
    try {
      const { connection_id, data } = req.body || {};
      const s = ensureSession(req, res, connection_id);
      if (!s) return;
      const boardId = String(data?.boardId || s.boardId || "");
      if (!boardId) return res.status(400).json({ error: "Missing boardId" });
      s.boardId = boardId;
      const startIds = Array.isArray(data?.start_ids) ? data.start_ids.map(String) : [];
      const edgeTypes = Array.isArray(data?.edge_types)
        ? data.edge_types.map((t) => String(t).toUpperCase())
        : [];
      const maxHops = Math.max(1, Math.min(6, Number(data?.max_hops || 3)));
      const edges = await listEdgesForBoard(boardId);
      const typed = edgeTypes.length
        ? edges.filter((e) => edgeTypes.includes(String(e.type || "").toUpperCase()))
        : edges;
      const byFrom = new Map();
      for (const e of typed) {
        if (!byFrom.has(e.from)) byFrom.set(e.from, []);
        byFrom.get(e.from).push(e);
      }
      const visited = new Set(startIds);
      const q = startIds.map((id) => ({ id, d: 0 }));
      const travEdges = [];
      while (q.length) {
        const { id, d } = q.shift();
        if (d >= maxHops) continue;
        const arr = byFrom.get(String(id)) || [];
        for (const e of arr) {
          travEdges.push(e);
          if (!visited.has(e.to)) {
            visited.add(e.to);
            q.push({ id: e.to, d: d + 1 });
          }
        }
      }
      res.json({ ok: true, traversal: { nodes: Array.from(visited), edges: travEdges } });
    } catch (e) {
      res.status(500).json({ error: e.message || "multi_hop_traversal failed" });
    }
  });

  app.post("/api/mcp/flow_paths", requireAuth, async (req, res) => {
    try {
      const { connection_id, data } = req.body || {};
      const s = ensureSession(req, res, connection_id);
      if (!s) return;
      const boardId = String(data?.boardId || s.boardId || "");
      if (!boardId) return res.status(400).json({ error: "Missing boardId" });
      s.boardId = boardId;
      const seeds = Array.isArray(data?.seeds) ? data.seeds.map(String) : [];
      const maxDepth = Math.max(1, Math.min(10, Number(data?.max_depth || 6)));
      const edges = (await listEdgesForBoard(boardId)).filter(
        (e) => String(e.type || "").toUpperCase() === "FLOWS_TO"
      );
      const byFrom = new Map();
      for (const e of edges) {
        if (!byFrom.has(e.from)) byFrom.set(e.from, []);
        byFrom.get(e.from).push(e);
      }
      const paths = [];
      const dfs = (node, depth, path) => {
        if (depth > maxDepth) {
          paths.push([...path]);
          return;
        }
        const arr = byFrom.get(String(node)) || [];
        if (!arr.length) {
          paths.push([...path]);
          return;
        }
        for (const e of arr) {
          path.push(e.to);
          dfs(e.to, depth + 1, path);
          path.pop();
        }
      };
      for (const sId of seeds) dfs(sId, 0, [sId]);
      res.json({ ok: true, paths });
    } catch (e) {
      res.status(500).json({ error: e.message || "flow_paths failed" });
    }
  });

  app.post("/api/mcp/quick/selection_neighborhood", requireAuth, async (req, res) => {
    try {
      const { connection_id, data } = req.body || {};
      const s = ensureSession(req, res, connection_id);
      if (!s) return;
      const boardId = String(data?.boardId || s.boardId || "");
      if (!boardId) return res.status(400).json({ error: "Missing boardId" });
      s.boardId = boardId;
      const selected = Array.isArray(data?.selected) ? data.selected.map(String) : [];
      const labels = Array.isArray(data?.edge_labels)
        ? data.edge_labels.map((t) => String(t).toUpperCase())
        : [];
      const neighbors = await stepNeighbors(boardId, selected, "out", labels[0] || "");
      s.items = neighbors;
      s.itemType = "node";
      s.cursor = 0;
      res.json({ ok: true, count: neighbors.length });
    } catch (e) {
      res.status(500).json({ error: e.message || "selection_neighborhood failed" });
    }
  });

  app.post("/api/mcp/collect_subgraph", requireAuth, async (req, res) => {
    try {
      const { connection_id, data } = req.body || {};
      const s = ensureSession(req, res, connection_id);
      if (!s) return;
      const boardId = String(data?.boardId || s.boardId || "");
      if (!boardId) return res.status(400).json({ error: "Missing boardId" });
      s.boardId = boardId;
      const seeds = Array.isArray(data?.seeds) ? data.seeds.map(String) : [];
      const labels = Array.isArray(data?.edge_labels)
        ? data.edge_labels.map((t) => String(t).toUpperCase())
        : [];
      const maxDepth = Math.max(1, Math.min(6, Number(data?.max_depth || 3)));
      const edges = await listEdgesForBoard(boardId);
      const typed = labels.length
        ? edges.filter((e) => labels.includes(String(e.type || "").toUpperCase()))
        : edges;
      const byFrom = new Map();
      for (const e of typed) {
        if (!byFrom.has(e.from)) byFrom.set(e.from, []);
        byFrom.get(e.from).push(e);
      }
      const nodesSet = new Set(seeds);
      const edgeSet = [];
      const q = seeds.map((id) => ({ id, d: 0 }));
      while (q.length) {
        const { id, d } = q.shift();
        if (d >= maxDepth) continue;
        const arr = byFrom.get(String(id)) || [];
        for (const e of arr) {
          edgeSet.push(e);
          if (!nodesSet.has(e.to)) {
            nodesSet.add(e.to);
            q.push({ id: e.to, d: d + 1 });
          }
        }
      }
      res.json({ subgraph: { nodes: Array.from(nodesSet), edges: edgeSet } });
    } catch (e) {
      res.status(500).json({ error: e.message || "collect_subgraph failed" });
    }
  });

  app.post("/api/mcp/region_subgraph", requireAuth, async (req, res) => {
    try {
      const { connection_id, data } = req.body || {};
      const s = ensureSession(req, res, connection_id);
      if (!s) return;
      const boardId = String(data?.boardId || s.boardId || "");
      if (!boardId) return res.status(400).json({ error: "Missing boardId" });
      s.boardId = boardId;
      const bbox = data?.bbox || {};
      const minX = Number(bbox.minX ?? bbox.x ?? 0),
        minY = Number(bbox.minY ?? bbox.y ?? 0);
      const maxX = Number(bbox.maxX ?? (bbox.x ?? 0) + (bbox.width ?? 0));
      const maxY = Number(bbox.maxY ?? (bbox.y ?? 0) + (bbox.height ?? 0));
      const elements = await loadBoardElements(boardId);
      const nodes = elements
        .filter((e) => {
          const c = centerOf(e);
          return c.x >= minX && c.x <= maxX && c.y >= minY && c.y <= maxY;
        })
        .map((e) => e.externalId);
      const edges = (await listEdgesForBoard(boardId)).filter(
        (e) => nodes.includes(e.from) && nodes.includes(e.to)
      );
      res.json({ subgraph: { nodes, edges } });
    } catch (e) {
      res.status(500).json({ error: e.message || "region_subgraph failed" });
    }
  });

  app.post("/api/mcp/semantic_layout_search", requireAuth, async (req, res) => {
    try {
      const { connection_id, data } = req.body || {};
      const s = ensureSession(req, res, connection_id);
      if (!s) return;
      const boardId = String(data?.boardId || s.boardId || "");
      if (!boardId) return res.status(400).json({ error: "Missing boardId" });
      s.boardId = boardId;
      const query = String(data?.query || "").toLowerCase();
      const searchType = String(data?.search_type || "text").toLowerCase();
      const elements = await loadBoardElements(boardId);
      let results = [];
      if (searchType === "text")
        results = elements.filter((e) =>
          String(e.text || "")
            .toLowerCase()
            .includes(query)
        );
      else {
        const k = Math.max(1, Math.min(50, Number(data?.k || 10)));
        results = elements
          .map((e) => ({ e, area: Number(e.w || 0) * Number(e.h || 0) }))
          .sort((a, b) => b.area - a.area)
          .slice(0, k)
          .map((x) => x.e);
      }
      s.items = results;
      s.itemType = "node";
      s.cursor = 0;
      res.json({ ok: true, results });
    } catch (e) {
      res.status(500).json({ error: e.message || "semantic_layout_search failed" });
    }
  });

  app.post("/api/mcp/explain_selection", requireAuth, async (req, res) => {
    try {
      const { connection_id, data } = req.body || {};
      const s = ensureSession(req, res, connection_id);
      if (!s) return;
      const boardId = String(data?.boardId || s.boardId || "");
      if (!boardId) return res.status(400).json({ error: "Missing boardId" });
      s.boardId = boardId;
      const selected = Array.isArray(data?.selected) ? data.selected.map(String) : [];
      const edges = await listEdgesForBoard(boardId);
      const nodesSet = new Set(selected);
      const subEdges = edges.filter((e) => nodesSet.has(e.from) || nodesSet.has(e.to));
      const subNodes = new Set();
      for (const e of subEdges) {
        subNodes.add(e.from);
        subNodes.add(e.to);
      }
      res.json({
        ok: true,
        subgraph: { nodes: Array.from(subNodes), edges: subEdges },
        explanation: "Connected via canvas relationships",
      });
    } catch (e) {
      res.status(500).json({ error: e.message || "explain_selection failed" });
    }
  });

  // Graph overview: BFS from seeds (optional), or whole-board summary
  app.post("/api/mcp/graph_overview", requireAuth, async (req, res) => {
    try {
      const { connection_id, data } = req.body || {};
      const s = ensureSession(req, res, connection_id);
      if (!s) return;
      const boardId = String(data?.boardId || s.boardId || "");
      if (!boardId) return res.status(400).json({ error: "Missing boardId" });
      s.boardId = boardId;

      const seeds = Array.isArray(data?.seeds) ? data.seeds.map(String) : [];
      const labels = Array.isArray(data?.edge_labels)
        ? data.edge_labels.map((t) => String(t).toUpperCase())
        : [];
      const maxDepth = Math.max(0, Math.min(6, Number(data?.max_depth || 0)));

      const elements = await loadBoardElements(boardId);
      const edgesAll = await listEdgesForBoard(boardId);
      const edges = labels.length
        ? edgesAll.filter((e) => labels.includes(String(e.type || "").toUpperCase()))
        : edgesAll;

      let visited = new Set();
      let traversed = [];
      if (seeds.length && maxDepth > 0) {
        const byFrom = new Map();
        for (const e of edges) {
          if (!byFrom.has(e.from)) byFrom.set(e.from, []);
          byFrom.get(e.from).push(e);
        }
        visited = new Set(seeds);
        const q = seeds.map((id) => ({ id, d: 0 }));
        while (q.length) {
          const { id, d } = q.shift();
          if (d >= maxDepth) continue;
          const arr = byFrom.get(String(id)) || [];
          for (const e of arr) {
            traversed.push(e);
            if (!visited.has(e.to)) {
              visited.add(e.to);
              q.push({ id: e.to, d: d + 1 });
            }
          }
        }
      }

      const byKind = elements.reduce((acc, e) => {
        const k = String(e.kind || "");
        acc[k] = (acc[k] || 0) + 1;
        return acc;
      }, {});
      const topKinds = Object.entries(byKind)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 5)
        .map(([k, v]) => `${k}:${v}`)
        .join(", ");
      const overview = [
        `Nodes: ${elements.length}`,
        `Edges: ${edges.length}`,
        seeds.length
          ? `Seeds: ${seeds.length}, Depth: ${maxDepth}, Traversed edges: ${traversed.length}, Reachable nodes: ${visited.size}`
          : `Seeds: none`,
        `Top kinds: ${topKinds || "n/a"}`,
      ].join(" | ");
      res.json({ ok: true, overview });
    } catch (e) {
      res.status(500).json({ error: e.message || "graph_overview failed" });
    }
  });

  // Element context: neighbors within a radius and incident edges
  app.post("/api/mcp/get_element_context", requireAuth, async (req, res) => {
    try {
      const { connection_id, data } = req.body || {};
      const s = ensureSession(req, res, connection_id);
      if (!s) return;
      const boardId = String(data?.boardId || s.boardId || "");
      if (!boardId) return res.status(400).json({ error: "Missing boardId" });
      s.boardId = boardId;
      const elementId = String(data?.element_id || "");
      const radius = Math.max(0, Number(data?.radius || SPATIAL_CONSTANTS.ELEMENT_CONTEXT_RADIUS));
      if (!elementId) return res.status(400).json({ error: "Missing element_id" });

      const elements = await loadBoardElements(boardId);
      const edges = await listEdgesForBoard(boardId);
      const byId = new Map(elements.map((e) => [e.externalId, e]));
      const base = byId.get(elementId);
      if (!base) return res.json({ ok: true, context: { nodes: [], edges: [] } });
      const bc = centerOf(base);
      const nodes = elements
        .filter((e) => {
          const c = centerOf(e);
          return Math.hypot(c.x - bc.x, c.y - bc.y) <= radius;
        })
        .map((e) => e.externalId);
      const nodeSet = new Set(nodes);
      const ctxEdges = edges.filter((e) => nodeSet.has(e.from) || nodeSet.has(e.to));
      res.json({ ok: true, context: { nodes, edges: ctxEdges } });
    } catch (e) {
      res.status(500).json({ error: e.message || "get_element_context failed" });
    }
  });

  // Analyze canvas structure via HelixDB (if available)
  app.post("/api/mcp/analyze_canvas_structure", requireAuth, async (req, res) => {
    try {
      const { connection_id, data } = req.body || {};
      const s = ensureSession(req, res, connection_id);
      if (!s) return;
      const boardId = String(data?.boardId || s.boardId || "");
      if (!boardId) return res.status(400).json({ error: "Missing boardId" });
      s.boardId = boardId;
      try {
        const result = await callHelix("analyzeCanvasStructure", { boardExtId: boardId });
        return res.json({ ok: true, structure: result });
      } catch {}
      // Fallback summary
      const elements = await loadBoardElements(boardId);
      const edges = await listEdgesForBoard(boardId);
      const byKind = elements.reduce((acc, e) => {
        const k = String(e.kind || "");
        acc[k] = (acc[k] || 0) + 1;
        return acc;
      }, {});
      res.json({ ok: true, structure: { nodes: elements.length, edges: edges.length, byKind } });
    } catch (e) {
      res.status(500).json({ error: e.message || "analyze_canvas_structure failed" });
    }
  });

  // Flow extract: DAGs along FLOWS_TO plus induced subgraph
  app.post("/api/mcp/flow_extract", requireAuth, async (req, res) => {
    try {
      const { connection_id, data } = req.body || {};
      const s = ensureSession(req, res, connection_id);
      if (!s) return;
      const boardId = String(data?.boardId || s.boardId || "");
      if (!boardId) return res.status(400).json({ error: "Missing boardId" });
      s.boardId = boardId;
      const seeds = Array.isArray(data?.seeds) ? data.seeds.map(String) : [];
      const maxDepth = Math.max(1, Math.min(10, Number(data?.max_depth || 6)));
      const edges = (await listEdgesForBoard(boardId)).filter(
        (e) => String(e.type || "").toUpperCase() === "FLOWS_TO"
      );
      const byFrom = new Map();
      for (const e of edges) {
        if (!byFrom.has(e.from)) byFrom.set(e.from, []);
        byFrom.get(e.from).push(e);
      }
      const flows = [];
      const nodesSet = new Set();
      const edgeSet = new Set();
      const dfs = (node, depth, path) => {
        nodesSet.add(node);
        if (depth > maxDepth) {
          flows.push([...path]);
          return;
        }
        const arr = byFrom.get(String(node)) || [];
        if (!arr.length) {
          flows.push([...path]);
          return;
        }
        for (const e of arr) {
          edgeSet.add(JSON.stringify(e));
          path.push(e.to);
          dfs(e.to, depth + 1, path);
          path.pop();
        }
      };
      for (const sId of seeds) dfs(sId, 0, [sId]);
      const edgesOut = Array.from(edgeSet).map((s) => JSON.parse(s));
      res.json({ ok: true, flows, nodes: Array.from(nodesSet), edges: edgesOut });
    } catch (e) {
      res.status(500).json({ error: e.message || "flow_extract failed" });
    }
  });

  // Pattern detect (basic placeholder; prefer Helix analyzeCanvasStructure when available)
  app.post("/api/mcp/pattern_detect", requireAuth, async (req, res) => {
    try {
      const { connection_id, data } = req.body || {};
      const s = ensureSession(req, res, connection_id);
      if (!s) return;
      const boardId = String(data?.boardId || s.boardId || "");
      if (!boardId) return res.status(400).json({ error: "Missing boardId" });
      s.boardId = boardId;
      try {
        const result = await callHelix("analyzeCanvasStructure", { boardExtId: boardId });
        return res.json({ patterns: result?.patterns || {} });
      } catch {}
      // Fallback: simple row/column hints by directional edges
      const edges = await listEdgesForBoard(boardId);
      const rows = edges.filter(
        (e) => String(e.type || "").toUpperCase() === "DIRECTIONAL" && e.dir === "E"
      ).length;
      const cols = edges.filter(
        (e) => String(e.type || "").toUpperCase() === "DIRECTIONAL" && e.dir === "S"
      ).length;
      res.json({ patterns: { row_like: rows > 0, column_like: cols > 0 } });
    } catch (e) {
      res.status(500).json({ error: e.message || "pattern_detect failed" });
    }
  });

  app.post("/api/mcp/canvas_understanding", requireAuth, async (req, res) => {
    try {
      const { connection_id, boardId, selected_ids } = req.body || {};
      const s = ensureSession(req, res, connection_id);
      if (!s) return;
      const id = String(boardId || s.boardId || "");
      if (!id) return res.status(400).json({ error: "Missing boardId" });
      s.boardId = id;
      const elements = await loadBoardElements(id);
      const counts = elements.reduce((acc, e) => {
        const k = String(e.kind || "");
        acc[k] = (acc[k] || 0) + 1;
        return acc;
      }, {});
      const selection = Array.isArray(selected_ids) ? selected_ids.map(String) : [];
      res.json({ canvas_context: { counts, total: elements.length, selection } });
    } catch (e) {
      res.status(500).json({ error: e.message || "canvas_understanding failed" });
    }
  });

  app.post("/api/mcp/assert_hypothesis", requireAuth, async (req, res) => {
    try {
      const { connection_id, data } = req.body || {};
      const s = ensureSession(req, res, connection_id);
      if (!s) return;
      s.history = Array.isArray(s.history) ? s.history : [];
      s.history.push({ type: "hypothesis", payload: data, ts: Date.now() });
      res.json({ ok: true });
    } catch (e) {
      res.status(500).json({ error: e.message || "assert_hypothesis failed" });
    }
  });

  app.post("/api/mcp/create-element", requireAuth, async (req, res) => {
    try {
      const { boardId, elementType } = req.body || {};
      if (!boardId || !elementType)
        return res.status(400).json({ error: "Missing boardId or elementType" });
      const exec = async () => {
        const element = await callHelix("createElement", {
          boardId,
          elementType,
          externalId: `el_${Date.now()}`,
        });
        return element;
      };
      const element =
        typeof withDistributedLock === "function"
          ? await withDistributedLock(`mcp-create:${boardId}`, exec, 15000)
          : await exec();
      res.json({ success: true, element });
    } catch (e) {
      res.status(500).json({ error: e.message || "create-element failed" });
    }
  });

  app.post("/api/mcp/connect-elements", requireAuth, async (req, res) => {
    try {
      const { boardId, fromId, toId } = req.body || {};
      if (!boardId || !fromId || !toId)
        return res.status(400).json({ error: "Missing boardId, fromId or toId" });
      const exec = async () => {
        const arrow = await callHelix("createArrow", {
          boardId,
          startElementId: fromId,
          endElementId: toId,
          strokeColor: "#1e1e1e",
          arrowExternalId: `ar_${Date.now()}`,
        });
        return arrow;
      };
      const arrow =
        typeof withDistributedLock === "function"
          ? await withDistributedLock(`mcp-connect:${boardId}`, exec, 15000)
          : await exec();
      res.json({ success: true, arrow });
    } catch (e) {
      res.status(500).json({ error: e.message || "connect-elements failed" });
    }
  });
}

export default mountMcpRoutes;
