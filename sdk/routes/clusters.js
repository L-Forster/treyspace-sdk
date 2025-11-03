// Clusters routes - EXACT copy from index.js before refactor

import { generateTextEmbedding } from "../lib/embeddings.js";
import { CLUSTER_CONSTANTS, SPATIAL_CONSTANTS } from "../lib/helpers.js";
import { debug } from "../lib/logger.js";
import crypto from "node:crypto";
import path from "path";
import { promises as fsp } from "fs";

const LOCAL_EMBEDDINGS_ENABLED = String(process.env.LOCAL_EMBEDDINGS || "").trim() === "1";

export function mountClustersRoutes(app, deps) {
  const {
    requireAuth,
    ensureOwnsBoard,
    ensureBoardEditor,
    withDistributedLock,
    callHelix,
    toElementsArray,
    dedupeByExternalIdLatest,
    consolidateLabelsIntoShapes,
    clusterCache,
    textVecCache,
    bboxOf,
    cosineSim,
    isConnector,
    fetchImpl = fetch,
  } = deps;

  const cosineSimilarity = cosineSim;

  // Persistent traversal cache helpers
  const TRAVERSAL_CACHE_DIR = path.resolve(process.cwd(), "sdk/helix/data/traversals");
  const ensureLocalDir = async (dir) => {
    try {
      await fsp.mkdir(dir, { recursive: true });
    } catch {}
  };
  const readTraversalCache = async (boardId) => {
    try {
      const file = path.join(TRAVERSAL_CACHE_DIR, `${String(boardId)}.json`);
      const txt = await fsp.readFile(file, "utf8");
      return JSON.parse(txt);
    } catch {
      return {};
    }
  };
  const writeTraversalCache = async (boardId, obj) => {
    try {
      await ensureLocalDir(TRAVERSAL_CACHE_DIR);
      const file = path.join(TRAVERSAL_CACHE_DIR, `${String(boardId)}.json`);
      await fsp.writeFile(file, JSON.stringify(obj, null, 2), "utf8");
    } catch {}
  };
  const sha256 = (s) =>
    crypto
      .createHash("sha256")
      .update(String(s || ""), "utf8")
      .digest("hex");

  app.post("/api/clusters", requireAuth, async (req, res) => {
    try {
      const { boardId, forceRecompute = false } = req.body;
      if (!boardId) {
        return res.status(400).json({ error: "Missing boardId" });
      }
      // Skip all access checks for AI functionality

      // Use Redis distributed lock to prevent race conditions across PM2 processes
      const result = await withDistributedLock(`clusters:${boardId}`, async () => {
        // Check if we have cached cluster results
        const cachedClusters = clusterCache.get(String(boardId));
        if (!forceRecompute && cachedClusters && cachedClusters.lastComputed) {
          // Check if cache is still fresh (less than 5 minutes old)
          const cacheAge = Date.now() - cachedClusters.lastComputed;
          const CACHE_TTL = CLUSTER_CONSTANTS.CACHE_TTL;

          if (cacheAge < CACHE_TTL) {
            debug(
              `[Clusters] Returning cached results for board ${boardId} (cache age: ${(cacheAge / 1000).toFixed(1)}s)`
            );
            return cachedClusters.result;
          }
        }

        debug(`[Clusters] Starting full re-analysis and element update for board ${boardId}`);

        // STEP 1: CLEAR ALL PREVIOUS CLUSTER ANALYSIS.
        // This now relies on the corrected queries being deployed.
        try {
          debug(`[Clusters] Deleting old analysis edges (Semantic & Spatial)...`);

          // PRODUCTION FIX: Execute delete operations sequentially to prevent race conditions
          // inside the HelixDB server that cause it to crash under load.
          await callHelix("deleteSemanticRelationsForBoard", { boardExtId: boardId });
          await callHelix("deleteSpatialAlignmentsForBoard", { boardExtId: boardId });

          debug(`[Clusters] Previous analysis edges cleared.`);
        } catch (e) {
          console.error(
            `[Clusters] Could not clear old analysis edges: ${e.message}. This may happen if the new queries are not deployed.`
          );
        }

        // STEP 2: FETCH AUTHORITATIVE ELEMENT DATA.
        const allElementsRaw = await callHelix("getBoardElements", {
          boardExtId: boardId,
        });
        const allElements = dedupeByExternalIdLatest(toElementsArray(allElementsRaw));
        // debug("allElementsRaw", allElementsRaw);
        // debug("allElements", allElements);
        // Merge standalone text labels into their containing shapes so cluster members carry text
        const mergedElements = consolidateLabelsIntoShapes(allElements);
        // debug(" mergedElements", mergedElements);
        debug(
          `[Clusters] Counts: raw=${
            Array.isArray(toElementsArray(allElementsRaw))
              ? toElementsArray(allElementsRaw).length
              : 0
          }, deduped=${allElements.length}, merged=${mergedElements.length}`
        );
        const kindCounts = mergedElements.reduce((acc, e) => {
          const k = String(e.kind || "");
          acc[k] = (acc[k] || 0) + 1;
          return acc;
        }, {});

        if (mergedElements.length === 0) {
          const emptyResult = {
            semantic_clusters: [],
            distance_clusters: [],
            relational_clusters: [],
            total_elements: 0,
            total_clusters: 0,
          };

          // Cache empty result too
          clusterCache.set(String(boardId), {
            result: emptyResult,
            lastComputed: Date.now(),
          });

          return emptyResult;
        }
        const elementsByExternalId = new Map(mergedElements.map((el) => [el.externalId, el]));
        // debug("Merged Elements", mergedElements);
        // STEP 3: PERFORM CLUSTERING ANALYSIS.
        const semantic_clusters_calc = [];
        const distance_clusters_calc = [];
        const relational_clusters_calc = [];
        // Multigraph-aware adjacency: use a Set for BFS connectivity, and a count map for multiplicity
        const adjSet = new Map(); // externalId -> Set<neighborExternalId>
        const adjMulti = new Map(); // externalId -> Map<neighborExternalId, count>

        // --- Semantic Clustering ---
        // Only cluster substantive shapes with text (exclude standalone labels and connectors)
        const countWithText = mergedElements.filter(
          (e) => typeof e.text === "string" && e.text.trim()
        ).length;
        const sampleMerged = mergedElements.slice(0, 8).map((e) => ({
          id: e.externalId,
          kind: e.kind,
          text: typeof e.text === "string" ? e.text.slice(0, 60) : "",
        }));
        // debug(`[Clusters] mergedElements=${mergedElements.length}, withText=${countWithText}, sample=`, sampleMerged);

        const exclusionReasons = [];
        const textElements = mergedElements.filter((el) => {
          const hasText = typeof el.text === "string" && el.text.trim().length > 0;
          const k = String(el.kind || el.type || "").toLowerCase();
          const isConn = k === "arrow" || k === "line";
          const keep = hasText && !isConn;
          if (!keep) {
            exclusionReasons.push({ id: el.externalId, kind: k, hasText });
          }
          return keep;
        });
        debug(
          `[Clusters] textElements.count=${textElements.length}. First 10 exclusion reasons:`,
          exclusionReasons.slice(0, 10)
        );

        if (textElements.length > 1) {
          // Build embeddings. Limit concurrency for local backend to avoid OOM.
          const embeddings = [];
          if (LOCAL_EMBEDDINGS_ENABLED) {
            const concurrency = Math.max(1, Number(process.env.LOCAL_EMBED_CONCURRENCY || 4));
            for (let i = 0; i < textElements.length; i += concurrency) {
              const chunk = textElements.slice(i, i + concurrency);
              const chunkResults = await Promise.all(
                chunk.map(async (el) => {
                  try {
                    const embedding = await generateTextEmbedding(el.text);
                    return { element: el, embedding };
                  } catch (e) {
                    console.warn(
                      "[Clusters] Embedding failed for element",
                      el?.externalId,
                      e?.message || e
                    );
                    return { element: el, embedding: [] };
                  }
                })
              );
              embeddings.push(...chunkResults);
            }
          } else {
            for (const el of textElements) {
              try {
                embeddings.push({
                  element: el,
                  embedding: await generateTextEmbedding(el.text),
                });
              } catch (e) {
                console.warn(
                  "[Clusters] Embedding failed for element",
                  el?.externalId,
                  e?.message || e
                );
                embeddings.push({ element: el, embedding: [] });
              }
            }
          }
          const validEmbeddings = embeddings.filter(
            (e) => Array.isArray(e.embedding) && e.embedding.length > 0
          );

          // Coarse bucketing: quantize first 16 dims to 0.25 steps to form a candidate bucket key
          const bucketMap = new Map(); // key -> array of { element, embedding }
          for (const item of validEmbeddings) {
            const vec = item.embedding;
            const key = vec
              .slice(0, Math.min(16, vec.length))
              .map((v) => Math.round(v * 4) / 4)
              .join(",");
            if (!bucketMap.has(key)) bucketMap.set(key, []);
            bucketMap.get(key).push(item);
          }

          const clustered = new Set();
          for (const bucket of bucketMap.values()) {
            if (!Array.isArray(bucket) || bucket.length === 0) continue;
            // Within each bucket, run pairwise comparisons (bucket sizes are small)
            for (let i = 0; i < bucket.length; i++) {
              const baseId = bucket[i].element.externalId;
              if (clustered.has(baseId)) {
                continue;
              }
              const clusterMembers = [bucket[i].element];
              clustered.add(baseId);
              for (let j = i + 1; j < bucket.length; j++) {
                const candId = bucket[j].element.externalId;
                if (clustered.has(candId)) {
                  continue;
                }
                if (cosineSimilarity(bucket[i].embedding, bucket[j].embedding) >= CLUSTER_CONSTANTS.SEMANTIC_SIMILARITY_THRESHOLD) {
                  clusterMembers.push(bucket[j].element);
                  clustered.add(candId);
                }
              }
              if (clusterMembers.length >= 2) {
                semantic_clusters_calc.push({
                  members: clusterMembers,
                  memberIds: clusterMembers.map((el) => el.externalId),
                });
              }
            }
          }
        }
        // debug(`[Clusters] semantic_clusters_calc.count=${semantic_clusters_calc.length}`);
        // --- Distance Clustering ---
        // Proportional distance based on element sizes

        const proportionalDistance = (a, b) => {
          // Use element properties directly since bboxOf might not work with merged elements
          const ax = Number(a.x || 0);
          const ay = Number(a.y || 0);
          const aw = Number(a.width || a.w || 0);
          const ah = Number(a.height || a.h || 0);

          const bx = Number(b.x || 0);
          const by = Number(b.y || 0);
          const bw = Number(b.width || b.w || 0);
          const bh = Number(b.height || b.h || 0);

          const acx = ax + aw / 2;
          const acy = ay + ah / 2;
          const bcx = bx + bw / 2;
          const bcy = by + bh / 2;

          const centerDist = Math.hypot(acx - bcx, acy - bcy);

          // Calculate average element size for proportional threshold
          const avgSize = (aw + ah + (bw + bh)) / 4;
          const sizeBasedThreshold = Math.max(50, avgSize * 2);

          return centerDist / sizeBasedThreshold;
        };

        debug(`[DEBUG] Starting distance clustering with ${mergedElements.length} elements`);

        // Check some sample distances
        if (mergedElements.length >= 2) {
          const sampleDistances = [];
          for (let i = 0; i < Math.min(5, mergedElements.length); i++) {
            for (let j = i + 1; j < Math.min(i + 3, mergedElements.length); j++) {
              const dist = proportionalDistance(mergedElements[i], mergedElements[j]);
              sampleDistances.push({ i, j, dist });
            }
          }
          debug(`[DEBUG] Sample distances:`, sampleDistances);
        }

        // Build a simple uniform grid spatial index to avoid O(n^2) scans
        const cellSize = CLUSTER_CONSTANTS.CELL_SIZE; // px; slightly larger grid to reduce candidate set and recursion
        const cellKeyOf = (x, y) => `${Math.floor(x / cellSize)},${Math.floor(y / cellSize)}`;
        const grid = new Map(); // key -> array of element
        for (const el of mergedElements) {
          const cx = Number(el.x || 0);
          const cy = Number(el.y || 0);
          const key = cellKeyOf(cx, cy);
          if (!grid.has(key)) grid.set(key, []);
          grid.get(key).push(el);
        }

        const neighborsFromGrid = (el) => {
          const cx = Math.floor(Number(el.x || 0) / cellSize);
          const cy = Math.floor(Number(el.y || 0) / cellSize);
          const out = [];
          for (let dx = -1; dx <= 1; dx++) {
            for (let dy = -1; dy <= 1; dy++) {
              const arr = grid.get(`${cx + dx},${cy + dy}`);
              if (Array.isArray(arr) && arr.length) {
                for (const cand of arr) out.push(cand);
              }
            }
          }
          return out;
        };

        const visitedDistance = new Set();
        for (const element of mergedElements) {
          if (visitedDistance.has(element.externalId)) {
            continue;
          }

          const clusterMembers = [element];
          const queue = [element];
          visitedDistance.add(element.externalId);

          let iterations = 0;
          const MAX_ITERS = Number(process.env.CLUSTER_MAX_ITERS || 20000);
          while (queue.length > 0) {
            iterations++;
            if (iterations > MAX_ITERS) {
              console.warn("[Clusters] Distance BFS early stop due to MAX_ITERS");
              break;
            }
            const current = queue.shift();
            // Only consider close-by candidates from grid
            const candidates = neighborsFromGrid(current);
            for (const neighbor of candidates) {
              if (visitedDistance.has(neighbor.externalId)) {
                continue;
              }
              // quick reject: bounding box centers further than 4*cellSize apart
              const fastDx = Math.abs(
                Number(current.x || 0) +
                  Number(current.w || current.width || 0) / 2 -
                  (Number(neighbor.x || 0) + Number(neighbor.w || neighbor.width || 0) / 2)
              );
              const fastDy = Math.abs(
                Number(current.y || 0) +
                  Number(current.h || current.height || 0) / 2 -
                  (Number(neighbor.y || 0) + Number(neighbor.h || neighbor.height || 0) / 2)
              );
              if (fastDx > 4 * cellSize || fastDy > 4 * cellSize) {
                continue;
              }
              const distance = proportionalDistance(current, neighbor);
              if (distance < 1.0) {
                // Proportional threshold of 1.0
                clusterMembers.push(neighbor);
                queue.push(neighbor);
                visitedDistance.add(neighbor.externalId);
              }
            }
          }

          if (clusterMembers.length > 1) {
            debug(`[DEBUG] Found distance cluster with ${clusterMembers.length} members`);
            distance_clusters_calc.push({
              members: clusterMembers,
              memberIds: clusterMembers.map((el) => el.externalId),
            });
          }
        }
        debug(`[Clusters] distance_clusters_calc.count=${distance_clusters_calc.length}`);

        // --- Relational Clustering ---
        // Build adjacency using arrow connectors (dedup + normalized IDs); persist RELATIONALLY_ALIGNED edges with labels from arrow.text/link
        // debug("allElements", allElements);
        const relationalEdgeWrites = [];
        const clean = (s) =>
          typeof s === "string"
            ? s
                .replace(/\r?\n|\t/g, " ")
                .replace(/\s+/g, " ")
                .trim()
            : "";
        const intToExt = new Map(
          allElements.map((e) => [String(e.id || e.ID || ""), String(e.externalId || "")])
        );
        const normalizeToExt = (raw) => {
          const id = String(raw || "");
          if (!id) {
            return "";
          }
          if (elementsByExternalId.has(id)) {
            return id;
          }
          return intToExt.get(id) || "";
        };
        // Skip prefill - build adjacency only from arrows to avoid corrupted self-loops
        debug("[Clusters] Building adjacency only from arrows (no prefill from HelixDB)");
        const arrowMap = new Map();
        for (const el of allElements) {
          if (el && isConnector(el) && el.startBindingId && el.endBindingId) {
            const key = String(el.externalId || el.id || "");
            if (!arrowMap.has(key)) {
              debug(
                `[Clusters] Arrow ${el.externalId} raw bindings: start=${el.startBindingId}, end=${el.endBindingId}`
              );
              arrowMap.set(key, el);
            }
          }
        }
        debug(`[Clusters] Processing ${arrowMap.size} arrows for adjacency building...`);
        for (const conn of arrowMap.values()) {
          const a = normalizeToExt(conn.startBindingId);
          const b = normalizeToExt(conn.endBindingId);
          debug(
            `[Clusters] Arrow ${conn.externalId}: startBinding=${conn.startBindingId} -> ${a}, endBinding=${conn.endBindingId} -> ${b}`
          );

          // Connector label only from connector.text (client is source of truth)
          const label = (typeof conn.text === "string" ? conn.text : "").trim();
          // Only connect if both endpoints exist as elements (use merged presence)
          if (elementsByExternalId.has(a) && elementsByExternalId.has(b) && a !== b) {
            debug(`[Clusters] Creating connection: ${a} <-> ${b}`);
            // Update BFS adjacency (set-based)
            if (!adjSet.has(a)) {
              adjSet.set(a, new Set());
            }
            if (!adjSet.has(b)) {
              adjSet.set(b, new Set());
            }
            adjSet.get(a).add(b);
            adjSet.get(b).add(a);
            // Update multigraph counts for connectivity metric
            if (!adjMulti.has(a)) {
              adjMulti.set(a, new Map());
            }
            if (!adjMulti.has(b)) {
              adjMulti.set(b, new Map());
            }
            adjMulti.get(a).set(b, (adjMulti.get(a).get(b) || 0) + 1);
            adjMulti.get(b).set(a, (adjMulti.get(b).get(a) || 0) + 1);
            // Stage DB edges (RELATIONALLY_ALIGNED) between a and b
            const aInt = mergedElements.find((e) => e.externalId === a)?.id;
            const bInt = mergedElements.find((e) => e.externalId === b)?.id;
            if (aInt && bInt) {
              relationalEdgeWrites.push(
                callHelix("addRelationalAlignment", {
                  sourceId: String(aInt),
                  targetId: String(bInt),
                  via: String(conn.externalId || conn.id || ""),
                  edgeLabel: String(label || ""),
                })
              );
            }
          } else {
            debug(
              `[Clusters] Skipping arrow ${
                conn.externalId
              }: a=${a} (exists: ${elementsByExternalId.has(
                a
              )}), b=${b} (exists: ${elementsByExternalId.has(b)}), same: ${a === b}`
            );
          }
        }

        // Debug: Log adjacency structure
        debug("[Clusters] Adjacency debug - total nodes with connections:", adjSet.size);
        for (const [nodeId, neighbors] of adjSet.entries()) {
          if (neighbors.size > 0) {
            const nodeEl = elementsByExternalId.get(nodeId);
            debug(
              `[Clusters] ${nodeId} (${nodeEl?.kind || "unknown"}) connects to:`,
              Array.from(neighbors)
            );
          }
        }

        const visitedRelation = new Set();
        // Seeds must include both adjacency keys and neighbor ids, or sinks get dropped
        const seedNodes = new Set();
        for (const [nodeId, neighbors] of adjSet.entries()) {
          seedNodes.add(nodeId);
          for (const n of neighbors) {
            seedNodes.add(n);
          }
        }
        for (const elementId of seedNodes) {
          const startElement = elementsByExternalId.get(elementId);
          // Only start traversal from non-connector elements
          if (
            !visitedRelation.has(elementId) &&
            startElement &&
            startElement.kind !== "arrow" &&
            startElement.kind !== "line"
          ) {
            // Collect connected component of ACTUAL elements only (no connectors)
            const component = [];
            const stack = [elementId];
            debug(`[Clusters] Starting traversal from ${elementId} (${startElement.kind})`);

            while (stack.length > 0) {
              const nodeId = stack.pop();
              if (visitedRelation.has(nodeId)) {
                continue;
              }
              visitedRelation.add(nodeId);

              const nodeEl = elementsByExternalId.get(nodeId);
              if (nodeEl && nodeEl.kind !== "arrow" && nodeEl.kind !== "line") {
                component.push(nodeEl);
                debug(
                  `[Clusters] Added to component: ${nodeId} (${nodeEl.kind}) - "${
                    nodeEl.text || ""
                  }"`
                );
              }

              const neighborSet = adjSet.get(nodeId) || new Set();
              for (const neighborId of neighborSet) {
                if (!visitedRelation.has(neighborId)) {
                  stack.push(neighborId);
                }
              }
            }

            if (component.length > 1) {
              debug(
                `[Clusters] Created relational cluster with ${component.length} members:`,
                component.map((c) => `${c.externalId}(${c.kind})`)
              );
              relational_clusters_calc.push({
                members: component,
                memberIds: component.map((el) => el.externalId),
              });
            } else if (component.length === 1) {
              debug(
                `[Clusters] Skipped single-element cluster: ${component[0].externalId}(${component[0].kind})`
              );
            }
          }
        }
        debug(`[Clusters] relational_clusters_calc.count=${relational_clusters_calc.length}`);
        // STEP 4: Create element-to-cluster assignment map.
        const elementClusterAssignments = new Map();
        // ... (This logic remains correct)
        semantic_clusters_calc.forEach((c, i) =>
          c.memberIds.forEach((id) => {
            if (!elementClusterAssignments.has(id)) {
              elementClusterAssignments.set(id, {});
            }
            elementClusterAssignments.get(id).semanticClusterId = `s_${i + 1}`;
          })
        );
        distance_clusters_calc.forEach((c, i) =>
          c.memberIds.forEach((id) => {
            if (!elementClusterAssignments.has(id)) {
              elementClusterAssignments.set(id, {});
            }
            elementClusterAssignments.get(id).distanceClusterId = `d_${i + 1}`;
          })
        );
        relational_clusters_calc.forEach((c, i) =>
          c.memberIds.forEach((id) => {
            if (!elementClusterAssignments.has(id)) {
              elementClusterAssignments.set(id, {});
            }
            elementClusterAssignments.get(id).relationalClusterId = `r_${i + 1}`;
          })
        );

        debug(`[Clusters] Assignment map size=${elementClusterAssignments.size}`);
        // STEP 5: UPDATE ONLY ELEMENTS WITH CHANGED CLUSTER ASSIGNMENTS
        // Build a map of current cluster assignments to detect changes
        const currentAssignments = new Map();
        for (const element of allElements) {
          if (element?.externalId) {
            currentAssignments.set(String(element.externalId), {
              semanticClusterId: element.semanticClusterId || "",
              distanceClusterId: element.distanceClusterId || "",
              relationalClusterId: element.relationalClusterId || "",
            });
          }
        }

        const updatePromises = [];
        let unchangedCount = 0;

        for (const [externalId, element] of elementsByExternalId.entries()) {
          const newAssignments = elementClusterAssignments.get(externalId) || {};
          const currentClusterIds = currentAssignments.get(externalId) || {};

          const newSemanticId = newAssignments.semanticClusterId || "";
          const newDistanceId = newAssignments.distanceClusterId || "";
          const newRelationalId = newAssignments.relationalClusterId || "";

          // Only update if cluster assignments have changed
          const hasChanged =
            currentClusterIds.semanticClusterId !== newSemanticId ||
            currentClusterIds.distanceClusterId !== newDistanceId ||
            currentClusterIds.relationalClusterId !== newRelationalId;

          if (!hasChanged) {
            unchangedCount++;
            continue;
          }

          // Element has changed - update with ALL required fields (HelixDB requires complete data)
          if (element.id) {
            // Ensure kind is never empty - HelixDB requires this field
            const elemKind =
              element.kind && String(element.kind).trim() ? String(element.kind) : "text";

            updatePromises.push(
              callHelix("updateElementById", {
                elementId: String(element.id),
                kind: elemKind,
                short_id: String(element.short_id || ""),
                x: Number(element.x || 0),
                y: Number(element.y || 0),
                w: Number(element.w || 0),
                h: Number(element.h || 0),
                angle: Number(element.angle || 0),
                strokeColor: String(element.strokeColor || ""),
                backgroundColor: String(element.backgroundColor || ""),
                strokeWidth: Number(element.strokeWidth || 1),
                fillStyle: String(element.fillStyle || ""),
                roughness: Number(element.roughness || 0),
                opacity: Number(element.opacity || 100),
                text: String(element.text || ""),
                link: String(element.link || ""),
                locked: Boolean(element.locked),
                version: Number(element.version || 0),
                updated: Number(element.updated || 0),
                index: Number(element.index || 0),
                startBindingId: String(element.startBindingId || ""),
                endBindingId: String(element.endBindingId || ""),
                semanticClusterId: newSemanticId,
                distanceClusterId: newDistanceId,
                relationalClusterId: newRelationalId,
              })
            );
          }
        }

        debug(
          `[Clusters] Elements to update: ${updatePromises.length}, unchanged: ${unchangedCount}`
        );

        // PRODUCTION FIX: Sequential writes to prevent race conditions in HelixDB
        debug(
          `[Clusters] Starting sequential update of ${updatePromises.length} changed elements...`
        );
        for (const p of updatePromises) {
          await p;
        }

        debug(
          `[Clusters] Starting sequential write of ${relationalEdgeWrites.length} relational edges...`
        );
        for (const p of relationalEdgeWrites) {
          await p;
        }

        debug(
          `[Clusters] DB Update Complete: ${updatePromises.length} elements + ${relationalEdgeWrites.length} edges updated.`
        );

        // STEP 6: FORMAT AND RETURN THE RESPONSE.
        const formatClusterResponse = (cluster, id, type) => {
          const minX = Math.min(...cluster.members.map((e) => e.x));
          const minY = Math.min(...cluster.members.map((e) => e.y));
          const maxX = Math.max(...cluster.members.map((e) => e.x + (e.w || 0)));
          const maxY = Math.max(...cluster.members.map((e) => e.y + (e.h || 0)));
          const boundingBox = {
            x: minX,
            y: minY,
            width: maxX - minX,
            height: maxY - minY,
          };
          const element_type_counts = cluster.members.reduce(
            (acc, m) => ({ ...acc, [m.kind]: (acc[m.kind] || 0) + 1 }),
            {}
          );
          const cleanText = (s) =>
            typeof s === "string"
              ? s
                  .replace(/\r?\n|\t/g, " ")
                  .replace(/\s+/g, " ")
                  .trim()
              : "";
          const texts = cluster.members.map((m) => cleanText(m.text)).filter((t) => t);
          const colors = [
            ...new Set(
              cluster.members.map((m) => m.strokeColor || m.backgroundColor).filter(Boolean)
            ),
          ];

          return {
            id,
            type,
            member_count: cluster.members.length,
            member_ids: cluster.memberIds,
            members: cluster.members.map((m) => ({
              id: m.externalId,
              kind: m.kind,
              text: typeof m.text === "string" ? m.text : "",
            })),
            bounding_box: boundingBox,
            element_type_counts,
            sample_texts: texts.slice(0, 5),
            colors_present: colors.slice(0, 10),
          };
        };

        const semantic_clusters = semantic_clusters_calc.map((c, i) =>
          formatClusterResponse(c, `s_${i + 1}`, "semantic")
        );
        const distance_clusters = distance_clusters_calc.map((c, i) =>
          formatClusterResponse(c, `d_${i + 1}`, "distance")
        );
        const relational_clusters = relational_clusters_calc.map((c, i) =>
          formatClusterResponse(c, `r_${i + 1}`, "relational")
        );

        const totalClusters =
          semantic_clusters.length + distance_clusters.length + relational_clusters.length;

        const result = {
          semantic_clusters,
          distance_clusters,
          relational_clusters,
          total_elements: mergedElements.length,
          total_clusters: totalClusters,
        };

        // Cache the result
        clusterCache.set(String(boardId), {
          result,
          lastComputed: Date.now(),
        });

        return result;
      });

      if (!res.headersSent) {
        return res.json(result);
      }
    } catch (err) {
      console.error("[Clusters] Error:", err);
      if (!res.headersSent) {
        return res.status(500).json({
          error: "Cluster analysis failed",
          details: err.message,
        });
      }
    }
  });

  app.post("/api/clusters/refresh", requireAuth, async (req, res) => {
    try {
      const { boardId } = req.body;
      if (!boardId) {
        return res.status(400).json({ error: "Missing boardId" });
      }
      const accessMeta = await ensureBoardEditor(req, res, boardId);
      if (!accessMeta) return;
      clusterCache.delete(String(boardId));
      const response = await fetchImpl(`${req.protocol}://${req.get("host")}/api/clusters`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: req.headers.authorization },
        body: JSON.stringify({ boardId, forceRecompute: true }),
      });
      const result = await response.json();
      res.json(result);
    } catch (error) {
      res.status(500).json({ error: "Failed to refresh clusters", details: error.message });
    }
  });

  app.post("/api/clusters/traverse", requireAuth, async (req, res) => {
    try {
      const { boardId, cluster_id } = req.body;
      if (!boardId || !cluster_id) {
        return res.status(400).json({ error: "boardId and cluster_id are required" });
      }
      const accessMeta = await ensureBoardEditor(req, res, boardId);
      if (!accessMeta) return;

      // Local helpers (scoped): match canonical logic from index.js
      const normalizeKind = (el) => String(el?.kind || el?.type || "").toLowerCase();
      const clean = (s) =>
        typeof s === "string"
          ? s
              .replace(/\r?\n|\t/g, " ")
              .replace(/\s+/g, " ")
              .trim()
          : "";
      const visualDistanceBetweenBoxes = (boxA, boxB) => {
        if (!boxA || !boxB) return Infinity;
        const centerA = { x: boxA.x + boxA.width / 2, y: boxA.y + boxA.height / 2 };
        const centerB = { x: boxB.x + boxB.width / 2, y: boxB.y + boxB.height / 2 };
        const gapX = Math.max(
          0,
          Math.abs(centerA.x - centerB.x) - (boxA.width / 2 + boxB.width / 2)
        );
        const gapY = Math.max(
          0,
          Math.abs(centerA.y - centerB.y) - (boxA.height / 2 + boxB.height / 2)
        );
        return Math.sqrt(gapX * gapX + gapY * gapY);
      };

      // Wait for any active cluster analysis to complete to ensure consistent reads
      const result = await withDistributedLock(`clusters:${boardId}`, async () => {
        // STEP 1: FETCH ALL ELEMENTS.
        const allElementsRaw = await callHelix("getBoardElements", { boardExtId: boardId });
        const allElements = dedupeByExternalIdLatest(toElementsArray(allElementsRaw));
        if (allElements.length < 2) {
          return { connections: [], message: "Not enough elements to analyze." };
        }

        // Merge standalone text labels into their containers so shapes/connectors carry text
        const mergedElements = consolidateLabelsIntoShapes(allElements);
        const elementsByExternalId = new Map(mergedElements.map((el) => [el.externalId, el]));

        // STEP 2: USE EXISTING CLUSTER ASSIGNMENTS TO DETERMINE MEMBERS
        const [type] = String(cluster_id).split("_");
        const clusterProp =
          type === "r"
            ? "relationalClusterId"
            : type === "s"
              ? "semanticClusterId"
              : "distanceClusterId";
        const members = mergedElements.filter(
          (el) => el && el.kind !== "arrow" && String(el[clusterProp] || "") === String(cluster_id)
        );
        if (members.length === 0) {
          return {
            cluster_id,
            cluster_type: type === "r" ? "relational" : type === "s" ? "semantic" : "distance",
            counts: { members: 0 },
            members: [],
            connections: [],
          };
        }

        const memberIdSet = new Set(members.map((m) => String(m.externalId)));

        // Persistent cache signature: boardId, cluster_id, algorithm version, member digests, connector digests
        const algoVersion = "traverse_v1";
        const memberDigest = members
          .map((m) => `${m.externalId}:${Number(m.updated || 0)}:${Number(m.version || 0)}`)
          .sort()
          .join("|");

        // If semantic ('s') or distance ('d'), return cluster members (no edge traversal)
        if (type !== "r") {
          const elementTypeCounts = members.reduce((acc, m) => {
            const k = String(m?.kind || "unknown");
            acc[k] = (acc[k] || 0) + 1;
            return acc;
          }, {});
          return {
            cluster_id,
            cluster_type: type === "s" ? "semantic" : "distance",
            counts: { members: members.length },
            element_type_counts: elementTypeCounts,
            members,
            connections: [],
          };
        }

        const findTextForShape = (shape) => {
          if (!shape) return "";
          let combinedText = shape.text || "";
          const shapeBox = bboxOf(shape);
          for (const el of allElements) {
            if (normalizeKind(el) === "text" && el.text) {
              const labelBox = bboxOf(el);
              const labelCenter = { x: labelBox.cx, y: labelBox.cy };
              if (
                labelCenter.x >= shapeBox.minX &&
                labelCenter.x <= shapeBox.maxX &&
                labelCenter.y >= shapeBox.minY &&
                labelCenter.y <= shapeBox.maxY
              ) {
                const newText = el.text.trim();
                if (!combinedText.includes(newText)) {
                  combinedText = `${combinedText} ${newText}`.trim();
                }
              }
            }
          }
          return clean(combinedText);
        };

        // STEP 3: GATHER EDGES STRICTLY FROM CONNECTOR ELEMENTS (ARROWS + LINES)
        const connections = [];
        const arrowMap = new Map();
        for (const el of mergedElements) {
          if (el && isConnector(el) && el.startBindingId && el.endBindingId) {
            const key = String(el.externalId || el.id || "");
            if (!arrowMap.has(key)) arrowMap.set(key, el);
          }
        }
        const arrows = Array.from(arrowMap.values());

        const toExt = (raw) => {
          const id = String(raw || "");
          if (!id) return "";
          if (elementsByExternalId.has(id)) return id;
          const byInternal = mergedElements.find((e) => String(e.id || e.ID) === id);
          return byInternal ? String(byInternal.externalId) : "";
        };
        const connectorDigest = arrows
          .filter((a) => {
            const aExt = toExt(a.startBindingId);
            const bExt = toExt(a.endBindingId);
            return aExt && bExt && memberIdSet.has(aExt) && memberIdSet.has(bExt);
          })
          .map((a) => `${a.externalId || a.id}:${Number(a.updated || 0)}:${Number(a.version || 0)}`)
          .sort()
          .join("|");
        const signature = sha256(
          `${boardId}|${cluster_id}|${algoVersion}|${memberDigest}|${connectorDigest}`
        );

        try {
          const fileCache = await readTraversalCache(boardId);
          const hit = fileCache && fileCache[signature];
          if (hit) {
            return hit;
          }
        } catch {}
        const normalizeToExt = (raw) => {
          const id = String(raw || "");
          if (!id) return "";
          if (elementsByExternalId.has(id)) return id;
          const byInternal = mergedElements.find((e) => String(e.id || e.ID) === id);
          return byInternal ? String(byInternal.externalId) : "";
        };

        const edgeType =
          type === "r"
            ? "RELATIONALLY_ALIGNED"
            : type === "s"
              ? "SEMANTICALLY_RELATED"
              : "SPATIALLY_ALIGNED";

        for (const arrow of arrows) {
          const a = normalizeToExt(arrow.startBindingId);
          const b = normalizeToExt(arrow.endBindingId);
          if (!a || !b || !memberIdSet.has(a) || !memberIdSet.has(b)) continue;
          const fromNode = elementsByExternalId.get(a);
          const toNode = elementsByExternalId.get(b);
          if (!fromNode || !toNode) continue;

          const baseConn = {
            from: a,
            to: b,
            type: edgeType,
            directed: normalizeKind(arrow) === "arrow",
            via: String(arrow.externalId || arrow.id || ""),
            from_kind: fromNode?.kind,
            to_kind: toNode?.kind,
            from_x: Number((fromNode?.x || 0) + (fromNode?.w || fromNode?.width || 0) / 2),
            from_y: Number((fromNode?.y || 0) + (fromNode?.h || fromNode?.height || 0) / 2),
            to_x: Number((toNode?.x || 0) + (toNode?.w || toNode?.width || 0) / 2),
            to_y: Number((toNode?.y || 0) + (toNode?.h || toNode?.height || 0) / 2),
            from_stroke: fromNode?.strokeColor,
            from_fill: fromNode?.backgroundColor,
            to_stroke: toNode?.strokeColor,
            to_fill: toNode?.backgroundColor,
            distance: Math.round(visualDistanceBetweenBoxes(bboxOf(fromNode), bboxOf(toNode))),
            // More robust label detection
            from_label: findTextForShape(fromNode),
            to_label: findTextForShape(toNode),
            connector_label: findTextForShape(arrow),
          };
          connections.push(baseConn);
        }

        // STEP 4: DEDUPE ONLY EXACT DUPLICATES BY (via), PRESERVE DIRECTION AND MULTIGRAPH
        const byVia = new Map();
        for (const c of connections) {
          const key = String(c.via || "");
          if (!byVia.has(key)) byVia.set(key, c);
        }
        const finalConnections = Array.from(byVia.values());

        const clusterTypeStr = type === "r" ? "relational" : type === "s" ? "semantic" : "distance";
        const out = {
          cluster_id,
          cluster_type: clusterTypeStr,
          counts: { members: members.length },
          members: req.body?.include_members ? members : undefined,
          connections: finalConnections,
        };
        try {
          const cacheObj = (await readTraversalCache(boardId)) || {};
          cacheObj[signature] = { ...out, members };
          await writeTraversalCache(boardId, cacheObj);
        } catch {}
        return out;
      });

      if (!res.headersSent) {
        res.json(result);
      }
    } catch (error) {
      try {
        console.error("[Cluster Traverse Error]:", error);
      } catch {}
      if (!res.headersSent) {
        res.status(500).json({
          error: "Failed to traverse cluster",
          details: error?.message || "Unknown error",
        });
      }
    }
  });
}

export default mountClustersRoutes;
