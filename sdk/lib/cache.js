import path from "path";
import { promises as fsp } from "fs";

export const boardCache = new Map();
export const textVecCache = new Map();
export const clusterCache = new Map();

export const ensureDir = async (dirPath) => {
  try {
    await fsp.mkdir(dirPath, { recursive: true });
  } catch {}
};

export async function saveBoardToDisk(boardId) {
  try {
    const items = Array.from((boardCache.get(boardId) || new Map()).values());
    const data = { id: String(boardId), items, savedAt: Date.now() };
    const dirs = [path.resolve(process.cwd(), "sdk/helix/data")];
    for (const dir of dirs) {
      try {
        await ensureDir(dir);
        const filePath = path.join(dir, `${String(boardId)}.json`);
        await fsp.writeFile(filePath, JSON.stringify(data, null, 2), "utf8");
      } catch {}
    }
  } catch {}
}

export async function loadBoardFromDisk(boardId) {
  try {
    const file = path.resolve(process.cwd(), "sdk/helix/data", `${String(boardId)}.json`);
    const text = await fsp.readFile(file, "utf8");
    return JSON.parse(text);
  } catch {
    return null;
  }
}

export async function hydrateBoardCacheFromDisk(boardId) {
  try {
    const json = await loadBoardFromDisk(boardId);
    const items = Array.isArray(json?.items) ? json.items : [];
    const map = new Map();
    for (const el of items) if (el?.externalId) map.set(String(el.externalId), el);
    boardCache.set(boardId, map);
  } catch {}
}
