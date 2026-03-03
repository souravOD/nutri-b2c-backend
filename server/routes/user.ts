import { Router } from "express";
import type { Request } from "express";
import { z } from "zod";
import { authMiddleware } from "../middleware/auth.js";
import { rateLimitMiddleware } from "../middleware/rateLimit.js";
import { requireB2cCustomerIdFromReq } from "../services/b2cIdentity.js";
import {
  resolveDietIds,
  resolveAllergenIds,
  resolveConditionIds,
  resolveCuisineIds,
  replaceCustomerDiets,
  replaceCustomerAllergens,
  replaceCustomerConditions,
  replaceCustomerCuisines,
} from "../services/b2cTaxonomy.js";
import { db, executeRaw } from "../config/database.js";
import {
  b2cCustomers,
  b2cCustomerHealthProfiles,
  b2cCustomerDietaryPreferences,
  b2cCustomerAllergens,
  b2cCustomerHealthConditions,
  b2cCustomerSettings,
} from "../../shared/goldSchema.js";
import { eq } from "drizzle-orm";
import {
  getSavedRecipes,
  logRecipeHistory,
  getRecipeHistory,
  getRecentlyViewed,
  getMostCooked,
} from "../services/recipes.js";
import {
  createUserRecipe,
  updateUserRecipe,
  shareUserRecipe,
  unshareUserRecipe,
  submitForReview,
  getUserRecipes,
} from "../services/userContent.js";
import { deleteAppwriteDocuments, deleteAppwriteUser, updateAppwriteProfile, updateAppwriteHealth } from "../services/appwrite.js";
import { AppError } from "../middleware/errorHandler.js";

const router = Router();

function appwriteUserId(req: Request): string {
  const id = (req as any).user?.effectiveUserId ?? (req as any).user?.userId;
  if (!id) throw new AppError(401, "Unauthorized", "Missing authenticated user");
  return String(id);
}

function b2cCustomerId(req: Request): string {
  return requireB2cCustomerIdFromReq(req);
}

function toNullableNumericString(value: number | null | undefined): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  return String(value);
}

const profileSchema = z.object({
  fullName: z.string().min(1).optional().nullable(),
  email: z.string().email().optional().nullable(),
  phone: z.string().optional().nullable(),
  dateOfBirth: z.string().optional().nullable(),
  gender: z.string().optional().nullable(),
  diets: z.array(z.string()).optional(),
  allergens: z.array(z.string()).optional(),
});

const healthSchema = z.object({
  heightCm: z.number().optional().nullable(),
  weightKg: z.number().optional().nullable(),
  activityLevel: z.string().optional().nullable(),
  healthGoal: z.string().optional().nullable(),
  targetWeightKg: z.number().optional().nullable(),
  targetCalories: z.number().optional().nullable(),
  targetProteinG: z.number().optional().nullable(),
  targetCarbsG: z.number().optional().nullable(),
  targetFatG: z.number().optional().nullable(),
  targetFiberG: z.number().optional().nullable(),
  targetSodiumMg: z.number().optional().nullable(),
  targetSugarG: z.number().optional().nullable(),
  intolerances: z.array(z.string()).optional(),
  dislikedIngredients: z.array(z.string()).optional(),
  onboardingComplete: z.boolean().optional(),
  conditions: z.array(z.string()).optional(),
  allergens: z.array(z.string()).optional(),
  diets: z.array(z.string()).optional(),
  dateOfBirth: z.string().optional().nullable(),
  gender: z.string().optional().nullable(),
});

