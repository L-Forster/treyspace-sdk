# Canvas RAG Pipeline

End-to-end guide for exercising the canvas Retrieval-Augmented Generation (RAG) flow that powers the Treyspace SDK. The pipeline has three major stages:

1. **Sync** – persist an Excalidraw snapshot via `POST /api/canvas/sync`
2. **Cluster** – compute semantic, spatial, and relational clusters via `/api/clusters`
3. **Explain** – stream an LLM answer about the board via `/api/ai/engine`

The SDK ships with automated tests that orchestrate every step automatically.

---

## Automated full-pipeline run

Use the integration spec (`tests/runFullPipeline.spec.mjs`) to verify the flow without writing any glue code.

```bash
# 0. Install dependencies (root + sdk/) if you haven't already
npm install
(cd sdk && npm install)

# 1. Provide an OpenAI key so the AI proxy can call /v1/responses
export OPENAI_API_KEY=sk-...

# 2. Execute the integration script
npm run test:integration
# or: node tests/runFullPipeline.spec.mjs
```

What the script does:

- Starts an in-process Helix façade (`sdk/server.js`) and the AI proxy (`src/index.js`)
- Seeds a sample board (`board-full-pipeline`) with elements defined in the spec
- Runs `executeFullPipeline`, which syncs the canvas, builds clusters, and streams an answer
- Prints the final response text and exits with `0` on success

> The SDK manages both servers automatically—no additional `npm start` processes are required when you use `executeFullPipeline` or the integration test helper.

Refer to `tests/runFullPipeline.spec.mjs` if you need a concrete payload example for your own tooling.

---

## Troubleshooting

- **No clusters returned**
  - Confirm Helix DB is reachable and `helix-ts` is installed
  - Check the façade logs for serialization errors
  - Ensure the synced board has more than one non-deleted element

- **Empty or failing AI responses**
  - Verify `OPENAI_API_KEY` is exported before starting the proxy
  - Inspect proxy logs for `OpenAI error` messages
  - Make sure `/api/clusters` returns populated clusters for the target `boardId`

- **CORS failures**
  - Adjust `ALLOWED_ORIGINS` (proxy) and `ALLOW_LOCALHOST_ORIGINS` (SDK) in `.env`
  - Restart both processes after changing configuration

For a working baseline, re-run `npm run test:integration` and compare the console output with your environment.
