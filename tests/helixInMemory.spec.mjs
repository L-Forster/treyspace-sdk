#!/usr/bin/env node
import assert from "node:assert/strict";
import { createHelix } from "../sdk/lib/helixClient.js";

const BOARD_ID = "cli-mode-board";

const expectElement = (el, kind) => {
  assert.ok(el && typeof el === "object", "element must be an object");
  assert.equal(el.boardId, BOARD_ID);
  assert.equal(el.kind, kind);
  assert.ok(el.id, "element should have an internal id");
  assert.ok(el.externalId, "element should have an externalId");
};

async function runCliModeFlow() {
  const { helix, callHelix } = createHelix("http://unused", { tags: "cli" });
  assert.equal(helix.mode, "cli");
  assert.equal(callHelix.mode, "cli");

  await callHelix("ensureBoard", { boardId: BOARD_ID });
  await callHelix("deleteBoardElements", { boardId: BOARD_ID });

  // Ingest two shapes and one arrow via the same entry points the SDK uses.
  await callHelix("upsertElement", {
    boardId: BOARD_ID,
    externalId: "shape-rect",
    kind: "rectangle",
    x: 10,
    y: 20,
    w: 120,
    h: 80,
    text: "Rect",
  });
  const { element: circle } = await callHelix("createElement", {
    boardId: BOARD_ID,
    elementType: "ellipse",
    externalId: "shape-circle",
    text: "Circle",
  });
  const { arrow } = await callHelix("createArrow", {
    boardId: BOARD_ID,
    startElementId: circle.id,
    endElementId: circle.id,
    strokeColor: "#000",
  });
  expectElement(circle, "ellipse");
  expectElement(arrow, "arrow");

  // Mirror how canvas/clusters routes create graph edges.
  const link = await callHelix("addRelationalAlignment", {
    sourceId: circle.id,
    targetId: circle.id,
    via: arrow.externalId,
    edgeLabel: "self",
  });
  assert.equal(link.edge.edgeLabel, "self");

  const { elements } = await callHelix("getBoardElements", { boardId: BOARD_ID });
  assert.equal(elements.length, 3, "expected rectangle, circle, arrow");

  const structure = await callHelix("analyzeCanvasStructure", { boardId: BOARD_ID });
  assert.equal(structure.boardId, BOARD_ID);
  assert.ok(structure.byKind.rectangle >= 1, "structure should count rectangles");
  assert.ok(structure.byKind.arrow >= 1, "structure should count arrows");
  assert.equal(structure.relations.relational, 1, "relational edges tracked in memory");
}

async function ensureHelixDbPathRemainsDefault() {
  const { helix, callHelix } = createHelix("http://localhost:6969");
  assert.notEqual(helix.mode, "cli");
  assert.notEqual(callHelix.mode, "cli");
}

await runCliModeFlow();
await ensureHelixDbPathRemainsDefault();

console.log("✅ In-memory Helix tag behaves as expected");
