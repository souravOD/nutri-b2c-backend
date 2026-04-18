// server/middleware/ipRateLimit.ts
// SEC-1: IP-based rate limiting for unauthenticated (public) endpoints.
// The standard rateLimitMiddleware skips when req.user is undefined,
// so public endpoints need IP-keyed throttling instead.

import type { Request, Response, NextFunction } from "express";

const MAX_STORE_SIZE = 50_000;
const ipStore = new Map<string, { count: number; resetTime: number }>();

/** Evict oldest 20 % of entries when Map exceeds cap */
function evictIfNeeded() {
  if (ipStore.size <= MAX_STORE_SIZE) return;
  const toDelete = Math.floor(ipStore.size * 0.2);
  let deleted = 0;
  for (const key of ipStore.keys()) {
    if (deleted >= toDelete) break;
    ipStore.delete(key);
    deleted++;
  }
}

/**
 * Create an IP-based rate-limit middleware.
 * @param maxRpm Maximum requests per minute per IP (default 30)
 */
export function ipRateLimitMiddleware(maxRpm: number = 30) {
  return (req: Request, res: Response, next: NextFunction) => {
    // Prefer X-Forwarded-For for accurate client IP behind reverse proxies
    const forwarded = req.headers["x-forwarded-for"];
    const ip = (typeof forwarded === "string"
      ? forwarded.split(",")[0].trim()
      : req.ip) || req.socket.remoteAddress || "unknown";
    const now = Date.now();
    const windowMs = 60_000; // 1 minute

    let bucket = ipStore.get(ip);
    if (!bucket || bucket.resetTime <= now) {
      bucket = { count: 0, resetTime: now + windowMs };
    }

    bucket.count++;
    ipStore.set(ip, bucket);
    evictIfNeeded();

    const remaining = Math.max(0, maxRpm - bucket.count);
    const resetTime = new Date(bucket.resetTime);

    res.setHeader("RateLimit", remaining.toString());
    res.setHeader("RateLimit-Policy", `${maxRpm};w=60`);
    res.setHeader("RateLimit-Reset", resetTime.toISOString());

    if (bucket.count > maxRpm) {
      const retryAfter = Math.ceil((bucket.resetTime - now) / 1000);
      res.setHeader("Retry-After", retryAfter.toString());
      return res.status(429).json({
        type: "about:blank",
        title: "Too Many Requests",
        status: 429,
        detail: `Rate limit exceeded. Maximum ${maxRpm} requests per minute.`,
        instance: req.url,
      });
    }

    next();
  };
}

// Periodic cleanup (5 min) — same pattern as rateLimit.ts
let cleanupTimer: ReturnType<typeof setInterval> | null = null;

export function startIpRateLimitCleanup() {
  if (cleanupTimer) return;
  cleanupTimer = setInterval(() => {
    const now = Date.now();
    for (const [key, bucket] of ipStore) {
      if (bucket.resetTime <= now) {
        ipStore.delete(key);
      }
    }
  }, 5 * 60 * 1000);
  cleanupTimer.unref();
}

export function stopIpRateLimitCleanup() {
  if (cleanupTimer) {
    clearInterval(cleanupTimer);
    cleanupTimer = null;
  }
}

startIpRateLimitCleanup();
