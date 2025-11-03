# Configuration

Environment variables for Treyspace SDK.

## Backend Variables

| Variable                | Description                       | Default                                       |
| ----------------------- | --------------------------------- | --------------------------------------------- |
| `NODE_ENV`              | Environment mode                  | `development`                                 |
| `PORT`                  | HTTP port                         | `8787`                                        |
| `HOST`                  | Bind address                      | `0.0.0.0`                                     |
| `LOG_LEVEL`             | Logging level                     | `info`                                        |
| `ALLOWED_ORIGINS`       | CORS allow-list (comma-separated) | `http://localhost:3000,http://localhost:5173` |
| `OPENAI_API_KEY`        | **Required** for LLM responses    | -                                             |
| `OPENAI_DEFAULT_MODEL`  | Default OpenAI model              | `gpt-5`                                       |
| `HELIX_RAG_URL`         | SDK façade URL                    | `http://localhost:3001`                       |


## SDK Façade Variables

| Variable           | Description                  | Default                 |
| ------------------ | ---------------------------- | ----------------------- |
| `PORT`             | HTTP port                    | `3001`                  |
| `HELIX_ENDPOINT`   | Helix DB endpoint            | `http://localhost:6969` |
| `LOCAL_EMBEDDINGS` | Use local embeddings (1=yes) | `0`                     |
| `OPENAI_API_KEY`   | For OpenAI embeddings        | -                       |
