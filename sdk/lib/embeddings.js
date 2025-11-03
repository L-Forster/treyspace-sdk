import crypto from "crypto";

let localEmbeddingExtractor = null; // lazy-initialized
const LOCAL_EMBEDDINGS_ENABLED = String(process.env.LOCAL_EMBEDDINGS || "").trim() === "1";
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || process.env.VITE_OPENAI_API_KEY || "";
const EMBEDDING_MODEL = process.env.EMBEDDING_MODEL || "text-embedding-3-small";

const sha256Text = (s) =>
  crypto
    .createHash("sha256")
    .update(String(s || ""), "utf8")
    .digest("hex");

async function getLocalEmbeddingExtractor() {
  if (localEmbeddingExtractor) return localEmbeddingExtractor;
  try {
    const { pipeline } = await import("@xenova/transformers");
    const modelName = process.env.LOCAL_EMBEDDING_MODEL || "Xenova/all-mpnet-base-v2";
    localEmbeddingExtractor = await pipeline("feature-extraction", modelName, { quantized: true });
    return localEmbeddingExtractor;
  } catch (e) {
    // eslint-disable-next-line no-console
    console.warn("[Embedding] Local embeddings unavailable, will use OpenAI/toy.", e?.message || e);
    localEmbeddingExtractor = null;
    return null;
  }
}

export async function generateTextEmbedding(text) {
  try {
    if (LOCAL_EMBEDDINGS_ENABLED) {
      const extractor = await getLocalEmbeddingExtractor();
      if (extractor) {
        const output = await extractor(String(text || ""), { pooling: "mean", normalize: true });
        const vec = Array.from(output?.data || output || []);
        if (Array.isArray(vec) && vec.length > 0) return vec;
      }
    }
    if (OPENAI_API_KEY && typeof fetch === "function") {
      const resp = await fetch("https://api.openai.com/v1/embeddings", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${OPENAI_API_KEY}` },
        body: JSON.stringify({ model: EMBEDDING_MODEL, input: text }),
      });
      if (!resp.ok) throw new Error(`OpenAI embeddings error ${resp.status}`);
      const json = await resp.json();
      const vec = (json?.data?.[0]?.embedding || []).map((v) => Number(v));
      if (Array.isArray(vec) && vec.length > 0) return vec;
    }
  } catch (e) {
    // eslint-disable-next-line no-console
    console.warn("[Embedding] Falling back to toy vector:", e?.message || e);
  }
  const hash = crypto
    .createHash("sha256")
    .update(String(text || ""))
    .digest();
  const dims = 32;
  return new Array(dims).fill(0).map((_, i) => (hash[i] / 255) * 2 - 1);
}

export default { generateTextEmbedding };
