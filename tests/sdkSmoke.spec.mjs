#!/usr/bin/env node
import "dotenv/config";
import assert from "node:assert/strict";

const BOARD_ID = process.env.SDK_SMOKE_BOARD_ID || "sdk-smoke-board";
const USER_ID = process.env.SDK_SMOKE_USER_ID || "sdk-smoke";

const ELEMENTS = [
  {
    id: "feature-auth",
    type: "rectangle",
    x: 120,
    y: 120,
    width: 220,
    height: 140,
    text: "Authentication Service",
    version: 1,
  },
  {
    id: "feature-api",
    type: "rectangle",
    x: 400,
    y: 120,
    width: 220,
    height: 140,
    text: "API Gateway",
    version: 1,
  },
  {
    id: "feature-cache",
    type: "rectangle",
    x: 120,
    y: 360,
    width: 220,
    height: 140,
    text: "Cache Layer",
    version: 1,
  },
  {
    id: "feature-db",
    type: "rectangle",
    x: 400,
    y: 360,
    width: 220,
    height: 140,
    text: "Postgres Cluster",
    version: 1,
  },
  {
    id: "note-auth",
    type: "text",
    x: 140,
    y: 140,
    width: 180,
    height: 60,
    text: "Handles logins & SSO",
    containerId: "feature-auth",
    version: 1,
  },
  {
    id: "arrow-auth-api",
    type: "arrow",
    x: 340,
    y: 190,
    points: [
      [0, 0],
      [60, 0],
    ],
    startBinding: { elementId: "feature-auth" },
    endBinding: { elementId: "feature-api" },
    version: 1,
  },
  {
    id: "arrow-api-db",
    type: "arrow",
    x: 510,
    y: 260,
    points: [
      [0, 0],
      [0, 80],
    ],
    startBinding: { elementId: "feature-api" },
    endBinding: { elementId: "feature-db" },
    version: 1,
  },
];

const toSnapshot = (elements) => ({
  type: "excalidraw",
  version: 2,
  source: "sdk-smoke",
  elements,
});

async function readSse(response) {
  if (!response.body) throw new Error("Streaming response missing body");
  const reader = response.body.getReader();
  const decoder = new TextDecoder("utf-8");
  let buffer = "";
  let text = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() || "";
    for (const line of lines) {
      if (!line.startsWith("data:")) continue;
      const payload = line.slice(5).trim();
      if (payload === "[DONE]") return text;
      try {
        const json = JSON.parse(payload);
        const chunk =
          json?.output_text ||
          json?.text ||
          json?.item?.text ||
          json?.choices?.[0]?.delta?.content ||
          json?.delta ||
          "";
        if (chunk && typeof chunk === "string") text += chunk;
      } catch {
        if (payload) text += payload;
      }
    }
  }

  return text;
}

async function postJson(url, payload, headers = {}) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(payload ?? {}),
  });
  if (!response.ok) {
    const err = await response.text().catch(() => "");
    throw new Error(`Request failed (${response.status}): ${err}`);
  }
  return await response.json().catch(() => ({}));
}

async function main() {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey || !apiKey.trim()) {
    console.warn("⚠️  Skipping SDK smoke test - OPENAI_API_KEY is not set.");
    process.exit(0);
  }

  const {
    startHelixFacadeServer,
    stopHelixFacadeServer,
    startPipelineBackend,
    stopPipelineBackend,
  } = await import("../sdk/core/index.js");

  const headers = { "X-User-Id": USER_ID };
  let helixBase;
  const backendUrl = "http://127.0.0.1:8787";

  try {
    const { port } = await startHelixFacadeServer();
    helixBase = `http://127.0.0.1:${port}`;
    console.log("Helix façade listening on", helixBase);

    await startPipelineBackend(helixBase);
    console.log("Backend server listening on", backendUrl);

    console.log("Resetting board state…");
    await postJson(
      `${helixBase}/api/canvas/sync`,
      {
        boardId: BOARD_ID,
        excalidrawData: toSnapshot(
          ELEMENTS.map((el) => ({
            ...el,
            isDeleted: true,
          }))
        ),
      },
      headers
    );

    console.log("Uploading sample elements…");
    await postJson(
      `${helixBase}/api/canvas/sync`,
      {
        boardId: BOARD_ID,
        excalidrawData: toSnapshot(ELEMENTS),
      },
      headers
    );

    console.log("Refreshing clusters…");
    const clusters = await postJson(
      `${helixBase}/api/clusters`,
      { boardId: BOARD_ID, forceRecompute: true },
      headers
    );
    assert.ok(clusters?.relational_clusters?.length, "relational clusters present");

    console.log("Generating analysis…");
    const response = await fetch(`${backendUrl}/api/ai/engine`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...headers },
      body: JSON.stringify({
        boardId: BOARD_ID,
        userMessage: "Explain the system layout BY DOING A TRAVERSAL OF THE RELATIONAL CLUSTER",
        history: [
          { role: "user", content: "Focus on authentication and data flow" },
          { role: "assistant", content: "Acknowledged." },
        ],
      }),
    });
    if (!response.ok) {
      const err = await response.text().catch(() => "");
      throw new Error(`AI engine request failed (${response.status}): ${err}`);
    }

    const text = await readSse(response);
    if (!text || !text.trim()) {
      throw new Error("Model response text was empty.");
    }

    console.log("Model response:\n", text);
    console.log("SDK smoke test completed successfully.");
  } finally {
    await stopPipelineBackend();
    await stopHelixFacadeServer();
  }
}

main().catch((error) => {
  console.error("SDK smoke test failed:", error);
  process.exitCode = 1;
});
