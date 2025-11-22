import { fileURLToPath } from "url";
import path from "path";

import crypto from "crypto";

import fs, { promises as fsp } from "fs";

import dotenv from "dotenv";
import express from "express";
import cors from "cors";
import bodyParser from "body-parser";
import { cosineSimilarity as cosineSim } from "./lib/utils.js";
import { debug, info } from "./lib/logger.js";
import {
  boardCache,
  textVecCache,
  clusterCache,
  ensureDir,
  saveBoardToDisk,
  loadBoardFromDisk,
  hydrateBoardCacheFromDisk,
} from "./lib/cache.js";
import { createHelix } from "./lib/helixClient.js";
import { createLockUtils } from "./lib/locks.js";
import { mountHealthRoutes } from "./routes/health.js";
import { mountClustersRoutes } from "./routes/clusters.js";
import { mountMcpRoutes } from "./routes/mcp.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const env = process.env.NODE_ENV || "development";
const envFile = env === "production" ? ".env.production" : ".env.development";

dotenv.config({ path: path.resolve(__dirname, envFile) });

const { withDistributedLock } = createLockUtils();

export const app = express();
export const PORT = process.env.PORT || 3001;

app.set("trust proxy", true);

const getAllowedOrigins = () => {
  const defaultOrigins =
    process.env.NODE_ENV === "production"
      ? [process.env.HELIX_INTERNAL_ORIGIN || "http://localhost:8788"].join(",")
      : "http://localhost:3000,http://localhost:5173";

  const origins =
    process.env.NODE_ENV === "production"
      ? process.env.ALLOWED_ORIGINS || defaultOrigins
      : defaultOrigins;

  return origins
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
};

const allowed = getAllowedOrigins();
const ALLOW_LOCALHOST_ORIGINS =
  String(process.env.ALLOW_LOCALHOST_ORIGINS || "true").toLowerCase() !== "false";

const normalizeOrigin = (value) => {
  if (!value) return "";
  try {
    const url = new URL(value);
    url.hash = "";
    url.username = "";
    url.password = "";
    if (url.pathname === "/") url.pathname = "";
    return url.toString();
  } catch {
    return String(value).trim();
  }
};

const allowedOriginSet = new Set(allowed.map((origin) => normalizeOrigin(origin)));

const isLocalhostOrigin = (origin) => {
  if (typeof origin !== "string") return false;
  try {
    const url = new URL(origin);
    return /^(localhost|127(?:\.\d{1,3}){3}|0\.0\.0\.0)$/i.test(url.hostname);
  } catch {
    return false;
  }
};

if (!process.env.NODE_ENV) {
  console.warn(`⚠️  NODE_ENV not set, defaulting to 'development'`);
}

if (process.env.NODE_ENV === "production") {
  debug(`🏗️  Production environment detected`);
  if (allowed.some((origin) => origin.includes("localhost") || origin.includes("127.0.0.1"))) {
    debug(`🖥️  Localhost origins detected - this is normal for VM/container deployments`);
  }
}

debug(`🔒 CORS Security Config:`);
debug(`   Environment: ${process.env.NODE_ENV || "development"}`);
debug(`   Allowed Origins: ${allowed.join(", ")}`);
debug(`   Trust Proxy: enabled`);
debug(`   Origin Header Required: ${process.env.NODE_ENV === "production" ? "YES" : "NO"}`);

app.use((req, _res, next) => {
  if (!req.headers.origin && process.env.NODE_ENV === "production") {
    const proto = String(
      (req.headers["x-forwarded-proto"] || req.protocol || "https").toString().split(",")[0]
    )
      .trim()
      .toLowerCase();
    const host = String(
      (req.headers["x-forwarded-host"] || req.headers.host || "").toString().split(",")[0]
    ).trim();
    if (host) {
      const synthesized = normalizeOrigin(`${proto}://${host}`);
      if (
        allowedOriginSet.has(synthesized) ||
        (ALLOW_LOCALHOST_ORIGINS && isLocalhostOrigin(synthesized))
      ) {
        req.headers.origin = synthesized;
      }
    }
  }
  next();
});

if (process.env.NODE_ENV === "production") {
  debug(`🔍 Production mode: Will validate origin headers strictly`);
}

