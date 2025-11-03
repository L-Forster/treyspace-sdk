// HelixDB schema for Excalidraw RAG

// ---------------------------------------------------------------------------
// Node types
// ---------------------------------------------------------------------------

N::Board {
  INDEX externalId: String,
  name: String DEFAULT "",
  created: I64 DEFAULT 0,
  updated: I64 DEFAULT 0
}

// Element node with cluster IDs stored directly as properties.
// This is the single, authoritative way clusters are defined.
N::Element {
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
}

// ---------------------------------------------------------------------------
// THE CONTRADICTORY N::Cluster NODE AND ITS EDGES HAVE BEEN REMOVED.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Edge types (relationships among elements)
// ---------------------------------------------------------------------------

E::BELONGS_TO_GROUP { From: Element, To: Element, Properties: { level: I64 } }
E::CONTAINS { From: Element, To: Element, Properties: {} }
E::BINDS_TO { From: Element, To: Element, Properties: { kind: String } }
E::FLOWS_TO { From: Element, To: Element, Properties: { via: String } }
E::TEXT_OF { From: Element, To: Element, Properties: { distance: F64, relevance: F64 } }
E::BOARD_CONTAINS { From: Board, To: Element, Properties: {} }
E::NEAR { From: Element, To: Element, Properties: { distance: F64, angle: F64, overlapX: F64, overlapY: F64 } }
E::DIRECTIONAL { From: Element, To: Element, Properties: { dir: String, gap: F64, overlap: F64 } }
E::SPATIALLY_ALIGNED { From: Element, To: Element, Properties: { distance: F64, proximity: F64, clustered: Boolean } }
E::LAYOUT_ALIGNED { From: Element, To: Element, Properties: { alignment: String, precision: F64, intention: String } }
E::LAYOUT_PATTERN { From: Element, To: Element, Properties: { pattern: String, position: String, confidence: F64 } }
E::SEMANTICALLY_RELATED { From: Element, To: Element, Properties: { relationship: String, confidence: F64 } }
E::DESCRIBES { From: Element, To: Element, Properties: { relevance: F64, aspect: String } }
E::RELATIONALLY_ALIGNED { From: Element, To: Element, Properties: { via: String, edgeLabel: String } }

// ---------------------------------------------------------------------------
// Vector Types
// ---------------------------------------------------------------------------

V::TextEmbedding {
  externalId: String,
  boardId: String,
  model: String,
  vector: [F64],
  created: I64
}

V::LayoutEmbedding {
  externalId: String,
  boardId: String,
  model: String,
  vector: [F64],
  created: I64
}