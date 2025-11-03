# Excalidraw ↔ Helix RAG SDK

Open-source toolkit for mirroring Excalidraw canvases into [HelixDB](https://docs.helix-db.com/) and running retrieval‑augmented generation on top of that graph.  
Clone it, import the SDK (`createHelixRagSDK`) from your own code, and you can drive canvas ingestion + clustering without ever booting a server. An optional Express façade still ships for people who want an HTTP surface, but it now starts only when you run `node server.js`.

> **Status** – the commercial build at Treyspace contains auth, billing, rate limiting, real-time scenes, etc.  
> This OSS snapshot keeps only the primitives you need to ingest canvases, analyse clusters and power RAG.

---

## Capabilities

- **Canvas ingestion** – normalises Excalidraw elements, keeps an on-disk cache, and upserts them into HelixDB (nodes + relational edges).
- **Graph clustering** – recomputes semantic, spatial, and relational clusters so RAG agents can traverse the canvas meaningfully.
- **MCP tool bridge** – optional helpers that expose the Helix graph to Model Context Protocol agents.
- **Embeddings** – swap between OpenAI embeddings or shipped on-device models (`@xenova/transformers`) by toggling env flags.
- **Minimal auth surface** – the SDK is anonymous by default; pass `X-User-Id` or wrap the helpers with your own auth.

---

## When to use the server vs. SDK

| Scenario                                                                                    | What to run                                            |
| ------------------------------------------------------------------------------------------- | ------------------------------------------------------ |
| You already have a Node back end and want to call the ingestion + clustering logic directly | Import the SDK helpers (examples below)                |
| You need an HTTP façade quickly (CLI tests, Postman, edge deploy)                           | Launch `npm run dev` which spins up the Express facade |
| You want Treyspace’s full product surface (auth, subscriptions, real time scenes)           | Use the private build – it’s not part of this OSS repo |

> Importing `sdk/server.js` no longer boots Express automatically – the server starts only when you run `node server.js` or `npm run dev`.

---

## Repository layout

```
sdk/
├── server.js           # Express façade (optional)
├── lib/                # Cache, Helix client, embedding helpers
├── routes/             # HTTP routes (mounted by server.js)
└── Dockerfile          # Example container image for the server
```

---

## Quick start (server mode)

```bash
cd sdk
npm install

# point at your HelixDB instance (defaults shown)
export HELIX_ENDPOINT=http://localhost:6969
export PORT=3001

npm run dev
# Health probe
curl http://localhost:3001/health
```

Push a canvas delta:

```bash
curl -X POST http://localhost:3001/api/canvas/sync \
  -H 'Content-Type: application/json' \
  -d '{
        "boardId": "demo-board",
        "elements": [
          {"id":"rect-1","type":"rectangle","x":0,"y":0,"width":240,"height":120,"version":1,"text":"SDK demo"}
        ]
      }'
```

Run a cluster refresh:

```bash
curl -X POST http://localhost:3001/api/clusters \
  -H 'Content-Type: application/json' \
  -d '{"boardId": "demo-board"}'
```

---

## Programmatic usage

The core helpers can be used without spinning up the Express server. The snippet below shows the pattern – initialise the Helix client, wire the caches, and call the orchestration functions.

```js
import createHelixRagSDK from "./sdk.js"; // default export

const sdk = createHelixRagSDK({
  resolveUser(headers) {
    return headers["x-user-id"] || "build-script";
  },
});

await sdk.syncCanvas({
  boardId: "demo-board",
  elements: [{ id: "rect-1", type: "rectangle", x: 0, y: 0, width: 240, height: 120, version: 1 }],
});

await sdk.refreshClusters({ boardId: "demo-board" });

// Invoke any MCP helper exposed by routes/mcp.js
await sdk.callMcp("create-element", {
  boardId: "demo-board",
  element: { id: "node-2", type: "ellipse", x: 320, y: 40, width: 180, height: 180 },
});
```

> Prefer named imports? `import { createHelixRagSDK } from "./sdk.js";` works the same.

### SDK smoke test

We ship `tests/sdkSmoke.spec.mjs`, a self-contained script that spins up the Express server, stubs Helix/OpenAI, and drives the full flow (clusters, MCP traverse, AI synthesis).

```bash
node tests/sdkSmoke.spec.mjs
```

The script prints the raw JSON responses, a concise cluster summary, the AI engine status/text stream, and verifies that the orchestrator selects and executes the MCP cluster traversal tool.

Under the hood the SDK reuses the exact same handlers that power the optional HTTP façade, so behaviour stays in lock-step whether you embed it or run the server. Each method accepts an optional `context` with `userId` / custom headers if you need per-request identity.

---

## Environment reference

| Variable           | Purpose                                            | Default                 |
| ------------------ | -------------------------------------------------- | ----------------------- |
| `HELIX_ENDPOINT`   | HelixDB HTTP endpoint                              | `http://localhost:6969` |
| `PORT`             | Port for the optional Express server               | `3001`                  |
| `LOCAL_EMBEDDINGS` | Force on-device embeddings (`1`) instead of OpenAI | `0`                     |
| `OPENAI_API_KEY`   | OpenAI key for embeddings (optional)               | –                       |
| `AI_PROXY_URL`     | Downstream AI proxy for `/api/ai/engine`           | `http://localhost:8787` |

Copy `.env.example` and tweak as needed.

---

## Contributing

1. `npm install`
2. Run `npm run dev` (server) or import the helpers directly as shown above.
3. Tests are not bundled yet – feel free to add unit coverage around the orchestration helpers.

Issues and PRs that keep the SDK focused on “Excalidraw → Helix → RAG” are welcome. For auth, billing, and production hardening see the Treyspace closed-source build.
