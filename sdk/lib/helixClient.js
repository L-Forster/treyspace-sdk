const parseTagTokens = (value) => {
  if (value === undefined || value === null) return [];
  const text = Array.isArray(value) ? value.join(",") : String(value);
  return text
    .split(/[,\s]+/)
    .map((token) => token.trim().toLowerCase())
    .filter(Boolean);
};

const mergeTagValueInto = (set, value) => {
  if (!value) return;
  if (value instanceof Set) {
    for (const entry of value) mergeTagValueInto(set, entry);
    return;
  }
  if (Array.isArray(value)) {
    for (const entry of value) mergeTagValueInto(set, entry);
    return;
  }
  for (const token of parseTagTokens(value)) {
    set.add(token);
  }
};

const collectRuntimeTags = () => {
  const tags = new Set();
  const envSources = [
    process.env.SDK_TAGS,
    process.env.TREYSPACE_TAGS,
    process.env.HELIX_TAGS,
    process.env.HELIX_RUNTIME_TAGS,
    process.env.TREYSPACE_RUNTIME_TAGS,
  ];
  for (const value of envSources) mergeTagValueInto(tags, value);

  if (typeof globalThis !== "undefined" && globalThis !== null) {
    const globalTags = globalThis.__TREYSPACE_RUNTIME_TAGS__;
    if (globalTags !== undefined) mergeTagValueInto(tags, globalTags);
  }

  const argv = Array.isArray(process?.argv) ? process.argv.slice(2) : [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--enable_helix") {
      tags.add("helix_enabled");
      continue;
    }
    if (arg === "--tag" || arg === "--tags") {
      const next = argv[i + 1];
      if (next && !next.startsWith("--")) {
        mergeTagValueInto(tags, next);
        i++;
      }
      continue;
    }
    if (arg.startsWith("--tag=")) {
      mergeTagValueInto(tags, arg.slice(6));
      continue;
    }
    if (arg.startsWith("--tags=")) {
      mergeTagValueInto(tags, arg.slice(7));
      continue;
    }
  }

  return tags;
};

const runtimeTags = collectRuntimeTags();

const memoryState = {
  boards: new Map(),
};

const toStringSafe = (value, fallback = "") =>
  value === undefined || value === null ? fallback : String(value);

const toFiniteNumber = (value, fallback = 0) => {
  if (value === undefined || value === null || value === "") return fallback;
  const num = Number(value);
  return Number.isFinite(num) ? num : fallback;
};

const cloneElement = (element) =>
  element ? JSON.parse(JSON.stringify(element)) : element;

const resolveBoardId = (params = {}) => {
  const candidates = [
    params.boardExtId,
    params.boardId,
    params.board_ext_id,
    params.board_id,
    params.board,
  ];
  for (const candidate of candidates) {
    const id = toStringSafe(candidate, "").trim();
    if (id) return id;
  }
  return "";
};

const ensureBoardRecord = (boardId) => {
  const id = toStringSafe(boardId, "");
  if (!id) throw new Error("Helix CLI mode requires a boardId");
  if (!memoryState.boards.has(id)) {
    memoryState.boards.set(id, {
      id,
      createdAt: Date.now(),
      elementsByExternal: new Map(),
      elementsById: new Map(),
      nextInternalId: 1,
      relationalAlignments: [],
      semanticRelations: [],
      spatialAlignments: [],
    });
  }
  return memoryState.boards.get(id);
};

const getBoardRecord = (params, { create = false } = {}) => {
  const boardId = resolveBoardId(params);
  if (!boardId) return null;
  return create ? ensureBoardRecord(boardId) : memoryState.boards.get(boardId) || null;
};

const findBoardByInternalId = (elementId) => {
  const id = toStringSafe(elementId, "");
  if (!id) return null;
  for (const board of memoryState.boards.values()) {
    if (board.elementsById.has(id)) return board;
  }
  return null;
};

const pruneRelations = (board, element) => {
  if (!board || !element) return;
  const targets = new Set([
    toStringSafe(element.id),
    toStringSafe(element.externalId),
  ]);
  board.relationalAlignments = board.relationalAlignments.filter((edge) => {
    const values = [
      toStringSafe(edge.sourceId),
      toStringSafe(edge.targetId),
      toStringSafe(edge.via),
      toStringSafe(edge.sourceExternalId),
      toStringSafe(edge.targetExternalId),
    ];
    return !values.some((value) => targets.has(value));
  });
  board.semanticRelations = board.semanticRelations.filter((edge) => {
    const values = [
      toStringSafe(edge.sourceId),
      toStringSafe(edge.targetId),
      toStringSafe(edge.sourceExternalId),
      toStringSafe(edge.targetExternalId),
    ];
    return !values.some((value) => targets.has(value));
  });
  board.spatialAlignments = board.spatialAlignments.filter((edge) => {
    const values = [
      toStringSafe(edge.sourceId),
      toStringSafe(edge.targetId),
      toStringSafe(edge.sourceExternalId),
      toStringSafe(edge.targetExternalId),
    ];
    return !values.some((value) => targets.has(value));
  });
};

