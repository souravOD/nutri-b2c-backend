import { Router } from "express";
import type { Request, Response, NextFunction } from "express";
import { z } from "zod";
import { authMiddleware } from "../middleware/auth.js";
import { rateLimitMiddleware } from "../middleware/rateLimit.js";
import { requireB2cCustomerIdFromReq } from "../services/b2cIdentity.js";
import {
    getIngredientSubstitutions,
    getProductSubstitutions,
} from "../services/substitutions.js";

const router = Router();
router.use(authMiddleware);

function b2cId(req: Request): string {
    return requireB2cCustomerIdFromReq(req);
}

const memberQuerySchema = z.object({
    memberId: z.string().uuid().optional(),
});

// GET /api/v1/substitutions/ingredient/:ingredientId?memberId=xxx
router.get(
    "/ingredient/:ingredientId",
    rateLimitMiddleware,
    async (req: Request, res: Response, next: NextFunction) => {
        try {
            const customerId = b2cId(req);
            const { ingredientId } = req.params;
            const { memberId } = memberQuerySchema.parse(req.query ?? {});
            const result = await getIngredientSubstitutions(customerId, ingredientId, memberId);
            res.json(result);
        } catch (err) {
            next(err);
        }
    }
);

// GET /api/v1/substitutions/product/:productId?memberId=xxx
router.get(
    "/product/:productId",
    rateLimitMiddleware,
    async (req: Request, res: Response, next: NextFunction) => {
        try {
            const customerId = b2cId(req);
            const { productId } = req.params;
            const { memberId } = memberQuerySchema.parse(req.query ?? {});
            const result = await getProductSubstitutions(customerId, productId, memberId);
            res.json(result);
        } catch (err) {
            next(err);
        }
    }
);

export default router;
