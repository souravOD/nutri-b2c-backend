import { Router } from "express";
import type { Request, Response, NextFunction } from "express";
import { z } from "zod";
import { authMiddleware } from "../middleware/auth.js";
import { rateLimitMiddleware } from "../middleware/rateLimit.js";
import { requireB2cCustomerIdFromReq } from "../services/b2cIdentity.js";
import { processMessage, getRecentSessions } from "../services/chatbot.js";

const router = Router();
router.use(authMiddleware);

function b2cId(req: Request): string {
    return requireB2cCustomerIdFromReq(req);
}

const chatMessageSchema = z.object({
    message: z.string().min(1).max(500),
    sessionId: z.string().uuid().optional(),
});

// POST /api/v1/chat — send a message
router.post(
    "/",
    rateLimitMiddleware,
    async (req: Request, res: Response, next: NextFunction) => {
        try {
            const customerId = b2cId(req);
            const { message, sessionId } = chatMessageSchema.parse(req.body);
            const response = await processMessage(customerId, message.trim(), sessionId);
            res.json(response);
        } catch (err) {
            next(err);
        }
    }
);

// GET /api/v1/chat/history — recent sessions
router.get(
    "/history",
    rateLimitMiddleware,
    async (req: Request, res: Response, next: NextFunction) => {
        try {
            const customerId = b2cId(req);
            const sessions = await getRecentSessions(customerId, 10);
            res.json({ sessions });
        } catch (err) {
            next(err);
        }
    }
);

export default router;
