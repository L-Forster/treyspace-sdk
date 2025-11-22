#!/usr/bin/env node

/**
 * Simple smoke check that pings the backend health endpoint.
 * Requires the backend server to be running separately.
 */

const defaultHost = process.env.HOST || "127.0.0.1";
const defaultPort = process.env.PORT || "8788";
const baseUrl = process.env.AI_BACKEND_URL || `http://${defaultHost}:${defaultPort}`;

const url = new URL("/healthz", baseUrl);

console.log(`🔍 Checking backend health at ${url.toString()} …`);

try {
  const response = await fetch(url.toString(), {
    headers: { Accept: "application/json" },
  });

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(`Health check failed with status ${response.status} ${body ? `- ${body}` : ""}`);
  }

  const payload = await response.json().catch(() => null);
  console.log("✅ Backend is reachable.", payload ? `Response: ${JSON.stringify(payload)}` : "");
} catch (error) {
  console.error("❌ Could not reach backend:", error.message || error);
  process.exitCode = 1;
}
