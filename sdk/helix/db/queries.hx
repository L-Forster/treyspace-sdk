// HelixDB queries for Excalidraw RAG (final, stable, minimal version)

// Create/Upsert element node. This is the primary mutation and includes cluster ID fields.
QUERY upsertElement(
  externalId: String,
  boardId: String,
  kind: String,
  short_id: String,
  x: F64,
  y: F64,
  w: F64,
  h: F64,
  angle: F64,
  strokeColor: String,
  backgroundColor: String,
  strokeWidth: I64,
  fillStyle: String,
  roughness: I64,
  opacity: I64,
  text: String,
  link: String,
  locked: Boolean,
  version: I64,
  updated: I64,
  index: I64,
  startBindingId: String,
  endBindingId: String,
  semanticClusterId: String,
  distanceClusterId: String,
  relationalClusterId: String
) =>
  el <- AddN<Element>({
    externalId: externalId,
    boardId: boardId,
    kind: kind,
    short_id: short_id,
    x: x,
    y: y,
    w: w,
    h: h,
    angle: angle,
    strokeColor: strokeColor,
    backgroundColor: backgroundColor,
    strokeWidth: strokeWidth,
    fillStyle: fillStyle,
    roughness: roughness,
    opacity: opacity,
    text: text,
    link: link,
    locked: locked,
    version: version,
    updated: updated,
    index: index,
    startBindingId: startBindingId,
    endBindingId: endBindingId,
    semanticClusterId: semanticClusterId,
    distanceClusterId: distanceClusterId,
    relationalClusterId: relationalClusterId
  })
  RETURN el



QUERY updateElementById(
  elementId: ID,
  kind: String,
  short_id: String,
  x: F64,
  y: F64,
  w: F64,
  h: F64,
  angle: F64,
  strokeColor: String,
  backgroundColor: String,
  strokeWidth: I64,
  fillStyle: String,
  roughness: I64,
  opacity: I64,
  text: String,
  link: String,
  locked: Boolean,
  version: I64,
  updated: I64,
  index: I64,
  startBindingId: String,
  endBindingId: String,
  semanticClusterId: String,
  distanceClusterId: String,
  relationalClusterId: String
) =>
  updated_node <- N<Element>(elementId)::UPDATE({
    kind: kind,
    short_id: short_id,
    x: x,
    y: y,
    w: w,
    h: h,
    angle: angle,
    strokeColor: strokeColor,
    backgroundColor: backgroundColor,
    strokeWidth: strokeWidth,
    fillStyle: fillStyle,
    roughness: roughness,
    opacity: opacity,
    text: text,
    link: link,
    locked: locked,
    version: version,
    updated: updated,
    index: index,
    startBindingId: startBindingId,
    endBindingId: endBindingId,
    semanticClusterId: semanticClusterId,
    distanceClusterId: distanceClusterId,
    relationalClusterId: relationalClusterId
  })

  RETURN updated_node


// Ensure a Board node exists
QUERY ensureBoard(
  boardExtId: String
) =>
  board <- AddN<Board>({ externalId: boardExtId, name: "", created: 0, updated: 0 })
  RETURN board

// Vector similarity search
QUERY vectorSearchText(
  boardExtId: String,
  embedding: [F64],
  k: I64
) =>
  all_vecs <- SearchV<TextEmbedding>(embedding, k)
  vecs <- all_vecs::WHERE(_::{boardId}::EQ(boardExtId))
  RETURN vecs

// Upsert text embedding vector
QUERY upsertTextEmbedding(
  boardExtId: String,
  elementExtId: String,
  model: String,
  vector: [F64]
) =>
  embedding <- AddV<TextEmbedding>(vector, {
    externalId: elementExtId,
    boardId: boardExtId,
    model: model,
    created: 0
  })
  RETURN embedding

// Get all elements on a board
QUERY getBoardElements(
  boardExtId: String
) =>
  els <- N<Element>::WHERE(_::{boardId}::EQ(boardExtId))
  RETURN els

// Create FLOWS_TO edge between two elements
QUERY createFlowEdge(
  sourceId: ID,
  targetId: ID
) =>
  source <- N<Element>(sourceId)
  target <- N<Element>(targetId)
  edge <- AddE<FLOWS_TO>()::From(source)::To(target)
  RETURN edge

// Create BINDS_TO edge between two elements
QUERY createBinds_TOEdge(
  sourceId: ID,
  targetId: ID
) =>
  source <- N<Element>(sourceId)
  target <- N<Element>(targetId)
  edge <- AddE<BINDS_TO>()::From(source)::To(target)
  RETURN edge

// Create RELATIONALLY_ALIGNED edge between two elements (captures arrow used)
QUERY addRelationalAlignment(
  sourceId: ID,
  targetId: ID,
  via: String,
  edgeLabel: String
) =>
  source <- N<Element>(sourceId)
  target <- N<Element>(targetId)
  edge <- AddE<RELATIONALLY_ALIGNED>({ via: via, edgeLabel: edgeLabel })::From(source)::To(target)
  RETURN edge

