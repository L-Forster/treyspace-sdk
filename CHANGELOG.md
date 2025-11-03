# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Removed

- Dropped the legacy `/v1/chat/completions` OpenAI passthrough; `POST /v1/responses` remains the supported entry point.

## [1.0.0] - 2025-01-XX

### Added

- Initial open source release
- Full RAG pipeline for canvas-based knowledge graphs
- OpenAI Responses API proxy with canvas-specific security
- Semantic clustering via Helix DB integration
- MCP (Model Context Protocol) tool support
- Server-Sent Events (SSE) streaming for real-time responses
- SDK façade for graph operations
- Comprehensive documentation (API, Configuration, Pipeline Guide)
- JSDoc comments for all public APIs
- TypeScript support with full type definitions

### Features

- **Backend Server** (`src/index.js`)
  - `/v1/responses` - OpenAI Responses API wrapper
  - `/api/ai/engine` - Full RAG pipeline with streaming
  - `/api/clusters` - Cluster management proxy
  - `/api/mcp-bridge` - MCP tool bridge

- **AI Engine** (`src/engine/`)
  - Automatic chat history summarization
  - Intelligent tool selection for cluster traversal
  - Semantic cluster description generation
  - Multi-model support (GPT-4, GPT-5 series)

- **SDK** (`sdk/`)
  - `createHelixRagSDK()` - SDK factory function
  - `executeFullPipeline()` - Complete RAG pipeline
  - `startHelixFacadeServer()` - Server lifecycle management
  - Canvas sync and cluster management

### Documentation

- API reference with request/response examples
- Configuration guide with environment variables
- Step-by-step pipeline walkthrough
- Contributing guidelines
- Code of Conduct
- Security policy

### Developer Experience

- Comprehensive inline comments
- Named constants (no magic numbers)
- Clear error messages
- Type safety with TypeScript
- Example scripts for common operations

---

## Release Notes Template

### Added

- New features

### Changed

- Changes in existing functionality

### Deprecated

- Soon-to-be removed features

### Removed

- Removed features

### Fixed

- Bug fixes

### Security

- Security improvements
