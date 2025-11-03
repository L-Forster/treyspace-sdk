// Canvas routes (sync + context) extracted without behaviour changes

import { debug } from "../lib/logger.js";

export function mountCanvasRoutes(app, deps) {
  const {
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
    // prefer multi-dir aware wrappers if provided by index
    saveBoardToDiskMulti,
    saveBoardToDisk = async () => {},
    hydrateBoardCacheFromDiskMulti,
    normalizeElement,
    getAllBoardElements,
    dedupeByExternalIdLatest,
    consolidateLabelsIntoShapes,
    bboxOf,
    cosineSim,
    toFiniteNumber,
    toFiniteInt,
    reconcileHelixToCache,
  } = deps;

  // Atomic JSON writer to prevent partial/corrupt files during concurrent saves
  const writeJsonAtomic = async (filePath, obj) => {
    try {
      const dir = path.dirname(filePath);
      const base = path.basename(filePath);
      const tmp = path.join(dir, `.${base}.${Date.now()}.tmp`);
      const text = JSON.stringify(obj, null, 2);
      await fsp.writeFile(tmp, text, "utf8");
      await fsp.rename(tmp, filePath);
    } catch {}
  };

  app.post("/api/canvas/sync", requireAuth, async (req, res) => {
    try {
      const { boardId, elements, deletedIds = [], opts = {}, excalidrawData } = req.body;
      if (!boardId) return res.status(400).json({ error: "Missing boardId" });
      const accessMeta = await ensureBoardEditor(req, res, boardId);
      if (!accessMeta) return;

      if (excalidrawData) {
        await withBoardLock(boardId, async () => {
          // Treat incoming excalidrawData as authoritative full snapshot:
          // normalize elements -> update cache -> persist to disk including raw excalidrawData for loaders
          const incoming = Array.isArray(excalidrawData.elements) ? excalidrawData.elements : [];
          const boardMap = new Map();
          for (const element of incoming) {
            if (element && element.id) {
              // Skip deleted elements entirely
              if (element.isDeleted === true) continue;
              const normalized = normalizeElement({
                ...element,
                externalId: element.id,
                boardId: String(boardId),
                kind: element.type,
              });
              if (normalized) boardMap.set(String(element.id), normalized);
            }
          }
          boardCache.set(boardId, boardMap);
          const snapshotIds = new Set(boardMap.keys());

          // Persist to all known writable dirs; include both items and filtered excalidrawData (no isDeleted)
          try {
            const items = Array.from(boardMap.values());
            const filteredExcalidraw = {
              ...excalidrawData,
              elements: incoming.filter((el) => el && el.id && el.isDeleted !== true),
            };
            const fileData = {
              id: String(boardId),
              items,
              savedAt: Date.now(),
              excalidrawData: filteredExcalidraw,
            };
            // Write to preferred dirs
            for (const dir of BOARDS_DIRS) {
              try {
                await ensureDir(dir);
                const filePath = path.join(dir, `${String(boardId)}.json`);
                await writeJsonAtomic(filePath, fileData);
              } catch {}
            }
          } catch {}

          // Prune old elements in Helix to match this authoritative snapshot
          try {
            if (!HELIX_SAFE_MODE && typeof reconcileHelixToCache === "function") {
              await reconcileHelixToCache(String(boardId), { snapshotIds });
            }
          } catch {}
        });

        return res.json({ success: true, message: "Excalidraw data saved" });
      }

      if (!Array.isArray(elements))
        return res.status(400).json({ error: "Missing elements array" });
      try {
        await callHelix("ensureBoard", { boardExtId: String(boardId) });
      } catch {}
      const sizeBytes = Buffer.byteLength(JSON.stringify(req.body || {}));
      if (sizeBytes > MAX_PAYLOAD_BYTES)
        return res.status(413).json({ error: "Payload too large" });
      if (elements.length > MAX_ELEMENTS_PER_SYNC)
        return res.status(422).json({ error: `Too many elements. Max ${MAX_ELEMENTS_PER_SYNC}` });

      await withBoardLock(boardId, async () => {
        if ((elements && elements.length > 0) || (deletedIds && deletedIds.length > 0)) {
          clusterCache.delete(String(boardId));
        }
        if (opts?.fullSnapshot) {
          boardCache.set(boardId, new Map());
          textVecCache.set(boardId, new Map());
          clusterCache.delete(String(boardId));
          try {
            if (!HELIX_SAFE_MODE) {
              await callHelix("deleteAllBoardRelations", { boardExtId: String(boardId) });
              await callHelix("deleteBoardElements", { boardExtId: String(boardId) });
            }
          } catch {}
        }

        const boardMap = boardCache.get(boardId) || new Map();
        if (opts?.fullSnapshot) boardMap.clear();
        // Apply deletions immediately to cache and Helix
        if (Array.isArray(deletedIds) && deletedIds.length > 0) {
          for (const id of deletedIds) {
            boardMap.delete(String(id));
            try {
              if (!HELIX_SAFE_MODE) {
                await callHelix("deleteElement", {
                  boardExtId: String(boardId),
                  elementExtId: String(id),
                });
              }
            } catch {}
          }
          boardCache.set(boardId, boardMap);
          // If deletions-only, persist to disk and exit
          if (!elements || elements.length === 0) {
            try {
              if (typeof saveBoardToDiskMulti === "function") {
                await saveBoardToDiskMulti(boardId);
              } else {
                await saveBoardToDisk(boardId);
              }
            } catch {}
            // Optional prune: ensure Helix has no extras after deletions-only sync
            try {
              if (!HELIX_SAFE_MODE && typeof reconcileHelixToCache === "function") {
                await reconcileHelixToCache(String(boardId));
              }
            } catch {}
            return res.json({
              success: true,
              upserts: 0,
              deleted: deletedIds.length,
              helixEmpty: false,
              requestFullSnapshot: false,
            });
          }
        }
        const cacheBackup = new Map(boardCache.get(boardId) || new Map());
        const targetSnapshot =
          opts?.fullSnapshot === true
            ? new Set(
                Array.isArray(elements)
                  ? elements
                      .filter((el) => el?.id && el.isDeleted !== true)
                      .map((el) => String(el.id))
                  : []
              )
            : null;

        let needsFullSnapshot = false;
        let helixWasEmpty = false;
        try {
          const cacheSize = cacheBackup.size;
          const currentInHelix = await callHelix("getBoardElements", {
            boardExtId: String(boardId),
          });
          const helixCount = toElementsArray(currentInHelix).length;
          if (cacheSize === 0 && helixCount > 0) {
            // Server restart detected: cache empty while Helix has data → request full snapshot to realign client and server
            console.warn(
              `[Sync] SERVER RESTART DETECTED: Cache empty (${cacheSize}) but HelixDB has ${helixCount} elements. Requesting full snapshot.`
            );
            needsFullSnapshot = true;
            const helixElements = toElementsArray(currentInHelix);
            const tempCache = new Map();
            for (const el of helixElements)
              if (el?.externalId) tempCache.set(String(el.externalId), el);
            boardCache.set(boardId, tempCache);
          } else if (helixCount === 0) {
            helixWasEmpty = true;
            if (typeof hydrateBoardCacheFromDiskMulti === "function") {
              await hydrateBoardCacheFromDiskMulti(boardId);
            }
            try {
              await callHelix("deleteAllBoardRelations", { boardExtId: String(boardId) });
              await callHelix("deleteBoardElements", { boardExtId: String(boardId) });
            } catch {}
            debug(
              `[Sync] Helix empty for board ${boardId}. Will rebuild from incoming snapshot.`
            );
          }
        } catch {}

        let helixOperationsSuccessful = false;
        try {
          debug(`[Sync] Starting HelixDB operations for ${elements?.length || 0} elements`);
          const externalIdToInternalId = new Map();
          const arrowsToProcess = [];
          const safeI64 = (v, def = 0) => {
            const n = Number(v);
            return Number.isFinite(n) ? Math.floor(n) : def;
          };
          for (const element of elements) {
            const labelText = typeof element.text === "string" ? element.text : "";
            // Skip deleted elements entirely
            if (element && element.isDeleted === true) {
              continue;
            }
            const startBindExt = String(
              element.startBindingId || element.startBinding?.elementId || ""
            );
            const endBindExt = String(element.endBindingId || element.endBinding?.elementId || "");
            const elementKind =
              element.type && String(element.type).trim() ? String(element.type) : "text";
            const params = {
              externalId: String(element.id || ""),
              boardId: String(boardId),
              kind: elementKind,
              short_id: element.id ? String(element.id).slice(0, 8) : "",
              x: Number(element.x ?? 0),
              y: Number(element.y ?? 0),
              w: Number(element.width ?? 0),
              h: Number(element.height ?? 0),
              angle: Number(element.angle ?? 0),
              strokeColor: element.strokeColor || "#000000",
              backgroundColor: element.backgroundColor || "transparent",
              strokeWidth: safeI64(element.strokeWidth, 1),
              fillStyle: element.fillStyle || "solid",
              roughness: safeI64(element.roughness, 0),
              opacity: safeI64(element.opacity, 100),
              text: String(labelText || ""),
              link: element.link || "",
              locked: !!element.locked,
              version: safeI64(element.version, 0),
              updated: safeI64(element.updated, Date.now()),
              index: safeI64(element.index, 0),
              startBindingId: startBindExt,
              endBindingId: endBindExt,
              semanticClusterId: element.semanticClusterId || "",
              distanceClusterId: element.distanceClusterId || "",
              relationalClusterId: element.relationalClusterId || "",
            };
            let result;
            try {
              result = await callHelix("upsertElement", params);
              if (result?.el?.id && element.id)
                externalIdToInternalId.set(element.id, result.el.id);
            } catch (upsertError) {
              console.error(
                `[Sync] upsertElement failed for ${element.id}: ${upsertError?.message || upsertError}`
              );
              continue;
            }
            if (element.type === "arrow" || element.type === "line") arrowsToProcess.push(element);
          }
          debug(`[Sync] Processed ${elements.length} elements sequentially`);
          const allBindingIds = new Set();
          for (const arrow of arrowsToProcess) {
            if (arrow.startBindingId) allBindingIds.add(arrow.startBindingId);
            if (arrow.endBindingId) allBindingIds.add(arrow.endBindingId);
          }
          const missingBindingIds = Array.from(allBindingIds).filter(
            (id) => !externalIdToInternalId.has(id)
          );
          if (missingBindingIds.length > 0) {
            try {
              const elements = await callHelix("getBoardElements", { boardExtId: String(boardId) });
              const elementsArray = toElementsArray(elements);
              for (const externalId of missingBindingIds) {
                const targetElement = elementsArray.find((el) => el.externalId === externalId);
                if (targetElement?.id)
                  externalIdToInternalId.set(String(externalId), String(targetElement.id));
              }
            } catch (e) {
              console.warn(
                `[Sync Debug] Failed to get internal IDs for binding targets: ${e?.message || e}`
              );
            }
          }
          for (const arrow of arrowsToProcess) {
            const sourceId = externalIdToInternalId.get(arrow.startBindingId);
            const targetId = externalIdToInternalId.get(arrow.endBindingId);
            const arrowExtId = arrow.id;
            const edgeLabel = arrow.edgeLabel || "";
            debug(
              `[Sync Debug] Arrow ${arrowExtId}: start=${sourceId}, end=${targetId}, edgeLabel="${edgeLabel}"`
            );
            if (sourceId && targetId) {
              try {
                await callHelix("addRelationalAlignment", {
                  sourceId,
                  targetId,
                  via: String(arrowExtId || ""),
                  edgeLabel: String(edgeLabel),
                });
              } catch (e) {
                console.warn(
                  `[Helix] Failed to create relational edge for arrow ${arrowExtId}: ${e?.message || e}`
                );
              }
            } else {
              console.warn(
                `[Sync Debug] Missing internal IDs for arrow ${arrowExtId}, cannot create edge.`
              );
            }
          }
          try {
            const cc = clusterCache.get(String(boardId));
            if (cc && cc.byId && (elements?.length || 0) > 0) {
              const all = await getAllBoardElements(String(boardId));
              const tryAssignDistance = (el, entry) => {
                const b = bboxOf(el);
                const bb = entry.bbox;
                const dx = Math.max(0, Math.max(bb.minX - b.maxX, b.minX - bb.maxX));
                const dy = Math.max(0, Math.max(bb.minY - b.maxY, b.minY - bb.maxY));
                return (dx === 0 && dy === 0) || Math.hypot(dx, dy) < 100;
              };
              const tryAssignSemantic = (el, entry) => {
                if (!el || typeof el.text !== "string" || !el.text.trim()) return false;
                const tv = textVecCache.get(String(boardId));
                if (!tv) return false;
                const vec = tv.get(String(el.externalId));
                if (!vec) return false;
                for (const mid of entry.memberIds) {
                  const mv = tv.get(String(mid));
                  if (Array.isArray(mv) && mv.length === vec.length) {
                    if (cosineSim(vec, mv) >= 0.75) return true;
                  }
                }
                return false;
              };
              const tryAssignRelational = (el, entry) => {
                if (el.kind !== "arrow") return false;
                return (
                  entry.memberIds.includes(String(el.startBindingId)) ||
                  entry.memberIds.includes(String(el.endBindingId))
                );
              };
              for (const el of elements) {
                const eid = String(el.id || "");
                if (!eid) continue;
                const norm = (boardCache.get(boardId) || new Map()).get(eid);
                if (!norm) continue;
                for (const [cid, entry] of cc.byId.entries()) {
                  if (
                    entry.type === "distance" &&
                    tryAssignDistance(norm, {
                      bbox: (() => {
                        const b = entry.bbox;
                        return { minX: b.x, minY: b.y, maxX: b.x + b.width, maxY: b.y + b.height };
                      })(),
                    })
                  ) {
                    if (!entry.memberIds.includes(eid)) entry.memberIds.push(eid);
                  } else if (entry.type === "semantic" && tryAssignSemantic(norm, entry)) {
                    if (!entry.memberIds.includes(eid)) entry.memberIds.push(eid);
                  } else if (entry.type === "relational" && tryAssignRelational(norm, entry)) {
                    if (!entry.memberIds.includes(eid)) entry.memberIds.push(eid);
                  }
                }
              }
              clusterCache.set(String(boardId), cc);
            }
          } catch {}
          helixOperationsSuccessful = true;
        } catch (helixError) {
          boardCache.set(boardId, cacheBackup);
          return res.status(500).json({
            error: "HelixDB sync failed",
            details: helixError.message,
            retryRecommended: true,
          });
        }

        for (const element of elements) {
          if (element?.id) {
            // Skip deleted elements entirely
            if (element.isDeleted === true) {
              continue;
            }
            const normalized = normalizeElement({
              ...element,
              externalId: element.id,
              boardId: String(boardId),
              kind: element.type,
            });
            if (normalized) boardMap.set(String(element.id), normalized);
          }
        }
        boardCache.set(boardId, boardMap);

        if (typeof saveBoardToDiskMulti === "function") {
          await saveBoardToDiskMulti(boardId);
        } else {
          await saveBoardToDisk(boardId);
        }

        // Final safety: prune any old elements remaining in Helix not present in cache
        try {
          if (!HELIX_SAFE_MODE && typeof reconcileHelixToCache === "function") {
            await reconcileHelixToCache(
              String(boardId),
              targetSnapshot ? { snapshotIds: targetSnapshot } : undefined
            );
          }
        } catch {}

        res.json({
          success: true,
          upserts: elements.length,
          deleted: Array.isArray(deletedIds) ? deletedIds.length : 0,
          helixEmpty: helixWasEmpty,
          requestFullSnapshot: helixWasEmpty === true || needsFullSnapshot === true,
        });
      });
    } catch (error) {
      res.status(500).json({ error: "Sync failed", details: error.message });
    }
  });

  app.post("/api/canvas/context", requireAuth, async (req, res) => {
    try {
      const { boardId, selectedIds = [] } = req.body;
      if (!boardId) return res.status(400).json({ error: "Missing boardId" });
      const accessMeta = await ensureBoardEditor(req, res, boardId);
      if (!accessMeta) return;
      if (!Array.isArray(selectedIds) || selectedIds.length === 0)
        return res.json({ context: { elements: [] } });
      const helixElements = await callHelix("getAllElementsForBoard", {
        boardExtId: String(boardId),
      });
      if (!Array.isArray(helixElements)) return res.json({ context: { elements: [] } });
      const selectedElements = helixElements.filter(
        (el) => el?.externalId && selectedIds.includes(String(el.externalId))
      );
      res.json({ context: { elements: selectedElements } });
    } catch (error) {
      res.status(500).json({ error: error.message || "Internal error" });
    }
  });
}

export default mountCanvasRoutes;
