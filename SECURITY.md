# Security Policy

## Supported Versions

| Version | Supported          |
| ------- | ------------------ |
| 1.x.x   | :white_check_mark: |

## Reporting a Vulnerability

We take the security of Treyspace SDK seriously. If you discover a security vulnerability, please follow these steps:

### 1. **Do Not** Open a Public Issue

Please **do not** open a public GitHub issue for security vulnerabilities. This helps prevent exploitation before a fix is available.

### 2. Report Privately

Report security vulnerabilities by:

- Opening a [security advisory](https://github.com/L-Forster/treyspace-sdk/security/advisories/new) on GitHub
- Or emailing the maintainers (check the repository for contact information)

### 3. Include Details

When reporting, please include:

- Description of the vulnerability
- Steps to reproduce
- Potential impact
- Suggested fix (if any)
- Your contact information for follow-up

### 4. Response Timeline

- **Initial Response**: Within 48 hours
- **Status Update**: Within 1 week
- **Fix Timeline**: Depends on severity
  - Critical: Within 7 days
  - High: Within 14 days
  - Medium: Within 30 days
  - Low: Next release cycle

## Security Best Practices

### For Developers

1. **Never Commit Secrets**
   - Keep `.env` in `.gitignore`
   - Use `.env.example` for templates
   - Rotate API keys if accidentally committed

2. **Input Validation**
   - All user input is sanitized (see `src/index.js` sanitizeString)
   - Request body size limits enforced (1MB)
   - Input length limits on all text fields

3. **Dependencies**
   - Regularly update dependencies: `npm audit`
   - Review security advisories
   - Use `npm audit fix` for automated fixes

4. **Authentication**
   - This SDK has **no built-in authentication**
   - **Required**: Add your own auth middleware for production
   - Example: Bearer tokens, API keys, OAuth

### For Deployment

1. **Environment Variables**

   ```bash
   # Required
   OPENAI_API_KEY=sk-...

   # Recommended
   ALLOWED_ORIGINS=https://your-domain.com
   NODE_ENV=production
   ```

2. **Network Security**
   - Use HTTPS in production
   - Configure `ALLOWED_ORIGINS` properly
   - Consider rate limiting (not included in SDK)
   - Run behind a reverse proxy (NGINX, Cloudflare)

3. **Secrets Management**
   - Use environment variables
   - Consider: AWS Secrets Manager, HashiCorp Vault, etc.
   - Rotate API keys regularly

4. **Monitoring**
   - Monitor for unusual API usage
   - Set up alerts for error spikes
   - Log security-relevant events

## Known Security Limitations

### No Built-in Authentication

⚠️ **This SDK does not include authentication or rate limiting.**

For production use, you must add:

- Authentication middleware (Express middleware, API gateway)
- Rate limiting (express-rate-limit, Redis-based)
- Request validation (Zod schemas included but not enforced)

Example:

```javascript
import rateLimit from "express-rate-limit";

const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100, // limit each IP to 100 requests per windowMs
});

app.use("/api/", limiter);
```

### CORS Configuration

Default CORS allows all origins (`*`) in development. **Must** configure `ALLOWED_ORIGINS` for production.

### Third-Party Dependencies

This SDK depends on:

- OpenAI API (requires API key)
- Helix DB (graph database)

Security is dependent on these services. Keep credentials secure.

## Security Features

✅ **Input Sanitization**: All user input sanitized before LLM requests
✅ **Request Size Limits**: 1MB request body limit
✅ **Injection Prevention**: Code block markers escaped
✅ **Error Handling**: No sensitive data in error messages
✅ **HTTPS Support**: Ready for HTTPS deployment
✅ **Security Headers**: Includes X-Content-Type-Options, Referrer-Policy

## Disclosure Policy

When a vulnerability is reported and fixed:

1. **Patch Release**: Security fix released as soon as possible
2. **Security Advisory**: Published on GitHub
3. **Credit**: Reporter credited (if desired) in advisory and CHANGELOG
4. **Notification**: Users notified via release notes

## Hall of Fame

Contributors who responsibly disclose security vulnerabilities will be listed here.

---

Thank you for helping keep Treyspace SDK secure! 🔒
