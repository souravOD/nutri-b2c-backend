// server/middleware/auth.ts
/* eslint-disable @typescript-eslint/no-explicit-any */

import type { Request, Response, NextFunction } from "express";
import { verifyAppwriteJWT, extractJWTFromHeaders } from "../auth/jwt.js";
import { handleAdminImpersonation } from "../auth/admin.js";
import { setCurrentUser } from "../config/database.js";
import { getB2cCustomerByAppwriteId } from "../services/b2cIdentity.js";
import { AppError } from "./errorHandler.js";

/**
 * Optionally export a light type others can use.
 * (Safe even if the rest of the codebase doesn't import it.)
 */
export type UserContext = {
  userId: string;
  effectiveUserId?: string;
  b2cCustomerId?: string;
  isAdmin?: boolean;
  isImpersonating?: boolean;
  profile?: any;
};

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
    // Diagnostics (fixes the old "....env.NODE_ENV" bug)
    console.log(
      `[AUTH] ${req.method} ${req.url} (env=${process.env.NODE_ENV}) isAdminRoute=${req.url.includes(
        "/admin"
      )}`
    );

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
    const customer = await getB2cCustomerByAppwriteId(effectiveId);

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
