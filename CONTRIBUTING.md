# Contributing to Treyspace SDK

Thank you for your interest in contributing to Treyspace SDK! This document provides guidelines and instructions for contributing.

## Table of Contents

- [Code of Conduct](#code-of-conduct)
- [Getting Started](#getting-started)
- [Development Setup](#development-setup)
- [How to Contribute](#how-to-contribute)
- [Coding Standards](#coding-standards)
- [Commit Messages](#commit-messages)
- [Pull Request Process](#pull-request-process)
- [Testing](#testing)

## Code of Conduct

This project adheres to a [Code of Conduct](CODE_OF_CONDUCT.md). By participating, you are expected to uphold this code.

## Getting Started

1. Fork the repository
2. Clone your fork: `git clone https://github.com/YOUR_USERNAME/treyspace-sdk.git`
3. Add upstream remote: `git remote add upstream https://github.com/L-Forster/treyspace-sdk.git`
4. Create a feature branch: `git checkout -b feature/your-feature-name`

## Development Setup

### Prerequisites

- Node.js >= 18.0.0
- npm >= 9.0.0
- Helix DB instance (for integration tests)

### Installation

```bash
# Install dependencies
npm install

# Install SDK dependencies
cd sdk && npm install && cd ..

# Copy environment template
cp .env.example .env
# Add your OPENAI_API_KEY to .env
```

### Running Locally

```bash
# Start SDK façade
cd sdk && node server.js

# In another terminal, start backend
npm run start:dev

# Run smoke tests
npm run smoke
```

## How to Contribute

### Reporting Bugs

- Use the [GitHub issue tracker](https://github.com/L-Forster/treyspace-sdk/issues)
- Check if the issue already exists
- Include:
  - Clear description
  - Steps to reproduce
  - Expected vs actual behavior
  - Environment details (Node version, OS)
  - Error messages and logs

### Suggesting Features

- Open an issue with the `enhancement` label
- Describe the use case and benefits
- Be open to discussion and alternative solutions

### Code Contributions

1. **Pick an issue** - Look for `good first issue` or `help wanted` labels
2. **Discuss first** - For large changes, open an issue to discuss the approach
3. **Write tests** - All new features should include tests
4. **Update docs** - Keep documentation in sync with code changes

## Coding Standards

### JavaScript/TypeScript

- **Style**: Follow existing code style
- **Comments**:
  - Add JSDoc comments for all public functions
  - Add file headers explaining the module's purpose
  - Comment complex logic inline
- **Naming**:
  - `camelCase` for variables and functions
  - `PascalCase` for classes
  - `UPPER_SNAKE_CASE` for constants
  - Descriptive names, avoid abbreviations

### File Organization

```
src/
  index.js          # Backend server
  engine/           # AI pipeline components
    AIEngine.ts     # Main RAG orchestrator
    ...

sdk/
  core/index.js     # SDK factory
  server.js         # Façade server
  ...

docs/               # Documentation
tests/              # Test files
```

### Code Quality

- No `console.log` in production code (use proper logging)
- Extract magic numbers to named constants
- Keep functions focused (single responsibility)
- Avoid deep nesting (max 3-4 levels)
- Handle errors gracefully

## Commit Messages

Follow [Conventional Commits](https://www.conventionalcommits.org/):

```
<type>(<scope>): <subject>

<body>

<footer>
```

**Types:**

- `feat`: New feature
- `fix`: Bug fix
- `docs`: Documentation changes
- `style`: Code style changes (formatting, no logic change)
- `refactor`: Code refactoring
- `test`: Adding or updating tests
- `chore`: Maintenance tasks

**Examples:**

```
feat(engine): add streaming support for cluster traversal

Add ability to stream cluster members incrementally instead of
loading all at once. Improves performance for large clusters.

Closes #123
```

```
fix(sdk): handle connection timeout in MCP manager

Previously, connections would hang indefinitely. Now times out
after 30 seconds and retries automatically.
```

## Pull Request Process

1. **Update documentation** - Ensure README, API docs, and inline comments reflect your changes
2. **Add tests** - Include unit and/or integration tests
3. **Run tests locally**:
   ```bash
   npm run typecheck
   npm run smoke
   npm run test
   ```
4. **Update CHANGELOG.md** - Add entry under "Unreleased" section
5. **Create PR**:
   - Use a descriptive title
   - Reference related issues
   - Describe what changed and why
   - Include screenshots/examples if applicable
6. **Address review feedback** - Be responsive to code review comments
7. **Keep PR focused** - One feature/fix per PR

### PR Checklist

- [ ] Code follows project style guidelines
- [ ] Comments added for complex logic
- [ ] Documentation updated
- [ ] Tests added/updated
- [ ] All tests passing
- [ ] CHANGELOG.md updated
- [ ] No merge conflicts

## Testing

### Running Tests

```bash
# Type checking
npm run typecheck

# Health check
npm run smoke

# Unit tests
npm run test

# Integration tests (requires Helix DB)
npm run test:integration
```

### Writing Tests

- Place tests in `tests/` directory
- Name files `*.spec.mjs` or `*.test.mjs`
- Test both success and error cases
- Mock external dependencies (OpenAI, Helix) when appropriate

## Questions?

- Open a [discussion](https://github.com/L-Forster/treyspace-sdk/discussions)
- Tag maintainers in issues for urgent questions

---

Thank you for contributing! 🎉
