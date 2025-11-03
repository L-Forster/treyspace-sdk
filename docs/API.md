# API Reference

This project exposes two cooperating HTTP services:

| Service              | Entry Point     | Default URL             | Purpose                                                           |
| -------------------- | --------------- | ----------------------- | ----------------------------------------------------------------- |
| AI proxy             | `src/index.js`  | `http://localhost:8787` | Front door for client traffic, OpenAI proxying, and orchestration |
| Helix RAG SDK server | `sdk/server.js` | `http://localhost:3001` | Canvas synchronisation, Helix integration, and MCP tool surface   |

Run both servers for the full pipeline (see `README.md`).

## Shared conventions

- All request/response bodies are JSON encoded.
- CORS defaults to `ALLOWED_ORIGINS`; override in `.env`.
- Errors use the structure:

  ```json
  {
    "error": "Message describing the failure",
    "details": "Optional additional context"
  }
  ```

- Authentication is header-based. The SDK service trusts the `x-user-id` (or `x-user`, `x-client-id`, `x-api-key`) header and falls back to `anonymous`. No other auth is enforced; add your own middleware before production use.

---

## AI proxy (`src/index.js`)

### GET `/healthz`

Basic readiness check. Returns `200` when the process is running and an OpenAI API key is configured.

**Response**

```json
{
  "ok": true,
  "openai": true
}
```

Returns `500` with `ok: false` if `OPENAI_API_KEY` is missing.

### POST `/v1/responses`

Wrapper around the OpenAI Responses API with canvas-specific hardening.

**Request body**

```json
{
  "model": "gpt-5",
  "instructions": "Optional system instructions",
  "input": "User prompt",
  "tools": [{ "type": "web_search" }],
  "stream": true
}
```

- Instruction & input strings are sanitised and merged into a guarded prompt.
- Tool choices are restricted to `web_search`, `no_tools_needed`, or `mcp_cluster_traverse`.
- `stream: true` enables Server-Sent Events; otherwise a JSON response is returned.

**Streaming**

SSE events are forwarded verbatim from OpenAI. The stream ends with `data: [DONE]`.

### POST `/api/ai/engine`

Runs the full Helix RAG canvas pipeline and streams structured events.

**Request body**

```json
{
  "boardId": "canvas-001",
  "userMessage": "Explain this diagram",
  "history": [],
  "settings": {},
  "userSelectedContext": null
}
```

**Event types**

- `status` – progress messages
- `text` – assistant output chunks
- Custom control events (`emitControl` in the backend) forwarded as-is
- `error` – emitted when processing fails, followed by `[DONE]`

### POST `/api/clusters`

Proxies cluster requests to the SDK server (`HELIX_RAG_URL`, default `http://localhost:3001`). Use the same payload as `/api/clusters` on the SDK service. Useful when the client only talks to the AI proxy.

### POST `/api/mcp-bridge`

Bridges Model Context Protocol tool calls to the SDK’s `/api/mcp/*` endpoints.

**Request body**

```json
{
  "tool": "mcp:init",
  "arguments": { "boardId": "canvas-001" }
}
```

Supported tool values map to SDK endpoints, for example:

| Tool                   | Forwarded endpoint               |
| ---------------------- | -------------------------------- |
| `mcp:init`             | `POST /api/mcp/init`             |
| `mcp:reset`            | `POST /api/mcp/reset`            |
| `mcp:schema_resource`  | `POST /api/mcp/schema_resource`  |
| `mcp:exec_query`       | `POST /api/mcp/exec_query`       |
| `mcp:filter_items`     | `POST /api/mcp/filter_items`     |
| `mcp:search_vector`    | `POST /api/mcp/search_vector`    |
| `mcp:collect`          | `POST /api/mcp/collect`          |
| `mcp:cluster_traverse` | `POST /api/clusters/traverse`    |
| `mcp:clusters`         | `POST /api/clusters`             |
| `mcp:create_element`   | `POST /api/mcp/create-element`   |
| `mcp:connect_elements` | `POST /api/mcp/connect-elements` |

All other `mcp:*` values follow the same pattern (`/api/mcp/<suffix>`). The proxy automatically initialises an MCP session (`connection_id`) when needed and forwards `Authorization` headers.

---

## Helix RAG SDK server (`sdk/server.js`)

### GET `/health`

Lightweight health check.

**Response**

```json
{
  "status": "ok",
  "timestamp": "2024-05-01T12:34:56.000Z"
}
```

### Canvas endpoints

#### POST `/api/canvas/sync`

