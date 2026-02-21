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
  replaceCustomerDiets,
  replaceCustomerAllergens,
  replaceCustomerConditions,
} from "../services/b2cTaxonomy.js";
import { db, executeRaw } from "../config/database.js";
import {
  b2cCustomers,
  b2cCustomerHealthProfiles,
  b2cCustomerDietaryPreferences,
  b2cCustomerAllergens,
  b2cCustomerHealthConditions,
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
        array_remove(array_agg(distinct hc.code), null) as conditions
      from gold.b2c_customer_health_profiles hp
      left join gold.b2c_customer_health_conditions chc
        on hp.b2c_customer_id = chc.b2c_customer_id and chc.is_active = true
      left join gold.health_conditions hc on hc.id = chc.condition_id
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

    await executeRaw("BEGIN");
    await executeRaw("DELETE FROM gold.customer_product_interactions WHERE b2c_customer_id = $1", [id]);
    await executeRaw(
      "DELETE FROM gold.recipe_ingredients WHERE recipe_id IN (SELECT id FROM gold.recipes WHERE created_by_user_id = $1)",
      [id]
    );
    await executeRaw(
      "DELETE FROM gold.nutrition_facts WHERE entity_type = 'recipe' AND entity_id IN (SELECT id FROM gold.recipes WHERE created_by_user_id = $1)",
      [id]
    );
    await executeRaw("DELETE FROM gold.recipes WHERE created_by_user_id = $1", [id]);
    await executeRaw("DELETE FROM gold.b2c_customer_health_profiles WHERE b2c_customer_id = $1", [id]);
    await executeRaw("DELETE FROM gold.b2c_customer_allergens WHERE b2c_customer_id = $1", [id]);
    await executeRaw("DELETE FROM gold.b2c_customer_dietary_preferences WHERE b2c_customer_id = $1", [id]);
    await executeRaw("DELETE FROM gold.b2c_customer_health_conditions WHERE b2c_customer_id = $1", [id]);
    await executeRaw("DELETE FROM gold.b2c_customers WHERE id = $1", [id]);
    await executeRaw("COMMIT");

    await deleteAppwriteDocuments(appwriteUserId(req));
    await deleteAppwriteUser(appwriteUserId(req));

    res.status(204).end();
  } catch (err) {
    try { await executeRaw("ROLLBACK"); } catch {}
    next(err);
  }
});

export default router;