const corsOptions = {
  origin: (origin, cb) => {
    if (!origin) {
      if (process.env.NODE_ENV === "production") {
        console.warn(`🚨 CORS SECURITY: Blocked request with no origin header in production`);
        return cb(new Error("Origin header required in production"));
      }

      debug(`🔓 CORS DEV: Allowing request without origin in development`);
      return cb(null, true);
    }

    const normalized = normalizeOrigin(origin);
    if (allowed.includes("*") || allowedOriginSet.has(normalized)) {
      debug(`✅ CORS: Allowed origin: ${origin}`);
      return cb(null, true);
    }

    if (ALLOW_LOCALHOST_ORIGINS && isLocalhostOrigin(normalized)) {
      debug(`🔓 CORS: Allowing localhost origin: ${origin}`);
      return cb(null, true);
    }

    console.warn(
      `🚨 CORS BLOCKED: origin=${origin}, allowed=[${allowed.join(
        ", "
      )}], env=${process.env.NODE_ENV || "development"}`
    );
    return cb(new Error("Not allowed by CORS"));
  },
  credentials: true,
  methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
  allowedHeaders: [
    "Content-Type",
    "Authorization",
    "X-Requested-With",
    "Accept",
    "Origin",
    "X-CSRF-Token",
  ],
  exposedHeaders: ["X-Total-Count"],
  optionsSuccessStatus: 204,
  maxAge: 86400, // 24 hours
};

app.use(cors(corsOptions));

app.options("*", cors(corsOptions));
app.use((req, res, next) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
  next();
});
app.use(bodyParser.json({ limit: "10mb" }));

const coerceUrl = (value, fallback) => {
  if (!value || typeof value !== "string") {
    return fallback;
  }
  try {
    const url = new URL(value);
    if (!["http:", "https:"].includes(url.protocol)) {
      return fallback;
    }
    return url.toString();
  } catch {
    return fallback;
  }
};

const normalizeKind = (el) => String(el.kind || el.type || "").toLowerCase();

const isConnector = (el) => {
  const k = normalizeKind(el);
  return k === "arrow" || k === "line";
};

const consolidateLabelsIntoShapes = (elements) => {
  if (!Array.isArray(elements)) {
    return [];
  }
  const shapes = [];
  const labels = [];
  for (const el of elements) {
    const kind = normalizeKind(el);
    if (kind === "text") {
      labels.push(el);
    } else {
      shapes.push({ ...el });
    }
  }
  const shapeByExt = new Map(shapes.map((s) => [String(s.externalId || ""), s]));
  const shapeByInt = new Map(shapes.map((s) => [String(s.id || s.ID || ""), s]));
  const assigned = new Set();

  const mergeText = (a, b) => {
    const aStr = typeof a === "string" ? a.trim() : "";
    const bStr = typeof b === "string" ? b.trim() : "";
    if (!aStr && !bStr) {
      return "";
    }
    if (!aStr) {
      return bStr;
    }
    if (!bStr) {
      return aStr;
    }
    if (aStr.includes(bStr)) {
      return aStr;
    }
    if (bStr.includes(aStr)) {
      return bStr;
    }
    return `${aStr} ${bStr}`.trim();
  };

  for (const label of labels) {
    const text = typeof label.text === "string" ? label.text.trim() : "";
    if (!text) {
      continue;
    }
    const lb = bboxOf(label);
    let best = null;
    const containerKeyExt = String(label.containerId || label.container_id || "");
    if (containerKeyExt && shapeByExt.has(containerKeyExt)) {
      best = shapeByExt.get(containerKeyExt);
    } else if (containerKeyExt && shapeByInt.has(containerKeyExt)) {
      best = shapeByInt.get(containerKeyExt);
    }
    if (best) {
      best.text = mergeText(best.text, text);
      assigned.add(String(label.externalId || label.id || ""));
    }
  }

  const result = [...shapes];
  for (const label of labels) {
    const key = String(label.externalId || label.id || "");
    if (!assigned.has(key)) {
      result.push(label);
    }
  }
  return result;
};

const requireAuth = (req, _res, next) => {
  const headerUser =
    req.headers["x-user-id"] ||
    req.headers["x-user"] ||
    req.headers["x-client-id"] ||
    req.headers["x-api-key"] ||
    "anonymous";
  req.user = { id: String(headerUser || "anonymous") };
  if (!req.auth) {
    req.auth = { payload: {}, emails: [] };
  }
  next();
};

const ensureBoardEditor = async (_req, res, boardId) => {
  if (!boardId) {
    res.status(400).json({ error: "Missing boardId" });
    return null;
  }
  return { boardId: String(boardId), role: "editor" };
};

const ensureOwnsBoard = async (req, res, boardId) => {
  const meta = await ensureBoardEditor(req, res, boardId);
  return Boolean(meta);
};