Writes canvas updates to the in-memory cache, persists snapshots to disk, and mirrors into Helix.

**Request body**

```json
{
  "boardId": "canvas-001",
  "elements": [{ "id": "node-1", "type": "rectangle", ... }],
  "deletedIds": ["node-2"],
  "opts": { "fullSnapshot": false },
  "excalidrawData": { "elements": [...] } // optional authoritative snapshot
}
```

- When `excalidrawData` is present the payload is treated as a full snapshot; existing cache and Helix records are pruned to match.
- Passing only `deletedIds` removes elements and triggers reconciliation.

**Response**

```json
{
  "success": true,
  "upserts": 12,
  "deleted": 1,
  "helixEmpty": false,
  "requestFullSnapshot": false
}
```

On errors the route returns `500` with `error`/`details`.

#### POST `/api/canvas/context`

Fetches the latest element data for a set of IDs.

**Request body**

```json
{
  "boardId": "canvas-001",
  "selectedIds": ["node-1", "node-3"]
}
```

**Response**

```json
{
  "context": {
    "elements": [{ "externalId": "node-1", ... }]
  }
}
```

Returns an empty array when no matching elements are found.

#### POST `/api/clusters/refresh`

Forces a cache bust followed by the same computation as `/api/clusters`. Useful after large canvas updates.

### Cluster endpoints

All cluster routes require `boardId` and use Helix for authoritative storage. Results are cached in-memory for five minutes.

#### POST `/api/clusters`

Computes semantic, relational, and spatial clusters.

**Request body**

```json
{ "boardId": "canvas-001", "forceRecompute": false }
```

**Response**

```json
{
  "semantic_clusters": [{ "id": "s_1", "member_ids": [...], ... }],
  "distance_clusters": [{ "id": "d_1", ... }],
  "relational_clusters": [{ "id": "r_1", ... }],
  "total_elements": 42,
  "total_clusters": 7
}
```

#### POST `/api/clusters/refresh`

Forces a cache bust followed by the same computation as `/api/clusters`.

#### POST `/api/clusters/traverse`

Returns connector-level relationships within a specific cluster.

**Request body**

```json
{
  "boardId": "canvas-001",
  "cluster_id": "r_1",
  "include_members": false
}
```

**Response**

```json
{
  "cluster_id": "r_1",
  "cluster_type": "relational",
  "counts": { "members": 8 },
  "connections": [
    {
      "from": "node-1",
      "to": "node-5",
      "type": "RELATIONALLY_ALIGNED",
      "directed": true,
      "via": "arrow-9",
      "distance": 112
    }
  ]
}
```

Set `include_members: true` to include the underlying element metadata.

### MCP tool surface

The SDK exposes a rich set of MCP-compatible routes under `/api/mcp/*`. Each endpoint expects a JSON body with at least `connection_id` (use `/api/mcp/init` to create one) and any tool-specific arguments. Notable routes include:

| Endpoint                                     | Purpose                                     |
| -------------------------------------------- | ------------------------------------------- |
| `POST /api/mcp/init`                         | Create a session and return `connection_id` |
| `POST /api/mcp/reset`                        | Tear down a session                         |
| `POST /api/mcp/schema_resource`              | Describe available graph resources          |
| `POST /api/mcp/exec_query`                   | Execute a Helix query string                |
| `POST /api/mcp/filter_items`                 | Filter cached traversal items               |
| `POST /api/mcp/search_vector`                | Vector similarity search over elements      |
| `POST /api/mcp/collect`                      | Collect traversal results into an array     |
| `POST /api/mcp/quick/selection_neighborhood` | Inspect neighbourhood around selected nodes |
| `POST /api/mcp/collect_subgraph`             | Return a subgraph bounded by rules          |
| `POST /api/mcp/semantic_layout_search`       | Hybrid semantic/spatial search              |
| `POST /api/mcp/analyze_canvas_structure`     | Produce a structural summary of the canvas  |
| `POST /api/mcp/create-element`               | Create a new canvas element record in Helix |
| `POST /api/mcp/connect-elements`             | Create Helix relations between two elements |

All endpoints respond with JSON data or an error object.



## Testing

```bash
npm run smoke                       # Hits /healthz on the AI proxy
npx tsx tests/sdkSmoke.spec.mjs     # Exercises the SDK + proxy pipeline
npx tsx tests/runFullPipeline.spec.mjs  # Full end-to-end pipeline
```

Set `OPENAI_API_KEY` and ensure both services are running before executing the tests.
