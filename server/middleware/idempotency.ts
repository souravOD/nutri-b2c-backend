import type { Request, Response, NextFunction } from "express";
import { createHash } from "crypto";

type IdempotencyRecord = {
  method: string;
  path: string;
  requestHash: string;
  responseStatus?: number;
  responseBody?: any;
  expiresAt: number;
};

const TTL_MS = Number(process.env.IDEMPOTENCY_TTL_MS ?? 15 * 60 * 1000);
const store = new Map<string, IdempotencyRecord>();

function getRecord(key: string): IdempotencyRecord | undefined {
  const record = store.get(key);
  if (!record) return undefined;
  if (record.expiresAt <= Date.now()) {
    store.delete(key);
    return undefined;
  }
  return record;
}

export async function idempotencyMiddleware(req: Request, res: Response, next: NextFunction) {
  const idempotencyKey = req.headers["idempotency-key"] as string | undefined;

  if (["POST", "PUT", "PATCH"].includes(req.method) && !idempotencyKey) {
    return res.status(400).json({
      type: "about:blank",
      title: "Bad Request",
      status: 400,
      detail: "Idempotency-Key header required for state-changing operations",
      instance: req.url,
    });
  }

  if (!idempotencyKey) {
    return next();
  }

  try {
    const requestHash = createHash("sha256")
      .update(JSON.stringify(req.body || {}))
      .digest("hex");

    const existing = getRecord(idempotencyKey);

    if (existing) {
      if (existing.method !== req.method || existing.path !== req.path) {
        return res.status(409).json({
          type: "about:blank",
          title: "Conflict",
          status: 409,
          detail: "Idempotency key reused with different method or path",
          instance: req.url,
        });
      }

      if (existing.requestHash !== requestHash) {
        return res.status(409).json({
          type: "about:blank",
          title: "Conflict",
          status: 409,
          detail: "Idempotency key reused with different request body",
          instance: req.url,
        });
      }

      if (existing.responseStatus !== undefined) {
        return res.status(existing.responseStatus).json(existing.responseBody);
      }
    } else {
      store.set(idempotencyKey, {
        method: req.method,
        path: req.path,
        requestHash,
        expiresAt: Date.now() + TTL_MS,
      });
    }

    res.locals.idempotencyKey = idempotencyKey;

    next();
  } catch (error) {
    console.error("Idempotency middleware error:", error);
    next();
  }
}

export function storeIdempotentResponse(req: Request, res: Response, next: NextFunction) {
  const originalJson = res.json;
  const idempotencyKey = res.locals.idempotencyKey as string | undefined;

  if (idempotencyKey && ["POST", "PUT", "PATCH"].includes(req.method)) {
    res.json = function (body: any) {
      const record = getRecord(idempotencyKey);
      if (record) {
        record.responseStatus = res.statusCode;
        record.responseBody = body;
        record.expiresAt = Date.now() + TTL_MS;
        store.set(idempotencyKey, record);
      }
      return originalJson.call(this, body);
    };
  }

  next();
}