const createSkeletonElement = (board, externalId) => {
  const id = toStringSafe(board.nextInternalId++, Date.now());
  const shortId = externalId ? externalId.slice(0, 8) : id.slice(0, 8);
  return {
    id,
    boardId: board.id,
    boardExtId: board.id,
    externalId,
    kind: "",
    type: "",
    short_id: shortId,
    x: 0,
    y: 0,
    w: 0,
    h: 0,
    angle: 0,
    strokeColor: "#000000",
    backgroundColor: "transparent",
    strokeWidth: 1,
    fillStyle: "solid",
    roughness: 0,
    opacity: 100,
    text: "",
    link: "",
    locked: false,
    version: 1,
    updated: Date.now(),
    index: 0,
    startBindingId: "",
    endBindingId: "",
    semanticClusterId: "",
    distanceClusterId: "",
    relationalClusterId: "",
  };
};

const applyElementPayload = (element, payload, boardId) => {
  const next = { ...element };
  const text = toStringSafe(payload.text, next.text);
  const kind = toStringSafe(payload.kind ?? payload.type, next.kind);
  next.boardId = boardId;
  next.boardExtId = boardId;
  next.kind = kind;
  next.type = kind || next.type || "";
  next.short_id = toStringSafe(payload.short_id ?? payload.shortId, next.short_id);
  next.x = toFiniteNumber(payload.x ?? payload.pos_x, next.x);
  next.y = toFiniteNumber(payload.y ?? payload.pos_y, next.y);
  next.w = toFiniteNumber(payload.w ?? payload.width, next.w);
  next.h = toFiniteNumber(payload.h ?? payload.height, next.h);
  next.angle = toFiniteNumber(payload.angle, next.angle);
  next.strokeColor = toStringSafe(payload.strokeColor, next.strokeColor);
  next.backgroundColor = toStringSafe(payload.backgroundColor, next.backgroundColor);
  next.strokeWidth = toFiniteNumber(payload.strokeWidth, next.strokeWidth);
  next.fillStyle = toStringSafe(payload.fillStyle, next.fillStyle);
  next.roughness = toFiniteNumber(payload.roughness, next.roughness);
  next.opacity = toFiniteNumber(payload.opacity, next.opacity);
  next.text = text;
  next.link = toStringSafe(payload.link, next.link);
  if (payload.locked !== undefined) next.locked = Boolean(payload.locked);
  next.version = toFiniteNumber(payload.version, next.version);
  next.updated = toFiniteNumber(payload.updated, Date.now());
  next.index = toFiniteNumber(payload.index, next.index);
  next.startBindingId = toStringSafe(
    payload.startBindingId ?? payload.startBinding?.elementId,
    next.startBindingId
  );
  next.endBindingId = toStringSafe(
    payload.endBindingId ?? payload.endBinding?.elementId,
    next.endBindingId
  );
  next.semanticClusterId = toStringSafe(payload.semanticClusterId, next.semanticClusterId);
  next.distanceClusterId = toStringSafe(payload.distanceClusterId, next.distanceClusterId);
  next.relationalClusterId = toStringSafe(
    payload.relationalClusterId,
    next.relationalClusterId
  );
  return next;
};

const upsertInMemoryElement = (payload) => {
  const boardId = resolveBoardId(payload);
  if (!boardId) throw new Error("Helix CLI mode requires boardId/externalId");
  const externalId = toStringSafe(
    payload.externalId ?? payload.elementExtId ?? payload.elementId,
    ""
  );
  if (!externalId) throw new Error("Helix CLI mode requires element externalId");
  const board = ensureBoardRecord(boardId);
  const existing = board.elementsByExternal.get(externalId);
  const base = existing || createSkeletonElement(board, externalId);
  const updated = applyElementPayload(base, payload, boardId);
  board.elementsByExternal.set(externalId, updated);
  board.elementsById.set(updated.id, updated);
  return updated;
};

const removeElementFromBoard = (board, externalId) => {
  if (!board) return;
  const existing = board.elementsByExternal.get(externalId);
  if (!existing) return;
  board.elementsByExternal.delete(externalId);
  board.elementsById.delete(existing.id);
  pruneRelations(board, existing);
};

