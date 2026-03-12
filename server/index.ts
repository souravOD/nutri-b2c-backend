// server/index.ts
import 'dotenv/config';
import { config as loadEnv } from "dotenv";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import app from "./app.js";
import { queryClient, checkDatabaseHealth } from "./config/database.js";
import { startNotificationCron } from "./scheduler.js";

// prefer .env.local, fallback to .env (works on Windows too)
const CWD = process.cwd();
const envFile =
  [".env.local", ".env"].map((f) => resolve(CWD, f)).find((p) => existsSync(p));

if (envFile) {
  loadEnv({ path: envFile, override: false });
  console.log(`[boot] env loaded: ${envFile}`);
} else {
  console.warn("[boot] no .env.local or .env found in", CWD);
}

const NODE_ENV = process.env.NODE_ENV ?? "development";
const PORT = Number(process.env.PORT ?? 5000);
const HOST = process.env.HOST ?? "127.0.0.1";
const WEB_ORIGINS = (process.env.WEB_ORIGINS ??
  "http://127.0.0.1:3000,http://localhost:3000")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

// Verify DB connectivity using the primary Drizzle postgres.js connection
// (no separate pg.Pool needed — all routes use postgres.js via Drizzle)
checkDatabaseHealth()
  .then((ok) => {
    if (ok) console.log("[db] connected");
    else {
      console.error("[db] connection failed");
      process.exit(1);
    }
  });

const server = app.listen(PORT, HOST, () => {
  console.log(`[express] 🚀 Nutrition Backend running on http://${HOST}:${PORT}`);
  console.log(`[express] Environment: ${NODE_ENV}`);
  console.log(`[express] CORS origins: ${WEB_ORIGINS.join(", ")}`);
  startNotificationCron();
});

// Prevent keep-alive race condition with reverse proxies (Next.js rewrite proxy).
// Backend keepAliveTimeout MUST be longer than the proxy's to avoid ECONNRESET.
server.keepAliveTimeout = 65_000;
server.headersTimeout = 66_000;
// Allow long-running requests (LLM calls can take 30-60s) but cap at 5 minutes
// to prevent connections from being held indefinitely.
server.timeout = 5 * 60 * 1000;

// =============================================================================
// GRACEFUL SHUTDOWN
// =============================================================================
let isShuttingDown = false;

async function gracefulShutdown(signal: string) {
  if (isShuttingDown) return;
  isShuttingDown = true;
  console.log(`[shutdown] Received ${signal}. Closing server gracefully...`);

  // Force exit after 15s if graceful shutdown stalls — placed FIRST to bound total time
  const forceExitTimer = setTimeout(() => {
    console.error("[shutdown] Forceful exit after timeout.");
    process.exit(1);
  }, 15_000);
  forceExitTimer.unref();

  try {
    // Stop accepting new connections and wait for in-flight requests to finish
    await new Promise<void>((resolve) => {
      server.close(() => {
        console.log("[shutdown] HTTP server closed.");
        resolve();
      });
    });

    // Drain DB connections after HTTP server is fully closed
    try {
      await queryClient.end({ timeout: 10 });
      console.log("[shutdown] DB connections drained.");
    } catch (err) {
      console.error("[shutdown] Error closing DB connections:", err);
    }
  } finally {
    clearTimeout(forceExitTimer);
  }
}

process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));
process.on("SIGINT", () => gracefulShutdown("SIGINT"));
