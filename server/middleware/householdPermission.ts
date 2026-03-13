import type { Request, Response, NextFunction } from "express";
import { AppError } from "./errorHandler.js";

/**
 * Household role-based access control (RBAC) middleware.
 *
 * Usage in routes:
 *   router.post("/members", requireHouseholdRole("primary_adult"), handler);
 *   router.patch("/preferences/:id", requireHouseholdRole("primary_adult", "secondary_adult"), handler);
 *
 * Relies on `req.user.householdRole` being set by the auth middleware.
 */
export function requireHouseholdRole(...allowedRoles: string[]) {
  return (req: Request, _res: Response, next: NextFunction) => {
    const user = (req as any).user;

    if (!user?.householdRole) {
      return next(
        new AppError(403, "Forbidden", "No household role found for this user")
      );
    }

    if (!allowedRoles.includes(user.householdRole)) {
      return next(
        new AppError(
          403,
          "Forbidden",
          `This action requires one of: ${allowedRoles.join(", ")}. Your role: ${user.householdRole}`
        )
      );
    }

    next();
  };
}

/**
 * Check if the current user is the profile owner or a primary adult.
 * Used to gate member editing — you can edit your own profile, or
 * a primary_adult can edit child/dependent profiles.
 */
export function requireProfileEditAccess(
  req: Request,
  _res: Response,
  next: NextFunction
) {
  const user = (req as any).user;
  const targetMemberId = req.params.id || req.params.memberId;

  // Profile owners can always edit their own profile
  if (user?.b2cCustomerId === targetMemberId) {
    return next();
  }

  // Primary adults can edit other members
  if (user?.householdRole === "primary_adult") {
    return next();
  }

  // Everyone else gets blocked
  return next(
    new AppError(
      403,
      "Forbidden",
      "You can only edit your own profile, or you need primary_adult role to edit others"
    )
  );
}
