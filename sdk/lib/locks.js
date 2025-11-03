// Lightweight in-process lock helper that keeps compatibility with the old Redis API.
// We only need mutual exclusion within a single Node process for the OSS build.

export function createLockUtils() {
  const lockQueues = new Map();

  async function withDistributedLock(lockKey, operation, _ttlMs = 30000) {
    const previous = lockQueues.get(lockKey) || Promise.resolve();
    let release;
    const current = new Promise((resolve) => {
      release = resolve;
    });
    const tail = previous.then(() => current);
    lockQueues.set(lockKey, tail);

    await previous;
    try {
      return await operation();
    } finally {
      release();
      if (lockQueues.get(lockKey) === tail) {
        lockQueues.delete(lockKey);
      }
    }
  }

  return { withDistributedLock };
}

export default createLockUtils;
