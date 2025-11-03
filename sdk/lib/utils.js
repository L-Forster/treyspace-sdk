export const validateNumber = (num, min = -1e6, max = 1e6) => {
  const n = Number(num);
  return isNaN(n) ? 0 : Math.max(min, Math.min(max, n));
};

export const validateInteger = (int, min = 0, max = 1000) => {
  return Math.floor(validateNumber(int, min, max));
};

export const cosineSimilarity = (vecA, vecB) => {
  if (!Array.isArray(vecA) || !Array.isArray(vecB) || vecA.length !== vecB.length) {
    return 0;
  }
  let dotProduct = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < vecA.length; i++) {
    dotProduct += vecA[i] * vecB[i];
    normA += vecA[i] * vecA[i];
    normB += vecB[i] * vecB[i];
  }
  if (normA === 0 || normB === 0) return 0;
  return dotProduct / (Math.sqrt(normA) * Math.sqrt(normB));
};

export const detectPromptInjection = (text) => {
  if (typeof text !== "string") return false;
  const normalized = text.toLowerCase();
  if (normalized.trim().length < 8) return false;
  const anchored = [
    /\bignore\s+(all|any|previous)\s+instructions?\b/,
    /\boverride\s+(your|the)\s+instructions?\b/,
    /\bdisregard\s+(all|any)\s+rules\b/,
    /\b(reveal|expose)\s+(system|prompt|secret|secrets|keys?)\b/,
  ];
  if (anchored.some((rx) => rx.test(normalized))) return true;
  const tokens = [
    "system prompt",
    "ignore instructions",
    "new instructions",
    "you are now",
    "forget everything",
    "act as",
    "roleplay as",
    "developer mode",
    "jailbreak",
  ];
  let hits = 0;
  for (const t of tokens) {
    if (normalized.includes(t)) hits++;
    if (hits >= 2) return true;
  }
  return false;
};

export const sanitizeAndCheckForInjection = (value, maxLen = 100000) => {
  const seen = new Set();
  const walk = (v) => {
    if (v === null || v === undefined) return false;
    if (typeof v === "string") {
      if (v.length > maxLen) return true;
      return detectPromptInjection(v);
    }
    if (typeof v === "number" || typeof v === "boolean") return false;
    if (typeof v === "object") {
      if (seen.has(v)) return false;
      seen.add(v);
      if (Array.isArray(v)) {
        for (const item of v) if (walk(item)) return true;
        return false;
      }
      for (const key of Object.keys(v)) if (walk(v[key])) return true;
      return false;
    }
    return false;
  };
  return walk(value);
};