// Neighbors by edge type (both directions)
QUERY getRelationallyAlignedNeighbors(
  elementId: ID
) =>
  src <- N<Element>(elementId)
  outs <- src::Out<RELATIONALLY_ALIGNED>
  ins <- src::In<RELATIONALLY_ALIGNED>
  RETURN outs, ins

QUERY getSemanticallyRelatedNeighbors(
  elementId: ID
) =>
  src <- N<Element>(elementId)
  outs <- src::Out<SEMANTICALLY_RELATED>
  ins <- src::In<SEMANTICALLY_RELATED>
  RETURN outs, ins

QUERY getSpatiallyAlignedNeighbors(
  elementId: ID
) =>
  src <- N<Element>(elementId)
  outs <- src::Out<SPATIALLY_ALIGNED>
  ins <- src::In<SPATIALLY_ALIGNED>
  RETURN outs, ins

// Remove prior semantic analysis edges for a board
QUERY deleteSemanticRelationsForBoard(
  boardExtId: String
) =>
  els <- N<Element>::WHERE(_::{boardId}::EQ(boardExtId))
  // Drop semantic relation edges in both directions
  DROP els::OutE<SEMANTICALLY_RELATED>
  DROP els::InE<SEMANTICALLY_RELATED>
  // Drop descriptive semantic edges if any
  DROP els::OutE<DESCRIBES>
  DROP els::InE<DESCRIBES>
  RETURN "Success"

// Remove prior spatial alignment/near/directional edges for a board
QUERY deleteSpatialAlignmentsForBoard(
  boardExtId: String
) =>
  els <- N<Element>::WHERE(_::{boardId}::EQ(boardExtId))
  // Drop spatial proximity edges
  DROP els::OutE<NEAR>
  DROP els::InE<NEAR>
  // Drop directional/layout edges
  DROP els::OutE<DIRECTIONAL>
  DROP els::InE<DIRECTIONAL>
  DROP els::OutE<SPATIALLY_ALIGNED>
  DROP els::InE<SPATIALLY_ALIGNED>
  DROP els::OutE<LAYOUT_ALIGNED>
  DROP els::InE<LAYOUT_ALIGNED>
  DROP els::OutE<LAYOUT_PATTERN>
  DROP els::InE<LAYOUT_PATTERN>
  RETURN "Success"


QUERY addSpatialAlignment(
  fromElementId: ID,
  toElementId: ID,
  distance: F64,
  proximity: F64,
  clustered: Boolean
) =>
  fromElement <- N<Element>(fromElementId)
  toElement <- N<Element>(toElementId)
  rel <- AddE<SPATIALLY_ALIGNED>({ distance: distance, proximity: proximity, clustered: clustered })::From(fromElement)::To(toElement)
  RETURN rel

QUERY addSemanticRelation(
  fromElementId: ID,
  toElementId: ID,
  relationship: String,
  confidence: F64
) =>
  fromElement <- N<Element>(fromElementId)
  toElement <- N<Element>(toElementId)
  rel <- AddE<SEMANTICALLY_RELATED>({ relationship: relationship, confidence: confidence })::From(fromElement)::To(toElement)
  RETURN rel

// ---------------------------------------------------------------------------
// Deletion and maintenance
// ---------------------------------------------------------------------------

// Delete a single element by board + externalId
QUERY deleteElement(
  boardExtId: String,
  elementExtId: String
) =>
  DROP N<Element>
    ::WHERE(_::{boardId}::EQ(boardExtId))
    ::WHERE(_::{externalId}::EQ(elementExtId))
  RETURN "OK"

// Delete a single element by internal ID (precise duplicate cleanup)
QUERY deleteElementById(
  elementId: ID
) =>
  DROP N<Element>(elementId)
  RETURN "OK"

// Delete ALL elements for a board
QUERY deleteBoardElements(
  boardExtId: String
) =>
  DROP N<Element>::WHERE(_::{boardId}::EQ(boardExtId))
  RETURN "OK"

