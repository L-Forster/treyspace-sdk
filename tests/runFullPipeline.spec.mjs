#!/usr/bin/env node
import "dotenv/config";
import { readFileSync } from "fs";

const args = process.argv.slice(2);

const tagSetFromEnv = () => {
  const current = String(process.env.SDK_TAGS || "");
  return current
    .split(/[,\s]+/)
    .map((t) => t.trim())
    .filter(Boolean);
};

const enableCliHelix = args.includes("--disable_helix");

if (enableCliHelix) {
  const tags = new Set(tagSetFromEnv());
  tags.add("cli");
  const merged = Array.from(tags).join(",");
  process.env.SDK_TAGS = merged;
  globalThis.__TREYSPACE_RUNTIME_TAGS__ = merged;
  console.log("⚙️  Helix in-memory mode enabled for full pipeline test");
}

const { executeFullPipeline } = await import("../sdk/sdk.js");

const apiKey = process.env.OPENAI_API_KEY;
if (!apiKey || !apiKey.trim()) {
  console.warn("⚠️  Skipping full pipeline test - OPENAI_API_KEY is not set.");
  process.exit(0);
}

// Minimal test - verify executeFullPipeline returns a response

const data = JSON.parse(readFileSync("./examples/sample-board.json", "utf8"));

console.log(
  `Testing full pipeline${enableCliHelix ? " (in-memory Helix mode)" : ""}...`
);

const result = await executeFullPipeline({
  boardId: data.boardId,
  userMessage: data.userMessage,
  elements: data.elements,
  userId: "test-user",
});

if (!result.text || result.text.length < 10) {
  throw new Error("Pipeline failed - no meaningful response");
}

console.log("\n✅ Pipeline test passed");
console.log("Response:", result.text.slice(0, 100) + "...");