router.get("/profile", authMiddleware, rateLimitMiddleware, async (req, res, next) => {
  try {
    const id = b2cCustomerId(req);
    const rows = await executeRaw(
      `
      select
        c.*,
        array_remove(array_agg(distinct dp.code), null) as diets,
        array_remove(array_agg(distinct a.code), null) as allergens
      from gold.b2c_customers c
      left join gold.b2c_customer_dietary_preferences cdp
        on c.id = cdp.b2c_customer_id and cdp.is_active = true
      left join gold.dietary_preferences dp on dp.id = cdp.diet_id
      left join gold.b2c_customer_allergens ca
        on c.id = ca.b2c_customer_id and ca.is_active = true
      left join gold.allergens a on a.id = ca.allergen_id
      where c.id = $1
      group by c.id
      `,
      [id]
    );

    if (!rows.length) return res.json({});
    const row = rows[0] as any;

    res.json({
      id: row.id,
      fullName: row.full_name,
      email: row.email,
      phone: row.phone,
      dateOfBirth: row.date_of_birth,
      gender: row.gender,
      householdId: row.household_id,
      householdRole: row.household_role,
      isProfileOwner: row.is_profile_owner,
      accountStatus: row.account_status,
      diets: row.diets ?? [],
      allergens: row.allergens ?? [],
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    });
  } catch (err) {
    next(err);
  }
});