const startHelixServer = async () => {
  debug("[HelixRAG] Connecting to external HelixDB server");
};

await startHelixServer();

const HELIX_ENDPOINT = process.env.HELIX_ENDPOINT || "http://localhost:6969";
const { helix, callHelix } = createHelix(HELIX_ENDPOINT);
const AI_PROXY_URL =
  process.env.AI_PROXY_URL || process.env.VITE_AI_PROXY_URL || "http://localhost:8788";

const MAX_ELEMENTS_PER_SYNC = Number(process.env.MAX_ELEMENTS_PER_SYNC || 1500);
const MAX_PAYLOAD_BYTES = Number(process.env.MAX_SYNC_PAYLOAD_BYTES || 10 * 1024 * 1024);
const HELIX_SAFE_MODE = String(process.env.HELIX_SAFE_MODE ?? "false").toLowerCase() === "true";

// ---------------------------------------------------------------------------
// Durable canvas persistence to disk (single known-writable path inside image)
// ---------------------------------------------------------------------------
const BOARDS_DIRS = [
  // Use the same helix directory structure as HelixDB deployment
  path.join(__dirname, "helix", "data"),
  // Legacy duplicate path from old canvas writes (for reading existing boards)
  path.resolve(process.cwd(), "sdk/helix/data"),
];
const persistTimers = new Map(); // boardId -> Timeout

// ensureDir/saveBoardFromCache/hydrateBoardCacheFromDisk are imported from lib/cache.js
// Create wrappers that use BOARDS_DIRS to ensure consistent read/write paths
const saveBoardToDiskMulti = async (boardId) => {
  try {
    const items = Array.from((boardCache.get(boardId) || new Map()).values());
    const data = { id: String(boardId), items, savedAt: Date.now() };
    for (const dir of BOARDS_DIRS) {
      try {
        await ensureDir(dir);
        const filePath = path.join(dir, `${String(boardId)}.json`);
        await fsp.writeFile(filePath, JSON.stringify(data, null, 2), "utf8");
      } catch {}
    }
  } catch {}
};

const loadBoardFromDiskMulti = async (boardId) => {
  for (const dir of BOARDS_DIRS) {
    try {
      const file = path.join(dir, `${String(boardId)}.json`);
      const text = await fsp.readFile(file, "utf8");
      return JSON.parse(text);
    } catch {}
  }
  return null;
};

const hydrateBoardCacheFromDiskMulti = async (boardId) => {
  try {
    const json = await loadBoardFromDiskMulti(boardId);
    const items = Array.isArray(json?.items) ? json.items : [];
    const map = new Map();
    for (const el of items) if (el?.externalId) map.set(String(el.externalId), el);
    boardCache.set(boardId, map);
  } catch {}
};

const schedulePersist = (boardId) => {
  try {
    const id = String(boardId || "");
    if (!id) {
      return;
    }
    const prev = persistTimers.get(id);
    if (prev) {
      clearTimeout(prev);
    }
    const t = setTimeout(() => {
      persistTimers.delete(id);
      saveBoardToDisk(id);
    }, 400);
    persistTimers.set(id, t);
  } catch {}
};

