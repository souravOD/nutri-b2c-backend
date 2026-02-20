import { Router } from "express";
import type { Request, Response, NextFunction } from "express";
import { z } from "zod";
import { authMiddleware } from "../middleware/auth.js";
import { rateLimitMiddleware } from "../middleware/rateLimit.js";
import { searchRecipes, getRecipeDetail, getPopularRecipes } from "../services/search.js";
import { toggleSaveRecipe } from "../services/recipes.js";
import { requireB2cCustomerIdFromReq } from "../services/b2cIdentity.js";
import {
  rateRecipe,
  getUserRating,
  getRecipeAverageRating,
} from "../services/recipeRating.js";

const num = (v: any) =>
  v === undefined || v === null || v === "" || v === "undefined" || v === "null"
    ? undefined
    : Number(v);

const csv = (v?: any) =>
  typeof v === "string" && v.trim() ? v.split(",").map(s => s.trim()).filter(Boolean) : undefined;

const router = Router();

// Search and browsing
router.get("/", rateLimitMiddleware, async (req, res, next) => {
  try {
    const searchParams = {
      q: req.query.q as string,
      diets: req.query.diets ? (req.query.diets as string).split(',') : [],
      cuisines: req.query.cuisines ? (req.query.cuisines as string).split(',') : [],
      allergensExclude: req.query.allergens_exclude ? (req.query.allergens_exclude as string).split(',') : [],
      majorConditions: csv(req.query.major_conditions),
      calMin: req.query.cal_min ? parseInt(req.query.cal_min as string) : undefined,
      calMax: req.query.cal_max ? parseInt(req.query.cal_max as string) : undefined,
      proteinMin: req.query.protein_min ? parseFloat(req.query.protein_min as string) : undefined,
      sugarMax: num(req.query.sugar_max) ? parseFloat(req.query.sugar_max as string) : undefined,
      sodiumMax: num(req.query.sodium_max) ? parseInt(req.query.sodium_max as string) : undefined,
      fiberMin: req.query.fiber_min ? parseFloat(req.query.fiber_min as string) : undefined,
      satfatMax: req.query.satfat_max ? parseFloat(req.query.satfat_max as string) : undefined,
      timeMax: num(req.query.time_max) ? parseInt(req.query.time_max as string) : undefined,
      difficulty: req.query.difficulty as string,
      mealType: req.query.meal_type as string,
      limit: req.query.limit ? parseInt(req.query.limit as string) : 50,
      offset: req.query.offset ? parseInt(req.query.offset as string) : 0,
    };
    
    const results = await searchRecipes(searchParams);
    res.json(results);
  } catch (error) {
    next(error);
  }
});

router.get("/popular", rateLimitMiddleware, async (req, res, next) => {
  try {
    const limit = req.query.limit ? parseInt(req.query.limit as string) : 20;
    const results = await getPopularRecipes(limit);
    res.json(results);
  } catch (error) {
    next(error);
  }
});

router.get("/:id", rateLimitMiddleware, async (req, res, next) => {
  try {
    const recipe = await getRecipeDetail(req.params.id);
    res.json(recipe);
  } catch (error) {
    next(error);
  }
});

// User interactions (require auth)
router.post("/:id/save", authMiddleware, rateLimitMiddleware, async (req, res, next) => {
  try {
    const b2cCustomerId = requireB2cCustomerIdFromReq(req);
    const result = await toggleSaveRecipe(b2cCustomerId, req.params.id);
    res.json(result);
  } catch (error) {
    next(error);
  }
});

router.post("/:id/report", authMiddleware, rateLimitMiddleware, async (req, res, next) => {
  try {
    res.status(501).json({ error: "Recipe reporting is not supported in the gold schema." });
  } catch (error) {
    next(error);
  }
});

// ── Recipe Ratings ──────────────────────────────────────────────────────────

const rateSchema = z.object({
  rating: z.number().int().min(1).max(5),
  feedbackText: z.string().max(2000).optional(),
  likedAspects: z.array(z.string()).optional(),
  dislikedAspects: z.array(z.string()).optional(),
  wouldMakeAgain: z.boolean().optional(),
  mealPlanItemId: z.string().uuid().optional(),
});

// POST /api/v1/recipes/:id/rate
router.post("/:id/rate", authMiddleware, rateLimitMiddleware, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const b2cCustomerId = requireB2cCustomerIdFromReq(req);
    const parsed = rateSchema.parse(req.body);
    const result = await rateRecipe(b2cCustomerId, req.params.id, parsed);
    res.json(result);
  } catch (error) {
    next(error);
  }
});

// GET /api/v1/recipes/:id/rating
router.get("/:id/rating", authMiddleware, rateLimitMiddleware, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const b2cCustomerId = requireB2cCustomerIdFromReq(req);
    const [myRating, average] = await Promise.all([
      getUserRating(b2cCustomerId, req.params.id),
      getRecipeAverageRating(req.params.id),
    ]);
    res.json({ myRating, ...average });
  } catch (error) {
    next(error);
  }
});

// Shared recipe access (no auth required)
router.get("/r/:shareSlug", rateLimitMiddleware, async (req, res, next) => {
  try {
    res.status(501).json({ error: "Shared recipes are not supported in the gold schema." });
  } catch (error) {
    next(error);
  }
});

export default router;
