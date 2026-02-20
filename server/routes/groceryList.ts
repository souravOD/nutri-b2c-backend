import { Router } from "express";
import type { NextFunction, Request, Response } from "express";
import { z } from "zod";
import { authMiddleware } from "../middleware/auth.js";
import { rateLimitMiddleware } from "../middleware/rateLimit.js";
import { requireB2cCustomerIdFromReq } from "../services/b2cIdentity.js";
import {
  addGroceryListItem,
  deleteGroceryListItem,
  generateGroceryList,
  getGroceryItemSubstitutions,
  getGroceryListDetail,
  listGroceryLists,
  updateGroceryListStatus,
  updateGroceryListItem,
} from "../services/groceryList.js";

const router = Router();
router.use(authMiddleware);

function b2cId(req: Request): string {
  return requireB2cCustomerIdFromReq(req);
}

const statusEnum = z.enum(["draft", "active", "purchased", "archived"]);

const generateSchema = z.object({
  mealPlanId: z.string().uuid().optional(),
});

const listQuerySchema = z.object({
  status: statusEnum.optional(),
  limit: z.coerce.number().int().positive().max(100).optional(),
  offset: z.coerce.number().int().min(0).optional(),
});

const updateItemSchema = z
  .object({
    isPurchased: z.boolean().optional(),
    actualPrice: z.number().min(0).optional(),
    substitutedProductId: z.string().uuid().optional(),
  })
  .refine(
    (data) =>
      data.isPurchased !== undefined ||
      data.actualPrice !== undefined ||
      data.substitutedProductId !== undefined,
    { message: "At least one field is required" }
  );

const addItemSchema = z.object({
  itemName: z.string().min(1).max(255),
  quantity: z.number().positive(),
  unit: z.string().max(50).optional(),
  category: z.string().max(100).optional(),
  estimatedPrice: z.number().min(0).optional(),
});

const updateStatusSchema = z.object({
  status: z.enum(["active", "purchased"]),
});

router.post(
  "/generate",
  rateLimitMiddleware,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const customerId = b2cId(req);
      const parsed = generateSchema.parse(req.body ?? {});
      const result = await generateGroceryList(customerId, parsed);
      res.status(201).json(result);
    } catch (err) {
      next(err);
    }
  }
);

router.get(
  "/",
  rateLimitMiddleware,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const customerId = b2cId(req);
      const parsed = listQuerySchema.parse(req.query ?? {});
      const result = await listGroceryLists(
        customerId,
        parsed.status,
        parsed.limit ?? 20,
        parsed.offset ?? 0
      );
      res.json(result);
    } catch (err) {
      next(err);
    }
  }
);

router.get(
  "/:id",
  rateLimitMiddleware,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const customerId = b2cId(req);
      const result = await getGroceryListDetail(customerId, req.params.id);
      res.json(result);
    } catch (err) {
      next(err);
    }
  }
);

router.put(
  "/:id/status",
  rateLimitMiddleware,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const customerId = b2cId(req);
      const parsed = updateStatusSchema.parse(req.body ?? {});
      const result = await updateGroceryListStatus(customerId, req.params.id, parsed.status);
      res.json(result);
    } catch (err) {
      next(err);
    }
  }
);

router.put(
  "/:id/items/:itemId",
  rateLimitMiddleware,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const customerId = b2cId(req);
      const parsed = updateItemSchema.parse(req.body ?? {});
      const result = await updateGroceryListItem(customerId, req.params.id, req.params.itemId, parsed);
      res.json(result);
    } catch (err) {
      next(err);
    }
  }
);

router.post(
  "/:id/items",
  rateLimitMiddleware,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const customerId = b2cId(req);
      const parsed = addItemSchema.parse(req.body ?? {}) as {
        itemName: string;
        quantity: number;
        unit?: string;
        category?: string;
        estimatedPrice?: number;
      };
      const result = await addGroceryListItem(customerId, req.params.id, parsed);
      res.status(201).json(result);
    } catch (err) {
      next(err);
    }
  }
);

router.delete(
  "/:id/items/:itemId",
  rateLimitMiddleware,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const customerId = b2cId(req);
      const result = await deleteGroceryListItem(customerId, req.params.id, req.params.itemId);
      res.json(result);
    } catch (err) {
      next(err);
    }
  }
);

router.get(
  "/:id/items/:itemId/substitutions",
  rateLimitMiddleware,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const customerId = b2cId(req);
      const result = await getGroceryItemSubstitutions(customerId, req.params.id, req.params.itemId);
      res.json(result);
    } catch (err) {
      next(err);
    }
  }
);

export default router;

