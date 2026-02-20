// server/index.ts
import { Pool } from "pg";
import 'dotenv/config';
import { config as loadEnv } from "dotenv";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import app from "./app.js";

// prefer .env.local, fallback to .env (works on Windows too)
const CWD = process.cwd();
const envFile =
  [".env.local", ".env"].map((f) => resolve(CWD, f)).find((p) => existsSync(p));

if (envFile) {
  loadEnv({ path: envFile });
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
const DATABASE_URL = process.env.DATABASE_URL;

if (!DATABASE_URL) {
  console.error("[boot] DATABASE_URL is missing. Set it in .env.local");
  process.exit(1);
}

const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: process.env.NODE_ENV === "production" ? { rejectUnauthorized: false } : undefined,
});

pool
  .query("select 1")
  .then(() => console.log("[db] connected"))
  .catch((err) => {
    console.error("[db] connection failed:", err);
    process.exit(1);
  });

const server = app.listen(PORT, HOST, () => {
  console.log(`[express] 🚀 Nutrition Backend running on http://${HOST}:${PORT}`);
  console.log(`[express] Environment: ${NODE_ENV}`);
  console.log(`[express] CORS origins: ${WEB_ORIGINS.join(", ")}`);
});

// Prevent keep-alive race condition with reverse proxies (Next.js rewrite proxy).
// Backend keepAliveTimeout MUST be longer than the proxy's to avoid ECONNRESET.
server.keepAliveTimeout = 65_000;
server.headersTimeout = 66_000;
// Allow long-running requests (LLM calls can take 30-60s)
server.timeout = 0;
