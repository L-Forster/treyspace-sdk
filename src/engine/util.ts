/**
 * Utility functions for backend engine
 *
 * Provides helpers for extracting request metadata and building HTTP headers
 * for proxying requests between backend, SDK façade, and external APIs.
 */

export interface RequestLike {
  headers: Record<string, string | undefined>;
  protocol?: string;
}

/**
 * Extracts the base URL for API proxying from request headers
 *
 * @param req - HTTP request-like object with headers
 * @returns Base URL for API calls
 *
 * Checks environment variables first, then constructs URL from request headers.
 * Supports forwarded headers (X-Forwarded-Proto, X-Forwarded-Host) for proxies.
 */
export const getProxyBaseFromReq = (req: RequestLike): string => {
  try {
    const env = (globalThis as any)?.process?.env || {};
    const configured =
      env.AI_BACKEND_PUBLIC_BASE ||
      env.AI_BACKEND_URL ||
      env.TREYSPACE_BACKEND_URL ||
      env.VITE_AI_BACKEND_URL ||
      env.VITE_TREYSPACE_BACKEND_URL;
    if (configured) {
      return String(configured)
        .trim()
        .replace(/\/$/, "")
        .replace(/\/v1\/responses$/, "");
    }

    const forwardedProto = req.headers["x-forwarded-proto"] as string | undefined;
    const forwardedHost = req.headers["x-forwarded-host"] as string | undefined;
    const proto = String(forwardedProto || req.protocol || "http");
    const rawHost = String(req.headers.host || "localhost:8788");
    const host = String(forwardedHost || rawHost);
    const isLoopback =
      /^localhost(?::\d+)?$/i.test(rawHost) ||
      /^127(?:\.\d{1,3}){3}(?::\d+)?$/.test(rawHost) ||
      /^0\.0\.0\.0(?::\d+)?$/.test(rawHost);
    const prefix = forwardedHost || !isLoopback ? "/api/ai-proxy" : "";
    const base = `${proto}://${host}${prefix}`.replace(/\/$/, "");
    return base;
  } catch {
    return "http://localhost:8790";
  }
};

/**
 * Builds HTTP headers for authenticated requests
 *
 * @param req - HTTP request-like object with headers
 * @param addInternalOrigin - Whether to add Origin header for internal requests
 * @returns Headers object for fetch requests
 *
 * Forwards Authorization header if present.
 * Adds Origin header when making requests to SDK façade.
 */
export const buildAuthHeadersFromReq = (req: RequestLike, addInternalOrigin = false) => {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  const auth = req.headers.authorization;
  if (typeof auth === "string") headers.Authorization = auth;
  if (addInternalOrigin) {
    const env = (globalThis as any)?.process?.env || {};
    const originHeader =
      env.HELIX_INTERNAL_ORIGIN || `${req.protocol || "http"}://${req.headers.host || "localhost"}`;
    headers.Origin = originHeader;
  }
  return headers;
};