const createInMemoryHelix = () => {
  const operations = {
    ensureBoard: async (params = {}) => {
      const board = getBoardRecord(params, { create: true });
      return { ok: true, boardId: board?.id };
    },
    deleteAllBoardRelations: async (params = {}) => {
      const board = getBoardRecord(params);
      if (!board) return { ok: true };
      board.relationalAlignments = [];
      board.semanticRelations = [];
      board.spatialAlignments = [];
      return { ok: true };
    },
    deleteBoardElements: async (params = {}) => {
      const board = getBoardRecord(params);
      if (!board) return { ok: true };
      board.elementsByExternal.clear();
      board.elementsById.clear();
      board.relationalAlignments = [];
      board.semanticRelations = [];
      board.spatialAlignments = [];
      return { ok: true };
    },
    deleteElement: async (params = {}) => {
      const board = getBoardRecord(params);
      const extId = toStringSafe(
        params.elementExtId ?? params.elementId ?? params.externalId,
        ""
      );
      if (board && extId) removeElementFromBoard(board, extId);
      return { ok: true };
    },
    deleteElementById: async (params = {}) => {
      const id = toStringSafe(params.elementId ?? params.id, "");
      if (!id) return { ok: true };
      const board = findBoardByInternalId(id);
      if (board) {
        const existing = board.elementsById.get(id);
        if (existing) {
          board.elementsById.delete(id);
          board.elementsByExternal.delete(existing.externalId);
          pruneRelations(board, existing);
        }
      }
      return { ok: true };
    },
    deleteRelationalAlignmentsForElement: async (params = {}) => {
      const board = getBoardRecord(params);
      if (!board) return { ok: true };
      const extId = toStringSafe(params.elementExtId, "");
      const explicitId = toStringSafe(params.elementId, "");
      const targetIds = new Set([extId, explicitId]);
      if (extId && board.elementsByExternal.has(extId)) {
        targetIds.add(toStringSafe(board.elementsByExternal.get(extId)?.id));
      }
      board.relationalAlignments = board.relationalAlignments.filter((edge) => {
        const values = [
          toStringSafe(edge.sourceId),
          toStringSafe(edge.targetId),
          toStringSafe(edge.via),
          toStringSafe(edge.sourceExternalId),
          toStringSafe(edge.targetExternalId),
        ];
        return !values.some((value) => value && targetIds.has(value));
      });
      return { ok: true };
    },
    deleteSemanticRelationsForBoard: async (params = {}) => {
      const board = getBoardRecord(params);
      if (!board) return { ok: true };
      board.semanticRelations = [];
      return { ok: true };
    },
    deleteSemanticRelationsForElement: async (params = {}) => {
      const board = getBoardRecord(params);
      if (!board) return { ok: true };
      const extId = toStringSafe(params.elementExtId, "");
      const explicitId = toStringSafe(params.elementId, "");
      const targetIds = new Set([extId, explicitId]);
      if (extId && board.elementsByExternal.has(extId)) {
        targetIds.add(toStringSafe(board.elementsByExternal.get(extId)?.id));
      }
      board.semanticRelations = board.semanticRelations.filter((edge) => {
        const values = [
          toStringSafe(edge.sourceId),
          toStringSafe(edge.targetId),
          toStringSafe(edge.sourceExternalId),
          toStringSafe(edge.targetExternalId),
        ];
        return !values.some((value) => value && targetIds.has(value));
      });
      return { ok: true };
    },
    deleteSpatialAlignmentsForBoard: async (params = {}) => {
      const board = getBoardRecord(params);
      if (!board) return { ok: true };
      board.spatialAlignments = [];
      return { ok: true };
    },
    deleteSpatialAlignmentsForElement: async (params = {}) => {
      const board = getBoardRecord(params);
      if (!board) return { ok: true };
      const extId = toStringSafe(params.elementExtId, "");
      const explicitId = toStringSafe(params.elementId, "");
      const targetIds = new Set([extId, explicitId]);
      if (extId && board.elementsByExternal.has(extId)) {
        targetIds.add(toStringSafe(board.elementsByExternal.get(extId)?.id));
      }
      board.spatialAlignments = board.spatialAlignments.filter((edge) => {
        const values = [
          toStringSafe(edge.sourceId),
          toStringSafe(edge.targetId),
          toStringSafe(edge.sourceExternalId),
          toStringSafe(edge.targetExternalId),
        ];
        return !values.some((value) => value && targetIds.has(value));
      });
      return { ok: true };
    },
    getBoardElements: async (params = {}) => {
      const board = getBoardRecord(params);
      if (!board) return { elements: [] };
      return {
        elements: Array.from(board.elementsByExternal.values(), (el) => cloneElement(el)),
      };
    },
    getAllElementsForBoard: async (params = {}) => {
      const board = getBoardRecord(params);
      if (!board) return { elements: [] };
      return {
        elements: Array.from(board.elementsByExternal.values(), (el) => cloneElement(el)),
      };
    },
    upsertElement: async (params = {}) => {
      const element = upsertInMemoryElement(params);
      return { el: cloneElement(element) };
    },
    updateElementById: async (params = {}) => {
      const id = toStringSafe(params.elementId ?? params.id, "");
      if (!id) throw new Error("Helix CLI mode requires elementId");
      const board =
        findBoardByInternalId(id) ||
        getBoardRecord(params, { create: Boolean(resolveBoardId(params)) });
      if (!board) throw new Error(`Element ${id} not found`);
      const existing = board.elementsById.get(id);
      if (!existing) throw new Error(`Element ${id} not found`);
      const updated = applyElementPayload(existing, params, board.id);
      board.elementsById.set(id, updated);
      board.elementsByExternal.set(updated.externalId, updated);
      return { el: cloneElement(updated) };
    },
    addRelationalAlignment: async (params = {}) => {
      const sourceId = toStringSafe(params.sourceId, "");
      const targetId = toStringSafe(params.targetId, "");
      const via = toStringSafe(params.via, "");
      const edgeLabel = toStringSafe(params.edgeLabel, "");
      const board =
        findBoardByInternalId(sourceId) ||
        findBoardByInternalId(targetId) ||
        getBoardRecord(params);
      if (!board) return { ok: false };
      const sourceEl = sourceId ? board.elementsById.get(sourceId) : null;
      const targetEl = targetId ? board.elementsById.get(targetId) : null;
      const edge = {
        sourceId,
        targetId,
        via,
        edgeLabel,
        sourceExternalId: toStringSafe(sourceEl?.externalId, ""),
        targetExternalId: toStringSafe(targetEl?.externalId, ""),
        createdAt: Date.now(),
      };
      board.relationalAlignments.push(edge);
      return { edge };
    },
    createElement: async (params = {}) => {
      const boardId = resolveBoardId(params);
      const externalId = toStringSafe(
        params.externalId ?? params.elementExtId ?? params.elementId ?? `el_${Date.now()}`,
        ""
      );
      const elementType = toStringSafe(params.elementType ?? params.kind ?? "rectangle", "rectangle");
      const payload = {
        ...params,
        boardId,
        externalId,
        kind: elementType,
        type: elementType,
        short_id: externalId.slice(0, 8),
      };
      const element = upsertInMemoryElement(payload);
      return { element: cloneElement(element) };
    },
    createArrow: async (params = {}) => {
      const boardId = resolveBoardId(params);
      const board = ensureBoardRecord(boardId);
      const externalId = toStringSafe(
        params.arrowExternalId ?? params.externalId ?? `ar_${Date.now()}`,
        ""
      );

      const startInternalId = toStringSafe(params.startElementId ?? "", "");
      const endInternalId = toStringSafe(params.endElementId ?? "", "");
      const startElement = startInternalId ? board.elementsById.get(startInternalId) : null;
      const endElement = endInternalId ? board.elementsById.get(endInternalId) : null;

      const startBindingId =
        toStringSafe(
          params.startBindingId ??
            (startElement ? startElement.externalId : undefined) ??
            startInternalId,
          ""
        ) || "";
      const endBindingId =
        toStringSafe(
          params.endBindingId ??
            (endElement ? endElement.externalId : undefined) ??
            endInternalId,
          ""
        ) || "";

      const payload = {
        ...params,
        boardId,
        externalId,
        kind: "arrow",
        type: "arrow",
        short_id: externalId.slice(0, 8),
        startBindingId,
        endBindingId,
      };
      const element = upsertInMemoryElement(payload);
      return { arrow: cloneElement(element) };
    },
    analyzeCanvasStructure: async (params = {}) => {
      const board = getBoardRecord(params);
      if (!board) return { boardId: resolveBoardId(params), nodes: 0, edges: 0, byKind: {} };
      const elements = Array.from(board.elementsByExternal.values());
      const byKind = {};
      for (const el of elements) {
        const kind = toStringSafe(el.kind || el.type || "unknown");
        byKind[kind] = (byKind[kind] || 0) + 1;
      }
      return {
        boardId: board.id,
        nodes: elements.length,
        edges:
          board.relationalAlignments.length +
          board.semanticRelations.length +
          board.spatialAlignments.length,
        byKind,
        relations: {
          relational: board.relationalAlignments.length,
          semantic: board.semanticRelations.length,
          spatial: board.spatialAlignments.length,
        },
      };
    },
  };

  const callOp = async (name, params = {}) => {
    const op = operations[name];
    if (!op) {
      throw new Error(`Helix CLI mode: unsupported query "${name}"`);
    }
    return await op(params || {});
  };

  return {
    endpoint: "in-memory",
    mode: "in-memory",
    async query(name, params) {
      return await callOp(name, params);
    },
  };
};

