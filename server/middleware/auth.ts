// server/middleware/auth.ts
/* eslint-disable @typescript-eslint/no-explicit-any */

import type { Request, Response, NextFunction } from "express";
import { verifyAppwriteJWT, extractJWTFromHeaders, type UserContext } from "../auth/jwt.js";
import { handleAdminImpersonation } from "../auth/admin.js";
import { setCurrentUser } from "../config/database.js";
import { getB2cCustomerByAppwriteId } from "../services/b2cIdentity.js";
import { AppError } from "./errorHandler.js";
import { upsertProfileFromAppwrite } from "../services/supabaseSync.js";

// Re-export for consumers that import from auth.ts
export type { UserContext };

/**
 * Authentication middleware:
 * - Requires X-Appwrite-JWT
 * - Verifies JWT and supports admin read-only impersonation
 * - Populates req.user and DB context (setCurrentUser)
 * - Converts auth failures into clean 401 Problem Details via AppError
 */
export async function authMiddleware(
  req: Request,
  _res: Response,
  next: NextFunction
) {
  try {
    // Diagnostics — only log in development to avoid info leak in production
    if (process.env.NODE_ENV !== "production") {
      console.log(
        `[AUTH] ${req.method} ${req.url} (env=${process.env.NODE_ENV}) isAdminRoute=${req.url.includes(
          "/admin"
        )}`
      );
    }

    const jwt = extractJWTFromHeaders(req.headers);
    if (!jwt) {
      return next(
        new AppError(
          401,
          "Unauthorized",
          "X-Appwrite-JWT header required",
          req.url
        )
      );
    }

    // Base auth context from JWT
    const baseCtx = await verifyAppwriteJWT(jwt);

    // Allow admin read-only impersonation (function enforces rules)
    const ctx = await handleAdminImpersonation(req, baseCtx);

    // Resolve Gold b2c_customers.id once (uses unique index — fast)
    const effectiveId = ctx.effectiveUserId ?? ctx.userId;
    let customer = await getB2cCustomerByAppwriteId(effectiveId);

    // Auto-provision: valid Appwrite user but no Supabase row → create one
    if (!customer) {
      try {
        await upsertProfileFromAppwrite({
          appwriteId: effectiveId,
          profile: {
            displayName: ctx.name ?? null,
            email: ctx.email ?? null,
          },
          account: { email: ctx.email ?? null, name: ctx.name ?? null },
        });
        customer = await getB2cCustomerByAppwriteId(effectiveId);
      } catch (e) {
        console.error("[AUTH] Auto-provision b2c_customers failed:", e);
      }
    }

    // Expose to downstream handlers (keep it flexible type-wise)
    (req as any).user = {
      ...ctx,
      b2cCustomerId: customer?.id ?? undefined,
    } as UserContext;

    // Set effective user for DB/RLS context
    await setCurrentUser(ctx.effectiveUserId ?? ctx.userId);

    return next();
  } catch (error: any) {
    // Normalize all auth failures to 401
    return next(
      new AppError(
        401,
        "Unauthorized",
        error?.message || "Invalid or expired JWT",
        req.url
      )
    );
  }
}

/**
 * Optional auth:
 * - If no JWT, continue unauthenticated
 * - If JWT present, run full authMiddleware
 */
export function optionalAuth(req: Request, res: Response, next: NextFunction) {
  const jwt = extractJWTFromHeaders(req.headers);
  if (!jwt) return next();
  return authMiddleware(req, res, next);
}

// Some codepaths import a default middleware; keep this for compatibility.
export default authMiddleware;