router.patch("/profile", authMiddleware, rateLimitMiddleware, async (req, res, next) => {
  try {
    const id = b2cCustomerId(req);
    const body = profileSchema.parse(req.body ?? {});

    const update: Record<string, any> = {
      updatedAt: new Date(),
    };
    if (body.fullName !== undefined) update.fullName = body.fullName;
    if (body.email !== undefined) update.email = body.email;
    if (body.phone !== undefined) update.phone = body.phone;
    if (body.dateOfBirth !== undefined) update.dateOfBirth = body.dateOfBirth;
    if (body.gender !== undefined) update.gender = body.gender;

    await db.update(b2cCustomers).set(update).where(eq(b2cCustomers.id, id));

    if (body.diets) {
      const dietIds = await resolveDietIds(body.diets);
      await replaceCustomerDiets(id, dietIds);
    }
    if (body.allergens) {
      const allergenIds = await resolveAllergenIds(body.allergens);
      await replaceCustomerAllergens(id, allergenIds);
    }

    // Write-back to Appwrite to keep both stores in sync
    void updateAppwriteProfile(appwriteUserId(req), {
      displayName: body.fullName,
      email: body.email,
    });

    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

router.delete("/profile", authMiddleware, rateLimitMiddleware, async (req, res, next) => {
  try {
    const id = b2cCustomerId(req);
    await db.delete(b2cCustomerHealthProfiles).where(eq(b2cCustomerHealthProfiles.b2cCustomerId, id));
    await db.delete(b2cCustomerDietaryPreferences).where(eq(b2cCustomerDietaryPreferences.b2cCustomerId, id));
    await db.delete(b2cCustomerAllergens).where(eq(b2cCustomerAllergens.b2cCustomerId, id));
    await db.delete(b2cCustomerHealthConditions).where(eq(b2cCustomerHealthConditions.b2cCustomerId, id));
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

router.get("/health", authMiddleware, rateLimitMiddleware, async (req, res, next) => {
  try {
    const id = b2cCustomerId(req);
    const rows = await executeRaw(
      `
      select
        hp.*,
        array_remove(array_agg(distinct hc.code), null) as conditions,
        array_remove(array_agg(distinct a.code), null) as allergens,
        array_remove(array_agg(distinct dp.code), null) as diets
      from gold.b2c_customer_health_profiles hp
      left join gold.b2c_customer_health_conditions chc
        on hp.b2c_customer_id = chc.b2c_customer_id and chc.is_active = true
      left join gold.health_conditions hc on hc.id = chc.condition_id
      left join gold.b2c_customer_allergens ca
        on hp.b2c_customer_id = ca.b2c_customer_id and ca.is_active = true
      left join gold.allergens a on a.id = ca.allergen_id
      left join gold.b2c_customer_dietary_preferences cdp
        on hp.b2c_customer_id = cdp.b2c_customer_id and cdp.is_active = true
      left join gold.dietary_preferences dp on dp.id = cdp.diet_id
      where hp.b2c_customer_id = $1
      group by hp.id
      `,
      [id]
    );

    if (!rows.length) return res.json({});
    const row = rows[0] as any;
    res.json({
      id: row.id,
      b2cCustomerId: row.b2c_customer_id,
      heightCm: row.height_cm,
      weightKg: row.weight_kg,
      bmi: row.bmi,
      activityLevel: row.activity_level,
      healthGoal: row.health_goal,
      targetWeightKg: row.target_weight_kg,
      targetCalories: row.target_calories,
      targetProteinG: row.target_protein_g,
      targetCarbsG: row.target_carbs_g,
      targetFatG: row.target_fat_g,
      targetFiberG: row.target_fiber_g,
      targetSodiumMg: row.target_sodium_mg,
      targetSugarG: row.target_sugar_g,
      intolerances: row.intolerances ?? [],
      dislikedIngredients: row.disliked_ingredients ?? [],
      onboardingComplete: row.onboarding_complete ?? false,
      conditions: row.conditions ?? [],
      allergens: row.allergens ?? [],
      diets: row.diets ?? [],
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    });
  } catch (err) {
    next(err);
  }
});

router.patch("/health", authMiddleware, rateLimitMiddleware, async (req, res, next) => {
  try {
    const id = b2cCustomerId(req);
    const body = healthSchema.parse(req.body ?? {});

    if (body.dateOfBirth !== undefined || body.gender !== undefined) {
      await db
        .update(b2cCustomers)
        .set({
          dateOfBirth: body.dateOfBirth ?? undefined,
          gender: body.gender ?? undefined,
          updatedAt: new Date(),
        })
        .where(eq(b2cCustomers.id, id));
    }

    const existing = await db
      .select()
      .from(b2cCustomerHealthProfiles)
      .where(eq(b2cCustomerHealthProfiles.b2cCustomerId, id))
      .limit(1);

    const payload = {
      b2cCustomerId: id,
      heightCm: toNullableNumericString(body.heightCm),
      weightKg: toNullableNumericString(body.weightKg),
      activityLevel: body.activityLevel ?? undefined,
      healthGoal: body.healthGoal ?? undefined,
      targetWeightKg: toNullableNumericString(body.targetWeightKg),
      targetCalories: body.targetCalories ?? undefined,
      targetProteinG: toNullableNumericString(body.targetProteinG),
      targetCarbsG: toNullableNumericString(body.targetCarbsG),
      targetFatG: toNullableNumericString(body.targetFatG),
      targetFiberG: toNullableNumericString(body.targetFiberG),
      targetSodiumMg: body.targetSodiumMg ?? undefined,
      targetSugarG: toNullableNumericString(body.targetSugarG),
      intolerances: body.intolerances ?? undefined,
      dislikedIngredients: body.dislikedIngredients ?? undefined,
      onboardingComplete: body.onboardingComplete ?? undefined,
      updatedAt: new Date(),
    };

    if (existing.length) {
      await db
        .update(b2cCustomerHealthProfiles)
        .set(payload)
        .where(eq(b2cCustomerHealthProfiles.b2cCustomerId, id));
    } else {
      await db.insert(b2cCustomerHealthProfiles).values({
        ...payload,
        createdAt: new Date(),
      });
    }

    if (body.conditions) {
      const conditionIds = await resolveConditionIds(body.conditions);
      await replaceCustomerConditions(id, conditionIds);
    }
    if (body.allergens) {
      const allergenIds = await resolveAllergenIds(body.allergens);
      await replaceCustomerAllergens(id, allergenIds);
    }
    if (body.diets) {
      const dietIds = await resolveDietIds(body.diets);
      await replaceCustomerDiets(id, dietIds);
    }

    // Write-back to Appwrite to keep both stores in sync
    void updateAppwriteHealth(appwriteUserId(req), {
      dateOfBirth: body.dateOfBirth,
      activityLevel: body.activityLevel,
      onboardingComplete: body.onboardingComplete,
    });

    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

router.get("/saved", authMiddleware, rateLimitMiddleware, async (req, res, next) => {
  try {
    const id = b2cCustomerId(req);
    const limit = req.query.limit ? parseInt(req.query.limit as string, 10) : 50;
    const offset = req.query.offset ? parseInt(req.query.offset as string, 10) : 0;
    const saved = await getSavedRecipes(id, limit, offset);
    res.json(saved);
  } catch (err) {
    next(err);
  }
});

router.post("/history", authMiddleware, rateLimitMiddleware, async (req, res, next) => {
  try {
    const id = b2cCustomerId(req);
    const body = req.body ?? {};
    if (!body.recipeId || !body.event) {
      return res.status(400).json({ error: "recipeId and event required" });
    }
    await logRecipeHistory({ b2cCustomerId: id, recipeId: body.recipeId, event: body.event });
    res.status(201).json({ success: true });
  } catch (err) {
    next(err);
  }
});

router.get("/history", authMiddleware, rateLimitMiddleware, async (req, res, next) => {
  try {
    const id = b2cCustomerId(req);
    const event = req.query.event as string | undefined;
    const limit = req.query.limit ? parseInt(req.query.limit as string, 10) : 50;
    const offset = req.query.offset ? parseInt(req.query.offset as string, 10) : 0;
    const history = await getRecipeHistory(id, event, limit, offset);
    res.json(history);
  } catch (err) {
    next(err);
  }
});

router.get("/recently-viewed", authMiddleware, rateLimitMiddleware, async (req, res, next) => {
  try {
    const id = b2cCustomerId(req);
    const limit = req.query.limit ? parseInt(req.query.limit as string, 10) : 20;
    const recent = await getRecentlyViewed(id, limit);
    res.json(recent);
  } catch (err) {
    next(err);
  }
});

router.get("/most-cooked", authMiddleware, rateLimitMiddleware, async (req, res, next) => {
  try {
    const id = b2cCustomerId(req);
    const limit = req.query.limit ? parseInt(req.query.limit as string, 10) : 20;
    const cooked = await getMostCooked(id, limit);
    res.json(cooked);
  } catch (err) {
    next(err);
  }
});

// User-generated recipes
router.post("/my-recipes", authMiddleware, rateLimitMiddleware, async (req, res, next) => {
  try {
    const id = b2cCustomerId(req);
    const recipe = await createUserRecipe(id, req.body ?? {});
    res.status(201).json(recipe);
  } catch (err) {
    next(err);
  }
});

router.get("/my-recipes", authMiddleware, rateLimitMiddleware, async (req, res, next) => {
  try {
    const id = b2cCustomerId(req);
    const limit = req.query.limit ? parseInt(req.query.limit as string, 10) : 50;
    const offset = req.query.offset ? parseInt(req.query.offset as string, 10) : 0;
    const recipes = await getUserRecipes(id, limit, offset);
    res.json(recipes);
  } catch (err) {
    next(err);
  }
});

router.patch("/my-recipes/:id", authMiddleware, rateLimitMiddleware, async (req, res, next) => {
  try {
    const id = b2cCustomerId(req);
    const recipe = await updateUserRecipe(id, req.params.id, req.body ?? {});
    res.json(recipe);
  } catch (err) {
    next(err);
  }
});

router.post("/my-recipes/:id/share", authMiddleware, rateLimitMiddleware, async (req, res, next) => {
  try {
    const id = b2cCustomerId(req);
    const result = await shareUserRecipe(id, req.params.id);
    res.json(result);
  } catch (err) {
    next(err);
  }
});

router.post("/my-recipes/:id/unshare", authMiddleware, rateLimitMiddleware, async (req, res, next) => {
  try {
    const id = b2cCustomerId(req);
    const recipe = await unshareUserRecipe(id, req.params.id);
    res.json(recipe);
  } catch (err) {
    next(err);
  }
});

router.post("/my-recipes/:id/submit", authMiddleware, rateLimitMiddleware, async (req, res, next) => {
  try {
    const id = b2cCustomerId(req);
    const recipe = await submitForReview(id, req.params.id);
    res.json(recipe);
  } catch (err) {
    next(err);
  }
});

router.delete("/account", authMiddleware, rateLimitMiddleware, async (req, res, next) => {
  try {
    const id = b2cCustomerId(req);
    const awUserId = appwriteUserId(req);

    await executeRaw("BEGIN");

    // ── Recipe-related (children first) ──
    await executeRaw(
      "DELETE FROM gold.recipe_nutrition_profiles WHERE recipe_id IN (SELECT id FROM gold.recipes WHERE created_by_user_id = $1)",
      [id]
    );
    await executeRaw(
      "DELETE FROM gold.recipe_ingredients WHERE recipe_id IN (SELECT id FROM gold.recipes WHERE created_by_user_id = $1)",
      [id]
    );
    await executeRaw(
      "DELETE FROM gold.nutrition_facts WHERE entity_type = 'recipe' AND entity_id IN (SELECT id FROM gold.recipes WHERE created_by_user_id = $1)",
      [id]
    );
    await executeRaw("DELETE FROM gold.recipes WHERE created_by_user_id = $1", [id]);

    // ── Meal logs (children → parent) ──
    await executeRaw(
      "DELETE FROM gold.meal_log_item_nutrients WHERE meal_log_item_id IN (SELECT id FROM gold.meal_log_items WHERE meal_log_id IN (SELECT id FROM gold.meal_logs WHERE b2c_customer_id = $1))",
      [id]
    );
    await executeRaw(
      "DELETE FROM gold.meal_log_items WHERE meal_log_id IN (SELECT id FROM gold.meal_logs WHERE b2c_customer_id = $1)",
      [id]
    );
    await executeRaw("DELETE FROM gold.meal_logs WHERE b2c_customer_id = $1", [id]);

    // ── Meal plans (children → parent) ──
    await executeRaw(
      "DELETE FROM gold.meal_plan_items WHERE meal_plan_id IN (SELECT id FROM gold.meal_plans WHERE b2c_customer_id = $1)",
      [id]
    );
    await executeRaw("DELETE FROM gold.meal_plans WHERE b2c_customer_id = $1", [id]);

    // ── Shopping lists ──
    await executeRaw(
      "DELETE FROM gold.shopping_list_items WHERE shopping_list_id IN (SELECT id FROM gold.shopping_lists WHERE b2c_customer_id = $1)",
      [id]
    );
    await executeRaw("DELETE FROM gold.shopping_lists WHERE b2c_customer_id = $1", [id]);

    // ── Interactions & ratings ──
    await executeRaw("DELETE FROM gold.customer_product_interactions WHERE b2c_customer_id = $1", [id]);
    await executeRaw("DELETE FROM gold.recipe_ratings WHERE b2c_customer_id = $1", [id]);

    // ── Health & preferences ──
    await executeRaw("DELETE FROM gold.b2c_customer_weight_history WHERE b2c_customer_id = $1", [id]);
    await executeRaw("DELETE FROM gold.b2c_customer_health_profiles WHERE b2c_customer_id = $1", [id]);
    await executeRaw("DELETE FROM gold.b2c_customer_allergens WHERE b2c_customer_id = $1", [id]);
    await executeRaw("DELETE FROM gold.b2c_customer_dietary_preferences WHERE b2c_customer_id = $1", [id]);
    await executeRaw("DELETE FROM gold.b2c_customer_health_conditions WHERE b2c_customer_id = $1", [id]);
    await executeRaw("DELETE FROM gold.b2c_customer_cuisine_preferences WHERE b2c_customer_id = $1", [id]);

    // ── Settings ──
    await executeRaw("DELETE FROM gold.b2c_customer_settings WHERE b2c_customer_id = $1", [id]);

    // ── Customer record itself (last) ──
    await executeRaw("DELETE FROM gold.b2c_customers WHERE id = $1", [id]);

    await executeRaw("COMMIT");

    // ── Appwrite cleanup (after Supabase commit succeeds) ──
    await deleteAppwriteDocuments(awUserId);
    await deleteAppwriteUser(awUserId);

    res.status(204).end();
  } catch (err) {
    try { await executeRaw("ROLLBACK"); } catch { }
    next(err);
  }
});

// ── Settings (unified GET/PATCH for all settings tabs) ─────────────────────

const settingsSchema = z.object({
  // General
  units: z.string().optional(),
  preferredCuisines: z.array(z.string()).optional(),
  dislikedIngredients: z.array(z.string()).optional(),
  timeRangeMin: z.number().optional(),
  timeRangeMax: z.number().optional(),
  // Goals
  healthGoal: z.string().optional().nullable(),
  targetWeightKg: z.number().optional().nullable(),
  targetCalories: z.number().optional().nullable(),
  targetProteinG: z.number().optional().nullable(),
  targetCarbsG: z.number().optional().nullable(),
  targetFatG: z.number().optional().nullable(),
  targetFiberG: z.number().optional().nullable(),
  targetSodiumMg: z.number().optional().nullable(),
  targetSugarG: z.number().optional().nullable(),
  // Recommend
  exploration: z.number().optional(),
  diversityWeight: z.number().optional(),
  healthWeight: z.number().optional(),
  timeWeight: z.number().optional(),
  popularityWeight: z.number().optional(),
  personalWeight: z.number().optional(),
  defaultSort: z.string().optional(),
  showScoreBadge: z.boolean().optional(),
  // Alerts
  enableReminders: z.boolean().optional(),
  // Advanced filters
  filterCaloriesMin: z.number().optional(),
  filterCaloriesMax: z.number().optional(),
  filterProteinMin: z.number().optional(),
  filterCarbsMin: z.number().optional(),
  filterFatMin: z.number().optional(),
  filterFiberMin: z.number().optional(),
  filterSugarMax: z.number().optional(),
  filterSodiumMax: z.number().optional(),
  filterMaxTime: z.number().optional(),
});

router.get("/settings", authMiddleware, rateLimitMiddleware, async (req, res, next) => {
  try {
    const id = b2cCustomerId(req);

    // Fetch app settings
    const settingsRows = await db
      .select()
      .from(b2cCustomerSettings)
      .where(eq(b2cCustomerSettings.b2cCustomerId, id))
      .limit(1);

    // Fetch health profile for goals tab fields
    const healthRows = await db
      .select()
      .from(b2cCustomerHealthProfiles)
      .where(eq(b2cCustomerHealthProfiles.b2cCustomerId, id))
      .limit(1);

    // Fetch preferred cuisines from junction table
    const cuisineRows = await executeRaw(
      `SELECT c.name FROM gold.b2c_customer_cuisine_preferences cp
       JOIN gold.cuisines c ON c.id = cp.cuisine_id
       WHERE cp.b2c_customer_id = $1`,
      [id]
    );
    const preferredCuisines = cuisineRows.map((r: any) => r.name);

    const s = settingsRows[0] as any;
    const h = healthRows[0] as any;

    res.json({
      // General
      units: s?.units ?? "US",
      preferredCuisines,
      dislikedIngredients: h?.disliked_ingredients ?? h?.dislikedIngredients ?? [],
      timeRangeMin: s?.time_range_min ?? s?.timeRangeMin ?? 0,
      timeRangeMax: s?.time_range_max ?? s?.timeRangeMax ?? 120,
      // Goals (from health profile)
      healthGoal: h?.health_goal ?? h?.healthGoal ?? null,
      targetWeightKg: h?.target_weight_kg ?? h?.targetWeightKg ?? null,
      targetCalories: h?.target_calories ?? h?.targetCalories ?? null,
      targetProteinG: h?.target_protein_g ?? h?.targetProteinG ?? null,
      targetCarbsG: h?.target_carbs_g ?? h?.targetCarbsG ?? null,
      targetFatG: h?.target_fat_g ?? h?.targetFatG ?? null,
      targetFiberG: h?.target_fiber_g ?? h?.targetFiberG ?? null,
      targetSodiumMg: h?.target_sodium_mg ?? h?.targetSodiumMg ?? null,
      targetSugarG: h?.target_sugar_g ?? h?.targetSugarG ?? null,
      // Recommend
      exploration: parseFloat(s?.exploration) || 0.15,
      diversityWeight: parseFloat(s?.diversity_weight ?? s?.diversityWeight) || 0.1,
      healthWeight: parseFloat(s?.health_weight ?? s?.healthWeight) || 0.35,
      timeWeight: parseFloat(s?.time_weight ?? s?.timeWeight) || 0.15,
      popularityWeight: parseFloat(s?.popularity_weight ?? s?.popularityWeight) || 0.15,
      personalWeight: parseFloat(s?.personal_weight ?? s?.personalWeight) || 0.25,
      defaultSort: s?.default_sort ?? s?.defaultSort ?? "time",
      showScoreBadge: s?.show_score_badge ?? s?.showScoreBadge ?? true,
      // Alerts
      enableReminders: s?.enable_reminders ?? s?.enableReminders ?? false,
      // Advanced filters
      filterCaloriesMin: s?.filter_calories_min ?? s?.filterCaloriesMin ?? 0,
      filterCaloriesMax: s?.filter_calories_max ?? s?.filterCaloriesMax ?? 1000,
      filterProteinMin: parseFloat(s?.filter_protein_min ?? s?.filterProteinMin) || 0,
      filterCarbsMin: parseFloat(s?.filter_carbs_min ?? s?.filterCarbsMin) || 0,
      filterFatMin: parseFloat(s?.filter_fat_min ?? s?.filterFatMin) || 0,
      filterFiberMin: parseFloat(s?.filter_fiber_min ?? s?.filterFiberMin) || 0,
      filterSugarMax: parseFloat(s?.filter_sugar_max ?? s?.filterSugarMax) || 60,
      filterSodiumMax: s?.filter_sodium_max ?? s?.filterSodiumMax ?? 2300,
      filterMaxTime: s?.filter_max_time ?? s?.filterMaxTime ?? 120,
    });
  } catch (err) {
    next(err);
  }
});

router.patch("/settings", authMiddleware, rateLimitMiddleware, async (req, res, next) => {
  try {
    const id = b2cCustomerId(req);
    const body = settingsSchema.parse(req.body ?? {});

    // ── App preferences → b2c_customer_settings (upsert) ──
    const appPayload: Record<string, any> = {
      b2cCustomerId: id,
      updatedAt: new Date(),
    };
    if (body.units !== undefined) appPayload.units = body.units;
    // Cuisines handled via junction table below
    if (body.timeRangeMin !== undefined) appPayload.timeRangeMin = body.timeRangeMin;
    if (body.timeRangeMax !== undefined) appPayload.timeRangeMax = body.timeRangeMax;
    if (body.exploration !== undefined) appPayload.exploration = String(body.exploration);
    if (body.diversityWeight !== undefined) appPayload.diversityWeight = String(body.diversityWeight);
    if (body.healthWeight !== undefined) appPayload.healthWeight = String(body.healthWeight);
    if (body.timeWeight !== undefined) appPayload.timeWeight = String(body.timeWeight);
    if (body.popularityWeight !== undefined) appPayload.popularityWeight = String(body.popularityWeight);
    if (body.personalWeight !== undefined) appPayload.personalWeight = String(body.personalWeight);
    if (body.defaultSort !== undefined) appPayload.defaultSort = body.defaultSort;
    if (body.showScoreBadge !== undefined) appPayload.showScoreBadge = body.showScoreBadge;
    if (body.enableReminders !== undefined) appPayload.enableReminders = body.enableReminders;
    if (body.filterCaloriesMin !== undefined) appPayload.filterCaloriesMin = body.filterCaloriesMin;
    if (body.filterCaloriesMax !== undefined) appPayload.filterCaloriesMax = body.filterCaloriesMax;
    if (body.filterProteinMin !== undefined) appPayload.filterProteinMin = String(body.filterProteinMin);
    if (body.filterCarbsMin !== undefined) appPayload.filterCarbsMin = String(body.filterCarbsMin);
    if (body.filterFatMin !== undefined) appPayload.filterFatMin = String(body.filterFatMin);
    if (body.filterFiberMin !== undefined) appPayload.filterFiberMin = String(body.filterFiberMin);
    if (body.filterSugarMax !== undefined) appPayload.filterSugarMax = String(body.filterSugarMax);
    if (body.filterSodiumMax !== undefined) appPayload.filterSodiumMax = body.filterSodiumMax;
    if (body.filterMaxTime !== undefined) appPayload.filterMaxTime = body.filterMaxTime;

    const existingSettings = await db
      .select()
      .from(b2cCustomerSettings)
      .where(eq(b2cCustomerSettings.b2cCustomerId, id))
      .limit(1);

    if (existingSettings.length) {
      await db
        .update(b2cCustomerSettings)
        .set(appPayload)
        .where(eq(b2cCustomerSettings.b2cCustomerId, id));
    } else {
      await db.insert(b2cCustomerSettings).values(appPayload as any);
    }

    // ── Cuisines → junction table ──
    if (body.preferredCuisines !== undefined) {
      const cuisineIds = await resolveCuisineIds(body.preferredCuisines);
      await replaceCustomerCuisines(id, cuisineIds);
    }

    // ── Health targets → b2c_customer_health_profiles ──
    const healthFields = [
      "healthGoal", "targetWeightKg", "targetCalories",
      "targetProteinG", "targetCarbsG", "targetFatG",
      "targetFiberG", "targetSodiumMg", "targetSugarG",
      "dislikedIngredients",
    ] as const;
    const hasHealthUpdate = healthFields.some(f => (body as any)[f] !== undefined);

    if (hasHealthUpdate) {
      const healthPayload: Record<string, any> = {
        b2cCustomerId: id,
        updatedAt: new Date(),
      };
      if (body.healthGoal !== undefined) healthPayload.healthGoal = body.healthGoal;
      if (body.targetWeightKg !== undefined) healthPayload.targetWeightKg = toNullableNumericString(body.targetWeightKg);
      if (body.targetCalories !== undefined) healthPayload.targetCalories = body.targetCalories;
      if (body.targetProteinG !== undefined) healthPayload.targetProteinG = toNullableNumericString(body.targetProteinG);
      if (body.targetCarbsG !== undefined) healthPayload.targetCarbsG = toNullableNumericString(body.targetCarbsG);
      if (body.targetFatG !== undefined) healthPayload.targetFatG = toNullableNumericString(body.targetFatG);
      if (body.targetFiberG !== undefined) healthPayload.targetFiberG = toNullableNumericString(body.targetFiberG);
      if (body.targetSodiumMg !== undefined) healthPayload.targetSodiumMg = body.targetSodiumMg;
      if (body.targetSugarG !== undefined) healthPayload.targetSugarG = toNullableNumericString(body.targetSugarG);
      if (body.dislikedIngredients !== undefined) healthPayload.dislikedIngredients = body.dislikedIngredients;

      const existingHealth = await db
        .select()
        .from(b2cCustomerHealthProfiles)
        .where(eq(b2cCustomerHealthProfiles.b2cCustomerId, id))
        .limit(1);

      if (existingHealth.length) {
        await db
          .update(b2cCustomerHealthProfiles)
          .set(healthPayload)
          .where(eq(b2cCustomerHealthProfiles.b2cCustomerId, id));
      } else {
        await db.insert(b2cCustomerHealthProfiles).values(healthPayload as any);
      }
    }

    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

export default router;
