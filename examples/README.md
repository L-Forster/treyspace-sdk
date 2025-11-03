# SDK Usage Examples

## Installation

```bash
npm install treyspace-sdk
```

## Quick Start

```javascript
import { executeFullPipeline } from "treyspace-sdk";

const result = await executeFullPipeline({
  boardId: "my-board",
  userMessage: "What's in this diagram?",
  elements: [
    {
      id: "box-1",
      type: "rectangle",
      x: 100,
      y: 100,
      width: 150,
      height: 80,
      text: "Frontend"
    },
    {
      id: "box-2",
      type: "rectangle",
      x: 350,
      y: 100,
      width: 150,
      height: 80,
      text: "Backend"
    }
  ],
  userId: "user-123"
});

console.log(result.text); // AI's analysis of the diagram
```

## Available Functions

### `executeFullPipeline(options)`
Complete RAG pipeline - handles server startup, clustering, and AI inference automatically.

### `createHelixRagSDK(options)`
Create a low-level SDK instance for custom integrations.

### Server Management (Advanced)
- `startHelixFacadeServer(options)` - Start the graph database facade
- `stopHelixFacadeServer()` - Stop the facade
- `startPipelineBackend(helixUrl)` - Start the AI pipeline backend
- `stopPipelineBackend()` - Stop the backend

## Run the Examples

```bash
# Minimal pipeline example
node examples/minimal-pipeline.mjs

# Full smoke test
npm run test:smoke
```
