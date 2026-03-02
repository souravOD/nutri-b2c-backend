import { Router } from "express";
import type { Request, Response, NextFunction } from "express";
import { z } from "zod";
import { authMiddleware } from "../middleware/auth.js";
import { rateLimitMiddleware } from "../middleware/rateLimit.js";
import { requireB2cCustomerIdFromReq } from "../services/b2cIdentity.js";
import { AppError } from "../middleware/errorHandler.js";
import {
    getNotifications,
    getUnreadCount,
    markAsRead,
    markAllAsRead,
} from "../services/notifications.js";

const router = Router();
router.use(authMiddleware);

function b2cId(req: Request): string {
    return requireB2cCustomerIdFromReq(req);
}

// ── GET /api/v1/notifications ───────────────────────────────────────────────
// Fetch paginated notifications with optional type filter
router.get(
    "/",
    rateLimitMiddleware,
    async (req: Request, res: Response, next: NextFunction) => {
        try {
            const customerId = b2cId(req);
            const type = req.query.type as string | undefined;
            const limit = Math.min(
                Math.max(parseInt(req.query.limit as string, 10) || 20, 1),
                100
            );
            const offset = Math.max(
                parseInt(req.query.offset as string, 10) || 0,
                0
            );

            // Validate type if provided
            const validTypes = [
                "meal",
                "nutrition",
                "grocery",
                "budget",
                "family",
                "system",
            ];
            if (type && !validTypes.includes(type)) {
                throw new AppError(
                    400,
                    "Bad Request",
                    `Invalid notification type. Must be one of: ${validTypes.join(", ")}`
                );
            }

            const result = await getNotifications({
                customerId,
                type,
                limit,
                offset,
            });
            res.json(result);
        } catch (err) {
            next(err);
        }
    }
);

// ── GET /api/v1/notifications/unread-count ──────────────────────────────────
router.get(
    "/unread-count",
    rateLimitMiddleware,
    async (req: Request, res: Response, next: NextFunction) => {
        try {
            const customerId = b2cId(req);
            const count = await getUnreadCount(customerId);
            res.json({ count });
        } catch (err) {
            next(err);
        }
    }
);

// ── PATCH /api/v1/notifications/:id/read ────────────────────────────────────
// Mark a single notification as read
router.patch(
    "/:id/read",
    rateLimitMiddleware,
    async (req: Request, res: Response, next: NextFunction) => {
        try {
            const customerId = b2cId(req);
            const { id } = req.params;

            // Validate UUID format
            z.string().uuid().parse(id);

            const notification = await markAsRead(id, customerId);
            if (!notification) {
                throw new AppError(404, "Not Found", "Notification not found");
            }
            res.json({ notification });
        } catch (err) {
            next(err);
        }
    }
);

// ── POST /api/v1/notifications/read-all ─────────────────────────────────────
// Mark all notifications as read for the current user
router.post(
    "/read-all",
    rateLimitMiddleware,
    async (req: Request, res: Response, next: NextFunction) => {
        try {
            const customerId = b2cId(req);
            const count = await markAllAsRead(customerId);
            res.json({ markedCount: count });
        } catch (err) {
            next(err);
        }
    }
);

export default router;