const ensureBoardSnapshotExists = async (boardId) => {
  const id = String(boardId || "");
  if (!id) {
    return;
  }
  const payload = { boardId: id, updatedAt: Date.now(), items: [] };
  const dir = path.join(__dirname, "helix", "data");
  try {
    // Ensure directory exists with proper permissions
    await fsp.mkdir(dir, { recursive: true, mode: 0o755 });
    const file = path.join(dir, `${id}.json`);
    try {
      await fsp.access(file);
      debug(`[Persist] Board file exists → ${file}`);
      return; // File already exists
    } catch {}
    await fsp.writeFile(file, JSON.stringify(payload), "utf8");
    debug(`[Persist] Initialized board file → ${file}`);
  } catch (e) {
    console.error(`[Persist] Failed to create board file: ${e.message}`);
    console.error(`[Persist] Directory: ${dir}`);
    console.error(`[Persist] Process UID: ${process.getuid()}, GID: ${process.getgid()}`);
    throw e; // Re-throw so the API returns proper error
  }
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
const toFiniteNumber = (value, fallback) => {
  const n = typeof value === "string" ? Number.parseFloat(value) : Number(value);
  return Number.isFinite(n) ? n : fallback;
};

const toFiniteInt = (value, fallback) => {
  const n = typeof value === "string" ? Number.parseInt(value, 10) : Math.trunc(Number(value));
  return Number.isFinite(n) ? n : fallback;
};

// Normalize HelixDB getBoardElements response into a plain array of elements
const toElementsArray = (queryResult) => {
  if (!queryResult) {
    return [];
  }
  if (Array.isArray(queryResult)) {
    return queryResult;
  }
  // Handle cases where result is { elements: [...] } or the first key contains the array
  if (typeof queryResult === "object" && queryResult !== null) {
    const key = Object.keys(queryResult).find((k) => Array.isArray(queryResult[k]));
    return key ? queryResult[key] : [];
  }
  return [];
};

// Deduplicate Helix elements by externalId keeping the most recent/versioned
const dedupeByExternalIdLatest = (arr) => {
  if (!Array.isArray(arr)) {
    return [];
  }
  const map = new Map();
  for (const el of arr) {
    if (!el) {
      continue;
    }
    const id = String(el.externalId || el.id || "");
    if (!id) {
      continue;
    }
    const prev = map.get(id);
    if (!prev) {
      map.set(id, el);
      continue;
    }
    const prevUpdated = Number(prev.updated || 0);
    const currUpdated = Number(el.updated || 0);
    const prevVersion = Number(prev.version || 0);
    const currVersion = Number(el.version || 0);
    if (currUpdated > prevUpdated || (currUpdated === prevUpdated && currVersion >= prevVersion)) {
      map.set(id, el);
    }
  }
  return Array.from(map.values());
};

// Reconcile HelixDB with the in-memory cache for a board: delete dupes, upsert missing, fix mismatches
const reconcileHelixToCache = async (boardId, options = {}) => {
  const id = String(boardId || "");
  if (!id) {
    return;
  }
  try {
    const snapshotIdsRaw = options?.snapshotIds;
    let expectedSet = null;
    if (snapshotIdsRaw) {
      if (snapshotIdsRaw instanceof Set) {
        expectedSet = new Set(Array.from(snapshotIdsRaw).map((extId) => String(extId)));
      } else if (Array.isArray(snapshotIdsRaw)) {
        expectedSet = new Set(snapshotIdsRaw.map((extId) => String(extId)));
      } else if (typeof snapshotIdsRaw[Symbol.iterator] === "function") {
        expectedSet = new Set(Array.from(snapshotIdsRaw, (extId) => String(extId)));
      }
    }
    const helixRes = await callHelix("getBoardElements", { boardExtId: id });
    const helixAll = dedupeByExternalIdLatest(toElementsArray(helixRes));
    const helixByExt = new Map(helixAll.map((el) => [String(el.externalId), el]));
    const cache = boardCache.get(id) || new Map();

    // Delete extra Helix rows not in cache (drop incident edges first, then node)
    const deletes = [];
    for (const [extId, helixEl] of helixByExt.entries()) {
      const shouldKeep = expectedSet ? expectedSet.has(extId) : cache.has(extId);
      if (!shouldKeep) {
        const elementExtId = String(extId);
        // Drop incident edges of all types to avoid constraint/parse errors
        deletes.push(
          callHelix("deleteRelationalAlignmentsForElement", {
            boardExtId: id,
            elementExtId,
          })
        );
        deletes.push(
          callHelix("deleteSemanticRelationsForElement", {
            boardExtId: id,
            elementExtId,
          })
        );
        deletes.push(
          callHelix("deleteSpatialAlignmentsForElement", {
            boardExtId: id,
            elementExtId,
          })
        );
        // Finally, drop the node (by id if available for precision)
        if (helixEl?.id) {
          deletes.push(callHelix("deleteElementById", { elementId: String(helixEl.id) }));
        } else {
          deletes.push(callHelix("deleteElement", { boardExtId: id, elementExtId }));
        }
      }
    }

    // Upsert missing or mismatched
    const upserts = [];
    const upsertEntries = expectedSet
      ? Array.from(expectedSet)
          .map((extId) => [extId, cache.get(extId)])
          .filter(([, local]) => Boolean(local))
      : Array.from(cache.entries());
    for (const [extId, local] of upsertEntries) {
      const remote = helixByExt.get(extId);
      // Ensure kind is never empty - HelixDB requires this field
      const localKind = local.kind && String(local.kind).trim() ? String(local.kind) : "text";
      const params = {
        kind: localKind,
        short_id: String(extId).slice(0, 8),
        x: Number(local.x || 0),
        y: Number(local.y || 0),
        w: Number(local.w || 0),
        h: Number(local.h || 0),
        angle: Number(local.angle || 0),
        strokeColor: String(local.strokeColor || ""),
        backgroundColor: String(local.backgroundColor || ""),
        strokeWidth: toFiniteInt(local.strokeWidth, 1),
        fillStyle: String(local.fillStyle || "solid"),
        roughness: toFiniteInt(local.roughness, 0),
        opacity: toFiniteInt(local.opacity, 100),
        text: String(local.text || ""),
        link: String(local.link || ""),
        locked: Boolean(local.locked),
        version: toFiniteInt(local.version, 0),
        updated: toFiniteInt(local.updated, Date.now()),
        index: toFiniteInt(local.index, 0),
        startBindingId: String(local.startBindingId || ""),
        endBindingId: String(local.endBindingId || ""),
        semanticClusterId: String(local.semanticClusterId || ""),
        distanceClusterId: String(local.distanceClusterId || ""),
        relationalClusterId: String(local.relationalClusterId || ""),
      };
      if (!remote) {
        upserts.push(
          callHelix("upsertElement", {
            externalId: extId,
            boardId: id,
            ...params,
          })
        );
      } else {
        // Compare a few critical fields; if different, update
        const needUpdate =
          Number(remote.version || 0) !== params.version ||
          Number(remote.updated || 0) !== params.updated ||
          Number(remote.x || 0) !== params.x ||
          Number(remote.y || 0) !== params.y ||
          Number(remote.w || 0) !== params.w ||
          Number(remote.h || 0) !== params.h ||
          String(remote.text || "") !== params.text;
        if (needUpdate) {
          const elId = remote.id ? String(remote.id) : null;
          if (elId) {
            upserts.push(callHelix("updateElementById", { elementId: elId, ...params }));
          } else {
            upserts.push(
              callHelix("upsertElement", {
                externalId: extId,
                boardId: id,
                ...params,
              })
            );
          }
        }
      }
    }

    // PRODUCTION FIX: Serially execute all writes
    for (const p of deletes) {
      await p;
    }
    for (const p of upserts) {
      await p;
    }
    debug(`[Reconcile] Board ${id}: deleted ${deletes.length}, upserts ${upserts.length}`);
  } catch (e) {
    console.warn(`[Reconcile] Failed for board ${id}:`, e?.message || e);
  }
};

// Spatial helpers
const bboxOf = (el) => {
  const x = toFiniteNumber(el.x, 0);
  const y = toFiniteNumber(el.y, 0);
  const w = Math.max(0, toFiniteNumber(el.w ?? el.width, 0));
  const h = Math.max(0, toFiniteNumber(el.h ?? el.height, 0));
  const minX = x;
  const minY = y;
  const maxX = x + w;
  const maxY = y + h;
  const cx = (minX + maxX) / 2;
  const cy = (minY + maxY) / 2;
  return { minX, minY, maxX, maxY, cx, cy, w, h };
};

const boxesDistance = (a, b) => {
  const dx = Math.max(0, Math.max(a.minX - b.maxX, b.minX - a.maxX));
  const dy = Math.max(0, Math.max(a.minY - b.maxY, b.minY - a.maxY));
  if (dx === 0 && dy === 0) {
    return 0;
  } // overlap or touch
  return Math.hypot(dx, dy);
};

const horizOverlapRatio = (a, b) => {
  const left = Math.max(a.minX, b.minX);
  const right = Math.min(a.maxX, b.maxX);
  const overlap = Math.max(0, right - left);
  const base = Math.max(1, Math.min(a.w, b.w));
  return overlap / base;
};

const normalizeElement = (el) => {
  if (!el || typeof el !== "object") return null;
  const kind = String(el.kind || el.type || "");
  const lowerKind = kind.toLowerCase();
  const isConnectorKind = lowerKind === "arrow" || lowerKind === "line";
  return {
    externalId: String(el.externalId || el.id || ""),
    boardId: String(el.boardId || ""),
    kind,
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
    updated: Number(el.updated || Date.now()),
    index: Number(el.index ?? el.idx ?? 0),
    startBindingId: isConnectorKind
      ? String(el.startBindingId || el.startBinding?.elementId || "")
      : String(el.startBindingId || ""),
    endBindingId: isConnectorKind
      ? String(el.endBindingId || el.endBinding?.elementId || "")
      : String(el.endBindingId || ""),
    frameId: el.frameId ? String(el.frameId) : "",
    containerId: el.containerId ? String(el.containerId) : "",
  };
};

const getAllBoardElements = (boardId) => {
  return Array.from((boardCache.get(boardId) || new Map()).values());
};

// Lightweight in-process mutex to serialize syncs across requests
const withBoardLock = async (boardId, fn) => {
  const id = String(boardId || "");
  return await withDistributedLock(`board-sync:${id}`, fn, 30000);
};

// Mounted health routes
mountHealthRoutes(app);

// Mounted clusters routes
mountClustersRoutes(app, {
  requireAuth,
  ensureOwnsBoard,
  ensureBoardEditor,
  withDistributedLock,
  callHelix,
  toElementsArray,
  dedupeByExternalIdLatest,
  consolidateLabelsIntoShapes,
  clusterCache,
  getAllBoardElements,
  hydrateBoardCacheFromDiskMulti,
  textVecCache,
  bboxOf,
  cosineSim,
  isConnector,
});

// Mounted MCP routes
mountMcpRoutes(app, {
  requireAuth,
  crypto,
  callHelix,
  toElementsArray,
  dedupeByExternalIdLatest,
  withDistributedLock,
});

// ---------------------------------------------------------------------------
// AI proxy passthrough (restored after refactor)
// ---------------------------------------------------------------------------

app.post("/api/ai/engine", requireAuth, async (req, res) => {
  try {
    const target = AI_PROXY_URL.replace(/\/$/, "");
    let body = "";
    for await (const chunk of req) {
      body += chunk;
      if (body.length > 1_000_000) break;
    }
    const headers = {
      "Content-Type": "application/json",
    };
    const auth = req.headers?.authorization;
    if (auth) headers["Authorization"] = String(auth);
    const upstream = await fetch(`${target}/api/ai/engine`, {
      method: "POST",
      headers,
      body,
    });
    // Forward SSE headers
    res.setHeader("Content-Type", upstream.headers.get("content-type") || "text/event-stream");
    res.setHeader(
      "Cache-Control",
      upstream.headers.get("cache-control") || "no-cache, no-transform"
    );
    res.setHeader("Connection", upstream.headers.get("connection") || "keep-alive");
    if (!upstream.body) {
      res.status(upstream.status).end();
      return;
    }
    const reader = upstream.body.getReader();
    const encoder = new TextEncoder();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) {
        try {
          res.write(Buffer.from(value));
        } catch {}
      }
    }
    try {
      res.end();
    } catch {}
  } catch (err) {
    try {
      res
        .status(500)
        .json({ error: "AI proxy failed", details: (err && err.message) || String(err) });
    } catch {}
  }
});