let HelixDB;
try {
  const mod = await import("helix-ts");
  HelixDB = mod?.default || mod?.HelixDB;
} catch {
  HelixDB = class {
    constructor(endpoint) {
      this.endpoint = endpoint;
    }
    async query(name, params) {
      console.log(`[HelixDB:no-op] ${name}`, params);
      return true;
    }
  };
}

// Add timeout wrapper to prevent hanging connections
const withTimeout = (promise, timeoutMs = 10000) => {
  let timeoutId;
  const timer = new Promise((_, reject) => {
    timeoutId = setTimeout(() => reject(new Error(`HelixDB timeout after ${timeoutMs}ms`)), timeoutMs);
  });
  return Promise.race([Promise.resolve(promise).finally(() => clearTimeout(timeoutId)), timer]);
};

// Queue to serialize HelixDB calls and prevent concurrent write overload
class HelixQueue {
  constructor() {
    this.queue = [];
    this.processing = false;
    this.maxConcurrent = Number(process.env.HELIX_MAX_CONCURRENT || 1); // Sequential by default
    this.active = 0;
  }

  async enqueue(fn) {
    return new Promise((resolve, reject) => {
      this.queue.push({ fn, resolve, reject });
      this.process();
    });
  }

  async process() {
    if (this.processing || this.queue.length === 0 || this.active >= this.maxConcurrent) {
      return;
    }

    this.processing = true;

    while (this.queue.length > 0 && this.active < this.maxConcurrent) {
      const task = this.queue.shift();
      if (!task) break;

      this.active++;

      task
        .fn()
        .then((result) => {
          task.resolve(result);
        })
        .catch((err) => {
          task.reject(err);
        })
        .finally(() => {
          this.active--;
          this.process(); // Process next item
        });
    }

    this.processing = false;
  }
}

