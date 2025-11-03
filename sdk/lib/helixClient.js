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
  return Promise.race([
    promise,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error(`HelixDB timeout after ${timeoutMs}ms`)), timeoutMs)
    ),
  ]);
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

export function createHelix(endpoint) {
  const helix = new HelixDB(endpoint);
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
    ]);

    const isWrite = WRITE_OPERATIONS.has(queryName);

    const executeQuery = async () => {
      try {
        const result = await withTimeout(helix.query(queryName, params || {}), TIMEOUT_MS);
        return result;
      } catch (error) {
        // Handle connection errors gracefully
        if (error?.cause?.code === "UND_ERR_SOCKET" || error?.message?.includes("socket")) {
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

  return { helix, callHelix };
}