// Mounted canvas routes
import { mountCanvasRoutes } from "./routes/canvas.js";
mountCanvasRoutes(app, {
  requireAuth,
  ensureBoardEditor,
  withBoardLock,
  callHelix,
  toElementsArray,
  MAX_PAYLOAD_BYTES,
  MAX_ELEMENTS_PER_SYNC,
  HELIX_SAFE_MODE,
  BOARDS_DIRS,
  ensureDir,
  fsp,
  path,
  clusterCache,
  boardCache,
  textVecCache,
  saveBoardToDiskMulti,
  saveBoardToDisk,
  hydrateBoardCacheFromDiskMulti,
  normalizeElement,
  getAllBoardElements,
  dedupeByExternalIdLatest,
  consolidateLabelsIntoShapes,
  bboxOf,
  cosineSim,
  toFiniteNumber,
  toFiniteInt,
  // Provide reconciler so routes can prune old elements safely
  reconcileHelixToCache,
});

export const runtimeDependencies = {
  app,
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
  boardCache,
  textVecCache,
  saveBoardToDisk,
  hydrateBoardCacheFromDiskMulti,
  saveBoardToDiskMulti,
  normalizeElement,
  getAllBoardElements,
  bboxOf,
  cosineSim,
  toFiniteNumber,
  toFiniteInt,
  reconcileHelixToCache,
  MAX_ELEMENTS_PER_SYNC,
  MAX_PAYLOAD_BYTES,
  HELIX_SAFE_MODE,
  BOARDS_DIRS,
  ensureDir,
  fsp,
  path,
  withDistributedLock,
};

export const startServer = () =>
  app.listen(PORT, () => {
    debug(`[HelixRAG] Server running on port ${PORT}`);
    debug(`[HelixRAG] Health check: http://localhost:${PORT}/health`);
  });

if (process.argv[1] && process.argv[1] === __filename) {
  startServer();
}