const helixQueue = new HelixQueue();

export function createHelix(endpoint, options = {}) {
  const activeTags = new Set(runtimeTags);
  mergeTagValueInto(activeTags, options.tags);

  const isHelixEnabled = activeTags.has("helix_enabled");
  const helix = isHelixEnabled ? new HelixDB(endpoint) : createInMemoryHelix();
  const TIMEOUT_MS = Number(process.env.HELIX_TIMEOUT_MS || 10000);

  const callHelix = async (queryName, params) => {
    // Serialize all writes through queue to prevent HelixDB crashes
    const WRITE_OPERATIONS = new Set([
      "upsertElement",
      "updateElementById",
      "deleteElement",
      "deleteElementById",
      "addRelationalAlignment",
      "deleteRelationalAlignmentsForElement",
      "deleteSemanticRelationsForElement",
      "deleteSpatialAlignmentsForElement",
      "deleteAllBoardRelations",
      "deleteBoardElements",
      "deleteSemanticRelationsForBoard",
      "deleteSpatialAlignmentsForBoard",
      "createElement",
      "createArrow",
    ]);

    const isWrite = WRITE_OPERATIONS.has(queryName);

    const executeQuery = async () => {
      try {
        const result = await withTimeout(helix.query(queryName, params || {}), TIMEOUT_MS);
        return result;
      } catch (error) {
        // Handle connection errors gracefully
        if (
          !isCliMode &&
          (error?.cause?.code === "UND_ERR_SOCKET" || error?.message?.includes("socket"))
        ) {
          console.warn(`[HelixDB] Socket error on ${queryName}, will retry: ${error.message}`);
          throw error;
        }
        throw error;
      }
    };

    // Queue writes to prevent concurrent overload; reads can go parallel
    if (isWrite) {
      return await helixQueue.enqueue(executeQuery);
    } else {
      return await executeQuery();
    }
  };

  if (!isHelixEnabled) {
    helix.tags = Array.from(activeTags);
    callHelix.mode = "in-memory";
  }
  callHelix.tags = Array.from(activeTags);

  return { helix, callHelix };
}