// Delete ALL edges for a board (both in and out across known types)
QUERY deleteAllBoardRelations(
  boardExtId: String
) =>
  // Drop all outgoing edges
  DROP N<Element>::WHERE(_::{boardId}::EQ(boardExtId))::OutE<BELONGS_TO_GROUP>
  DROP N<Element>::WHERE(_::{boardId}::EQ(boardExtId))::OutE<CONTAINS>
  DROP N<Element>::WHERE(_::{boardId}::EQ(boardExtId))::OutE<BINDS_TO>
  DROP N<Element>::WHERE(_::{boardId}::EQ(boardExtId))::OutE<FLOWS_TO>
  DROP N<Element>::WHERE(_::{boardId}::EQ(boardExtId))::OutE<TEXT_OF>
  DROP N<Board>::WHERE(_::{externalId}::EQ(boardExtId))::OutE<BOARD_CONTAINS>
  DROP N<Element>::WHERE(_::{boardId}::EQ(boardExtId))::OutE<NEAR>
  DROP N<Element>::WHERE(_::{boardId}::EQ(boardExtId))::OutE<DIRECTIONAL>
  DROP N<Element>::WHERE(_::{boardId}::EQ(boardExtId))::OutE<SPATIALLY_ALIGNED>
  DROP N<Element>::WHERE(_::{boardId}::EQ(boardExtId))::OutE<LAYOUT_ALIGNED>
  DROP N<Element>::WHERE(_::{boardId}::EQ(boardExtId))::OutE<LAYOUT_PATTERN>
  DROP N<Element>::WHERE(_::{boardId}::EQ(boardExtId))::OutE<SEMANTICALLY_RELATED>
  DROP N<Element>::WHERE(_::{boardId}::EQ(boardExtId))::OutE<DESCRIBES>
  DROP N<Element>::WHERE(_::{boardId}::EQ(boardExtId))::OutE<RELATIONALLY_ALIGNED>
  // Drop all incoming edges
  DROP N<Element>::WHERE(_::{boardId}::EQ(boardExtId))::InE<BELONGS_TO_GROUP>
  DROP N<Element>::WHERE(_::{boardId}::EQ(boardExtId))::InE<CONTAINS>
  DROP N<Element>::WHERE(_::{boardId}::EQ(boardExtId))::InE<BINDS_TO>
  DROP N<Element>::WHERE(_::{boardId}::EQ(boardExtId))::InE<FLOWS_TO>
  DROP N<Element>::WHERE(_::{boardId}::EQ(boardExtId))::InE<TEXT_OF>
  DROP N<Element>::WHERE(_::{boardId}::EQ(boardExtId))::InE<BOARD_CONTAINS>
  DROP N<Element>::WHERE(_::{boardId}::EQ(boardExtId))::InE<NEAR>
  DROP N<Element>::WHERE(_::{boardId}::EQ(boardExtId))::InE<DIRECTIONAL>
  DROP N<Element>::WHERE(_::{boardId}::EQ(boardExtId))::InE<SPATIALLY_ALIGNED>
  DROP N<Element>::WHERE(_::{boardId}::EQ(boardExtId))::InE<LAYOUT_ALIGNED>
  DROP N<Element>::WHERE(_::{boardId}::EQ(boardExtId))::InE<LAYOUT_PATTERN>
  DROP N<Element>::WHERE(_::{boardId}::EQ(boardExtId))::InE<SEMANTICALLY_RELATED>
  DROP N<Element>::WHERE(_::{boardId}::EQ(boardExtId))::InE<DESCRIBES>
  DROP N<Element>::WHERE(_::{boardId}::EQ(boardExtId))::InE<RELATIONALLY_ALIGNED>
  RETURN "OK"

// Delete RELATIONALLY_ALIGNED edges created by a specific connector (match by via)
QUERY deleteRelationalAlignmentsByVia(
  viaExtId: String
) =>
  DROP E<RELATIONALLY_ALIGNED>::WHERE(_::{via}::EQ(viaExtId))
  RETURN "OK"

// Delete relational alignments touching a specific element (incident edges)
QUERY deleteRelationalAlignmentsForElement(
  boardExtId: String,
  elementExtId: String
) =>
  els <- N<Element>
    ::WHERE(_::{boardId}::EQ(boardExtId))
    ::WHERE(_::{externalId}::EQ(elementExtId))
  DROP els::OutE<RELATIONALLY_ALIGNED>
  DROP els::InE<RELATIONALLY_ALIGNED>
  RETURN "OK"

// Delete semantic relations touching a specific element
QUERY deleteSemanticRelationsForElement(
  boardExtId: String,
  elementExtId: String
) =>
  els <- N<Element>
    ::WHERE(_::{boardId}::EQ(boardExtId))
    ::WHERE(_::{externalId}::EQ(elementExtId))
  DROP els::OutE<SEMANTICALLY_RELATED>
  DROP els::InE<SEMANTICALLY_RELATED>
  DROP els::OutE<DESCRIBES>
  DROP els::InE<DESCRIBES>
  RETURN "OK"

// Delete spatial alignment edges touching a specific element
QUERY deleteSpatialAlignmentsForElement(
  boardExtId: String,
  elementExtId: String
) =>
  els <- N<Element>
    ::WHERE(_::{boardId}::EQ(boardExtId))
    ::WHERE(_::{externalId}::EQ(elementExtId))
  DROP els::OutE<NEAR>
  DROP els::InE<NEAR>
  DROP els::OutE<DIRECTIONAL>
  DROP els::InE<DIRECTIONAL>
  DROP els::OutE<SPATIALLY_ALIGNED>
  DROP els::InE<SPATIALLY_ALIGNED>
  DROP els::OutE<LAYOUT_ALIGNED>
  DROP els::InE<LAYOUT_ALIGNED>
  DROP els::OutE<LAYOUT_PATTERN>
  DROP els::InE<LAYOUT_PATTERN>
  RETURN "OK"
