import { Router } from "express";
import type { Request, Response, NextFunction } from "express";
import { z } from "zod";
import { authMiddleware } from "../middleware/auth.js";
import { rateLimitMiddleware } from "../middleware/rateLimit.js";
import { requireB2cCustomerIdFromReq } from "../services/b2cIdentity.js";
import { AppError } from "../middleware/errorHandler.js";
import {
  generateMealPlan,
  listPlans,
  getPlanDetail,
  activatePlan,
  swapMeal,
  regeneratePlan,
  deletePlan,
  logMealFromPlan,
} from "../services/mealPlan.js";

const router = Router();
router.use(authMiddleware);

function b2cId(req: Request): string {
  return requireB2cCustomerIdFromReq(req);
}

const dateRegex = /^\d{4}-\d{2}-\d{2}$/;
const mealTypeEnum = z.enum(["breakfast", "lunch", "dinner", "snack"]);

// ── Validation Schemas ──────────────────────────────────────────────────────

const generateSchema = z.object({
  startDate: z.string().regex(dateRegex, "startDate must be YYYY-MM-DD"),
  endDate: z.string().regex(dateRegex, "endDate must be YYYY-MM-DD"),
  memberIds: z.array(z.string().uuid()).min(1, "At least one member is required"),
  budgetAmount: z.number().positive().optional(),
  budgetCurrency: z.string().length(3).optional(),
  mealsPerDay: z.array(mealTypeEnum).min(1).default(["breakfast", "lunch", "dinner"]),
  preferences: z
    .object({
      maxCookTime: z.number().int().positive().optional(),
      cuisines: z.array(z.string()).optional(),
      excludeRecipeIds: z.array(z.string().uuid()).optional(),
    })
    .optional(),
});

const swapSchema = z.object({
  itemId: z.string().uuid(),
  reason: z.string().max(500).optional(),
});

const logMealSchema = z.object({
  itemId: z.string().uuid(),
});

// ── Routes ──────────────────────────────────────────────────────────────────

// POST /api/v1/meal-plans/generate
router.post(
  "/generate",
  rateLimitMiddleware,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const customerId = b2cId(req);
      const parsed = generateSchema.parse(req.body);
      const result = await generateMealPlan(customerId, parsed);
      res.status(201).json(result);
    } catch (err) {
      next(err);
    }
  }
);

// GET /api/v1/meal-plans
router.get(
  "/",
  rateLimitMiddleware,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const customerId = b2cId(req);
      const status = typeof req.query.status === "string" ? req.query.status : undefined;
      const limit = req.query.limit ? parseInt(req.query.limit as string, 10) : 20;
      const offset = req.query.offset ? parseInt(req.query.offset as string, 10) : 0;
      const result = await listPlans(customerId, status, limit, offset);
      res.json(result);
    } catch (err) {
      next(err);
    }
  }
);

// GET /api/v1/meal-plans/:id
router.get(
  "/:id",
  rateLimitMiddleware,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const result = await getPlanDetail(req.params.id);
      res.json(result);
    } catch (err) {
      next(err);
    }
  }
);

// PUT /api/v1/meal-plans/:id/activate
router.put(
  "/:id/activate",
  rateLimitMiddleware,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const customerId = b2cId(req);
      const plan = await activatePlan(req.params.id, customerId);
      res.json({ plan });
    } catch (err) {
      next(err);
    }
  }
);

// POST /api/v1/meal-plans/:id/swap-meal
router.post(
  "/:id/swap-meal",
  rateLimitMiddleware,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const customerId = b2cId(req);
      const parsed = swapSchema.parse(req.body);
      const result = await swapMeal(req.params.id, parsed.itemId, customerId, parsed.reason);
      res.json(result);
    } catch (err) {
      next(err);
    }
  }
);

// POST /api/v1/meal-plans/:id/regenerate
router.post(
  "/:id/regenerate",
  rateLimitMiddleware,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const customerId = b2cId(req);
      const result = await regeneratePlan(req.params.id, customerId);
      res.status(201).json(result);
    } catch (err) {
      next(err);
    }
  }
);

// DELETE /api/v1/meal-plans/:id
router.delete(
  "/:id",
  rateLimitMiddleware,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const result = await deletePlan(req.params.id);
      res.json(result);
    } catch (err) {
      next(err);
    }
  }
);

// POST /api/v1/meal-plans/:id/log-meal
router.post(
  "/:id/log-meal",
  rateLimitMiddleware,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const customerId = b2cId(req);
      const parsed = logMealSchema.parse(req.body);
      const result = await logMealFromPlan(req.params.id, parsed.itemId, customerId);
      res.status(201).json(result);
    } catch (err) {
      next(err);
    }
  }
);

export default router;
