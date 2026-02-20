import { Router } from "express";
import type { Request, Response, NextFunction } from "express";
import { z } from "zod";
import { authMiddleware } from "../middleware/auth.js";
import { rateLimitMiddleware } from "../middleware/rateLimit.js";
import { requireB2cCustomerIdFromReq } from "../services/b2cIdentity.js";
import { AppError } from "../middleware/errorHandler.js";
import {
  getDailyLog,
  addMealItem,
  updateMealItem,
  deleteMealItem,
  updateWaterIntake,
  copyDay,
  getHistory,
  getStreak,
  logFromCooking,
  getTemplates,
  createTemplate,
} from "../services/mealLog.js";

const router = Router();
router.use(authMiddleware);

function b2cId(req: Request): string {
  return requireB2cCustomerIdFromReq(req);
}

const mealTypeEnum = z.enum(["breakfast", "lunch", "dinner", "snack"]);
const dateRegex = /^\d{4}-\d{2}-\d{2}$/;

// ── Validation Schemas ──────────────────────────────────────────────────────

const addItemSchema = z.object({
  date: z.string().regex(dateRegex, "Date must be YYYY-MM-DD"),
  memberId: z.string().uuid().optional(),
  mealType: mealTypeEnum,
  recipeId: z.string().uuid().optional(),
  productId: z.string().uuid().optional(),
  customName: z.string().max(500).optional(),
  customBrand: z.string().max(255).optional(),
  servings: z.number().positive().default(1),
  servingSize: z.string().max(100).optional(),
  servingSizeG: z.number().positive().optional(),
  source: z.enum(["manual", "recipe", "scan", "quick_add", "copy", "cooking_mode"]).optional(),
  notes: z.string().optional(),
  imageUrl: z.string().url().max(1000).optional(),
  nutrition: z
    .object({
      calories: z.number().optional(),
      proteinG: z.number().optional(),
      carbsG: z.number().optional(),
      fatG: z.number().optional(),
      fiberG: z.number().optional(),
      sugarG: z.number().optional(),
      sodiumMg: z.number().optional(),
      saturatedFatG: z.number().optional(),
    })
    .optional(),
}).refine(
  (d) => d.recipeId || d.productId || d.customName,
  { message: "One of recipeId, productId, or customName is required" }
);

const updateItemSchema = z.object({
  servings: z.number().positive().optional(),
  mealType: mealTypeEnum.optional(),
  notes: z.string().optional(),
}).refine(
  (d) => d.servings != null || d.mealType != null || d.notes != null,
  { message: "At least one field is required" }
);

const waterSchema = z.object({
  date: z.string().regex(dateRegex),
  memberId: z.string().uuid().optional(),
  amount_ml: z.number().int().positive(),
});

const copyDaySchema = z.object({
  sourceDate: z.string().regex(dateRegex),
  targetDate: z.string().regex(dateRegex),
  memberId: z.string().uuid().optional(),
}).refine((d) => d.sourceDate !== d.targetDate, {
  message: "sourceDate and targetDate must be different",
});

const cookingLogSchema = z.object({
  recipeId: z.string().uuid(),
  memberId: z.string().uuid().optional(),
  servings: z.number().positive().default(1),
  mealType: mealTypeEnum.optional(),
  cookingStartedAt: z.string(),
  cookingFinishedAt: z.string(),
});

const templateSchema = z.object({
  name: z.string().min(1).max(255),
  memberId: z.string().uuid().optional(),
  mealType: mealTypeEnum.optional(),
  items: z.array(z.any()).min(1),
});

const memberQuerySchema = z.object({
  memberId: z.string().uuid().optional(),
});

// ── Routes ──────────────────────────────────────────────────────────────────

// GET /api/v1/meal-log?date=YYYY-MM-DD&memberId=xxx
router.get(
  "/",
  rateLimitMiddleware,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const customerId = b2cId(req);
      const date = typeof req.query.date === "string" ? req.query.date : new Date().toISOString().slice(0, 10);

      if (!dateRegex.test(date)) {
        throw new AppError(400, "Bad Request", "date must be YYYY-MM-DD");
      }

      const { memberId } = memberQuerySchema.parse(req.query ?? {});
      const result = await getDailyLog(customerId, date, memberId);
      res.json(result);
    } catch (err) {
      next(err);
    }
  }
);

