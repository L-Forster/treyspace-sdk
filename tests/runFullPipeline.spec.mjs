#!/usr/bin/env node
import "dotenv/config";
import { readFileSync } from "fs";
import { executeFullPipeline } from "../sdk/sdk.js";

const apiKey = process.env.OPENAI_API_KEY;
if (!apiKey || !apiKey.trim()) {
  console.warn("⚠️  Skipping full pipeline test - OPENAI_API_KEY is not set.");
  process.exit(0);
}

// Minimal test - verify executeFullPipeline returns a response

const data = JSON.parse(readFileSync("./examples/sample-board.json", "utf8"));

console.log("Testing full pipeline...");

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
