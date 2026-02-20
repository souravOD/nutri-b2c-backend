import type { Request, Response, NextFunction } from "express";
import { auditLog } from "../../shared/goldSchema.js";
import { db } from "../config/database.js";

const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isUuid(value?: string | null): value is string {
  if (!value) return false;
  return uuidRegex.test(value);
}

export async function auditLogEntry(
  actorUserId: string,
  action: string,
  targetTable: string,
  targetId: string,
  before?: any,
  after?: any,
  reason?: string,
  ip?: string,
  userAgent?: string
): Promise<void> {
  try {
    if (!isUuid(targetId)) {
      return;
    }

    const oldValues = before ?? null;
    const newValues = after || reason ? { after: after ?? null, reason: reason ?? null } : null;

    await db.insert(auditLog).values({
      tableName: targetTable,
      recordId: targetId,
      action,
      oldValues,
      newValues,
      changedBy: isUuid(actorUserId) ? actorUserId : null,
      changedAt: new Date(),
      ipAddress: ip,
      userAgent: userAgent ?? null,
    });
  } catch (error) {
    console.error("Failed to write audit log:", error);
  }
}

export function auditedRoute(handler: (req: Request, res: Response, next: NextFunction) => Promise<any>) {
  return async (req: Request, res: Response, next: NextFunction) => {
    let before: any = null;
    let after: any = null;

    try {
      const result = await handler(req, res, next);

      if (["POST", "PUT", "PATCH"].includes(req.method)) {
        after = result;
      }

      if (req.user) {
        await auditLogEntry(
          req.user.userId,
          `${req.method.toLowerCase()}_${req.route?.path || req.path}`,
          "various",
          req.params.id || "",
          before,
          after,
          req.body?.reason,
          req.ip,
          req.headers["user-agent"] as string | undefined
        );
      }

      return result;
    } catch (error) {
      next(error);
    }
  };
}