// POST /api/v1/meal-log/items
router.post(
  "/items",
  rateLimitMiddleware,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const customerId = b2cId(req);
      const parsed = addItemSchema.parse(req.body);
      const result = await addMealItem(customerId, parsed);
      res.status(201).json(result);
    } catch (err) {
      next(err);
    }
  }
);

// PUT /api/v1/meal-log/items/:id
router.put(
  "/items/:id",
  rateLimitMiddleware,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const customerId = b2cId(req);
      const parsed = updateItemSchema.parse(req.body);
      const { memberId } = memberQuerySchema.parse(req.query ?? {});
      const result = await updateMealItem(req.params.id, customerId, parsed, memberId);
      res.json(result);
    } catch (err) {
      next(err);
    }
  }
);

// DELETE /api/v1/meal-log/items/:id
router.delete(
  "/items/:id",
  rateLimitMiddleware,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const customerId = b2cId(req);
      const { memberId } = memberQuerySchema.parse(req.query ?? {});
      const result = await deleteMealItem(req.params.id, customerId, memberId);
      res.json(result);
    } catch (err) {
      next(err);
    }
  }
);

// POST /api/v1/meal-log/water
router.post(
  "/water",
  rateLimitMiddleware,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const customerId = b2cId(req);
      const parsed = waterSchema.parse(req.body);
      const result = await updateWaterIntake(customerId, parsed.date, parsed.amount_ml, parsed.memberId);
      res.json(result);
    } catch (err) {
      next(err);
    }
  }
);

// POST /api/v1/meal-log/copy-day
router.post(
  "/copy-day",
  rateLimitMiddleware,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const customerId = b2cId(req);
      const parsed = copyDaySchema.parse(req.body);
      const result = await copyDay(customerId, parsed.sourceDate, parsed.targetDate, parsed.memberId);
      res.json(result);
    } catch (err) {
      next(err);
    }
  }
);

// GET /api/v1/meal-log/history?startDate=...&endDate=...&memberId=xxx
router.get(
  "/history",
  rateLimitMiddleware,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const customerId = b2cId(req);
      const startDate = typeof req.query.startDate === "string" ? req.query.startDate : "";
      const endDate = typeof req.query.endDate === "string" ? req.query.endDate : "";

      if (!dateRegex.test(startDate) || !dateRegex.test(endDate)) {
        throw new AppError(400, "Bad Request", "startDate and endDate must be YYYY-MM-DD");
      }

      const { memberId } = memberQuerySchema.parse(req.query ?? {});
      const result = await getHistory(customerId, startDate, endDate, memberId);
      res.json(result);
    } catch (err) {
      next(err);
    }
  }
);

// GET /api/v1/meal-log/streak?memberId=xxx
router.get(
  "/streak",
  rateLimitMiddleware,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const customerId = b2cId(req);
      const { memberId } = memberQuerySchema.parse(req.query ?? {});
      const streak = await getStreak(customerId, memberId);
      res.json(streak);
    } catch (err) {
      next(err);
    }
  }
);

// POST /api/v1/meal-log/from-cooking
router.post(
  "/from-cooking",
  rateLimitMiddleware,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const customerId = b2cId(req);
      const parsed = cookingLogSchema.parse(req.body);
      const result = await logFromCooking(customerId, parsed);
      res.status(201).json(result);
    } catch (err) {
      next(err);
    }
  }
);

// GET /api/v1/meal-log/templates?memberId=xxx
router.get(
  "/templates",
  rateLimitMiddleware,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const customerId = b2cId(req);
      const { memberId } = memberQuerySchema.parse(req.query ?? {});
      const templates = await getTemplates(customerId, memberId);
      res.json({ templates });
    } catch (err) {
      next(err);
    }
  }
);

// POST /api/v1/meal-log/templates
router.post(
  "/templates",
  rateLimitMiddleware,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const customerId = b2cId(req);
      const parsed = templateSchema.parse(req.body);
      const template = await createTemplate(customerId, parsed);
      res.status(201).json({ template });
    } catch (err) {
      next(err);
    }
  }
);

export default router;
