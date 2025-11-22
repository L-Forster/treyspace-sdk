#!/usr/bin/env node
import "dotenv/config";
import { readFileSync } from "fs";
import { executeFullPipeline } from "treyspace-sdk";

const data = JSON.parse(readFileSync("./benchmarks/test-canvas-100nodes.json", "utf8"));


const result = await executeFullPipeline({
  boardId: data.boardId,
  userMessage: data.userMessage,
  elements: data.elements,
  userId: "example-user",
});

console.log("Response:\n", result.text);
