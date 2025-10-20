import { Router } from "express";
import type { Request } from "express";
import { z } from "zod";
import { authMiddleware } from "../middleware/auth.js";
import { rateLimitMiddleware } from "../middleware/rateLimit.js";
import { getSavedRecipes, logRecipeHistory, getRecipeHistory, getRecentlyViewed, getMostCooked } from "../services/recipes.js";
import { createUserRecipe, updateUserRecipe, shareUserRecipe, unshareUserRecipe, submitForReview, getUserRecipes } from "../services/userContent.js";
import { getUserProfile, createOrUpdateUserProfile } from "../services/feed.js";
import { insertRecipeHistorySchema, insertUserRecipeSchema, insertUserProfileSchema } from "../../shared/schema.js";
import { AppError } from "../middleware/errorHandler.js";
import { supabase } from "../config/supabase.js";
import { executeRaw } from "../config/database.js";
import { deleteAppwriteDocuments, deleteAppwriteUser } from "../services/appwrite.js";

const router = Router();

const insertHealthProfileSchema = z.object({
  date_of_birth: z.string().optional().nullable(),               // ISO date
  sex: z.enum(["male","female","other"]).optional().nullable(),
  activity_level: z.string().optional().nullable(),
  goal: z.string().optional().nullable(),
  diets: z.array(z.string()).optional(),
  allergens: z.array(z.string()).optional(),
  intolerances: z.array(z.string()).optional(),
  disliked_ingredients: z.array(z.string()).optional(),
  onboarding_complete: z.boolean().optional(),
  height_display: z.string().optional().nullable(),
  weight_display: z.string().optional().nullable(),
  height_cm: z.number().optional().nullable(),
  weight_kg: z.number().optional().nullable(),
});

// Narrowing helper so TS knows we have a user and a string id
function getUserId(req: Request): string {
  // We only use a narrow cast here; runtime guard guarantees safety
  const id = (req as any).user?.effectiveUserId as string | undefined;
  if (!id) {
    throw new AppError(401, "Unauthorized", "Missing authenticated user");
  }
  return id;
}

function userId(req: any): string {
  return req.user?.effectiveUserId ?? req.user?.userId;
}

// User profile
router.get("/profile", authMiddleware, rateLimitMiddleware, async (req, res, next) => {
  try {
    const uid = req.user?.effectiveUserId ?? req.user?.userId;

    // Select all needed columns explicitly (safe across refactors)
    const { data, error } = await supabase
      .from("user_profiles")
      .select(`
        user_id,
        display_name,
        image_url,
        email,
        phone,
        country,
        profile_diets,
        profile_allergens,
        preferred_cuisines,
        target_calories,
        target_protein_g,
        target_carbs_g,
        target_fat_g,
        created_at,
        updated_at
      `)
      .eq("user_id", uid)
      .maybeSingle();

    if (error) throw error;

    if (!data) return res.json({});

    // Map DB → API (camelCase), plus keep a snake_case alias for display_name
    const dto = {
      userId: data.user_id,
      displayName: data.display_name ?? null,
      display_name: data.display_name ?? null,   // <- optional alias to satisfy consumers expecting snake_case
      imageUrl: data.image_url ?? null,
      email: data.email ?? null,
      phone: data.phone ?? null,
      country: data.country ?? null,
      profileDiets: data.profile_diets ?? [],
      profileAllergens: data.profile_allergens ?? [],
      preferredCuisines: data.preferred_cuisines ?? [],
      targetCalories: data.target_calories,
      targetProteinG: data.target_protein_g,
      targetCarbsG: data.target_carbs_g,
      targetFatG: data.target_fat_g,
      createdAt: data.created_at,
      updatedAt: data.updated_at,
    };

    res.json(dto);
  } catch (err) {
    next(err);
  }
});

router.put("/profile", authMiddleware, rateLimitMiddleware, async (req, res, next) => {
  try {
    const profileData = insertUserProfileSchema.parse(req.body);
    const profile = await createOrUpdateUserProfile(getUserId(req), profileData);
    res.json(profile);
  } catch (error) {
    next(error);
  }
});

// add this endpoint (reuse your existing service and schema)
router.patch("/profile", authMiddleware, rateLimitMiddleware, async (req, res, next) => {
  try {
    const uid = req.user?.effectiveUserId ?? req.user?.userId;

    // Normalize incoming name to DB column
    const body = req.body ?? {};
    const display_name =
      body.display_name !== undefined ? body.display_name :
      body.displayName !== undefined ? body.displayName :
      undefined;

    const payload = {
      user_id: uid,
      // keep any other fields you already allow here...
      display_name,                         // <- write to DB column
      image_url: body.image_url ?? body.imageUrl ?? undefined,
      email: body.email,
      phone: body.phone,
      country: body.country,
      profile_diets: body.profile_diets ?? body.profileDiets,
      profile_allergens: body.profile_allergens ?? body.profileAllergens,
      preferred_cuisines: body.preferred_cuisines ?? body.preferredCuisines,
      target_calories: body.target_calories ?? body.targetCalories,
      target_protein_g: body.target_protein_g ?? body.targetProteinG,
      target_carbs_g: body.target_carbs_g ?? body.targetCarbsG,
      target_fat_g: body.target_fat_g ?? body.targetFatG,
      updated_at: new Date().toISOString(),
    };

    // Remove undefined keys so upsert only touches provided fields
    Object.keys(payload).forEach((k) => (payload as any)[k] === undefined && delete (payload as any)[k]);

    const { data, error } = await supabase
      .from("user_profiles")
      .upsert(payload, { onConflict: "user_id" })
      .select(`
        user_id, display_name, image_url, email, phone, country,
        profile_diets, profile_allergens, preferred_cuisines,
        target_calories, target_protein_g, target_carbs_g, target_fat_g,
        created_at, updated_at
      `)
      .maybeSingle();

    if (error) throw error;

    const dto = data
      ? {
          userId: data.user_id,
          displayName: data.display_name ?? null,
          display_name: data.display_name ?? null,
          imageUrl: data.image_url ?? null,
          email: data.email ?? null,
          phone: data.phone ?? null,
          country: data.country ?? null,
          profileDiets: data.profile_diets ?? [],
          profileAllergens: data.profile_allergens ?? [],
          preferredCuisines: data.preferred_cuisines ?? [],
          targetCalories: data.target_calories,
          targetProteinG: data.target_protein_g,
          targetCarbsG: data.target_carbs_g,
          targetFatG: data.target_fat_g,
          createdAt: data.created_at,
          updatedAt: data.updated_at,
        }
      : {};

    res.json(dto);
  } catch (err) {
    next(err);
  }
});

router.delete("/profile", authMiddleware, rateLimitMiddleware, async (req, res, next) => {
  try {
    const uid = userId(req);
    // delete health first (FK points to user_profiles)
    await supabase.from("health_profiles").delete().eq("user_id", uid);
    await supabase.from("user_profiles").delete().eq("user_id", uid);
    res.status(204).end();
  } catch (error) {
    next(error);
  }
});

router.get("/health", authMiddleware, rateLimitMiddleware, async (req, res, next) => {
  try {
    const uid = req.user?.effectiveUserId ?? req.user?.userId;

    const { data, error } = await supabase
      .from("health_profiles")
      .select(`
        user_id,
        date_of_birth,
        sex,
        activity_level,
        goal,
        diets,
        allergens,
        intolerances,
        disliked_ingredients,
        onboarding_complete,
        height_display,
        weight_display,
        height_cm,
        weight_kg,
        major_conditions,
        created_at,
        updated_at
      `)
      .eq("user_id", uid)
      .maybeSingle();

    if (error) throw error;
    if (!data) return res.json({});

    // Map DB -> API (camelCase), also include snake_case aliases for compatibility
    const dto = {
      userId: data.user_id,
      dateOfBirth: data.date_of_birth ?? null,
      sex: data.sex ?? null,
      activityLevel: data.activity_level ?? null,
      goal: data.goal ?? null,
      diets: data.diets ?? [],
      allergens: data.allergens ?? [],
      intolerances: data.intolerances ?? [],
      dislikedIngredients: data.disliked_ingredients ?? [],
      onboardingComplete: !!data.onboarding_complete,
      heightDisplay: data.height_display ?? null,
      weightDisplay: data.weight_display ?? null,
      heightCm: data.height_cm ?? null,
      weightKg: data.weight_kg ?? null,
      majorConditions: data.major_conditions ?? [],
      createdAt: data.created_at,
      updatedAt: data.updated_at,
    };

    res.json(dto);
  } catch (err) {
    next(err);
  }
});

router.patch("/health", authMiddleware, rateLimitMiddleware, async (req, res, next) => {
  try {
    const uid = req.user?.effectiveUserId ?? req.user?.userId;
    const b = req.body ?? {};

    // Accept both snake_case and camelCase; normalize to DB columns
    const normalized = {
      user_id: uid,
      date_of_birth: b.date_of_birth ?? b.dateOfBirth,
      sex: b.sex,
      activity_level: b.activity_level ?? b.activityLevel,
      goal: b.goal,
      diets: b.diets,
      allergens: b.allergens ?? b.allergies, // tolerate old key 'allergies'
      intolerances: b.intolerances,
      disliked_ingredients: b.disliked_ingredients ?? b.dislikedIngredients,
      onboarding_complete:
        b.onboarding_complete !== undefined ? b.onboarding_complete :
        b.onboardingComplete !== undefined ? b.onboardingComplete :
        undefined,

      height_display: b.height_display ?? b.heightDisplay,
      weight_display: b.weight_display ?? b.weightDisplay,

      // numeric fields – accept camel/snake and coerce strings to numbers if needed
      height_cm:
        b.height_cm !== undefined ? (b.height_cm === null ? null : Number(b.height_cm)) :
        b.heightCm !== undefined ? (b.heightCm === null ? null : Number(b.heightCm)) :
        undefined,
      weight_kg:
        b.weight_kg !== undefined ? (b.weight_kg === null ? null : Number(b.weight_kg)) :
        b.weightKg !== undefined ? (b.weightKg === null ? null : Number(b.weightKg)) :
        undefined,
        major_conditions:
        b.major_conditions !== undefined
          ? (b.major_conditions === null ? null : b.major_conditions) :
        b.majorConditions !== undefined
          ? (b.majorConditions === null ? null : b.majorConditions) :
        undefined,  

      updated_at: new Date().toISOString(),
    };

    // strip undefined keys so we only upsert what was provided
    Object.keys(normalized).forEach((k) => (normalized as any)[k] === undefined && delete (normalized as any)[k]);

    const { data, error } = await supabase
      .from("health_profiles")
      .upsert(normalized, { onConflict: "user_id" })
      .select(`
        user_id,
        date_of_birth,
        sex,
        activity_level,
        goal,
        diets,
        allergens,
        intolerances,
        disliked_ingredients,
        onboarding_complete,
        height_display,
        weight_display,
        height_cm,
        weight_kg,
        major_conditions,
        created_at,
        updated_at
      `)
      .maybeSingle();

    if (error) throw error;

    // Return the same DTO shape as GET /health
    const dto = data ? {
      userId: data.user_id,
      dateOfBirth: data.date_of_birth ?? null,
      sex: data.sex ?? null,
      activityLevel: data.activity_level ?? null,
      goal: data.goal ?? null,
      diets: data.diets ?? [],
      allergens: data.allergens ?? [],
      intolerances: data.intolerances ?? [],
      dislikedIngredients: data.disliked_ingredients ?? [],
      onboardingComplete: !!data.onboarding_complete,
      heightDisplay: data.height_display ?? null,
      weightDisplay: data.weight_display ?? null,
      heightCm: data.height_cm ?? null,
      weightKg: data.weight_kg ?? null,
      majorConditions: data.major_conditions ?? [],
      createdAt: data.created_at,
      updatedAt: data.updated_at,
    } : {};

    res.json(dto);
  } catch (err) {
    next(err);
  }
});

// Saved recipes
router.get("/saved", authMiddleware, rateLimitMiddleware, async (req, res, next) => {
  try {
    const limit = req.query.limit ? parseInt(req.query.limit as string) : 50;
    const offset = req.query.offset ? parseInt(req.query.offset as string) : 0;
    
    const saved = await getSavedRecipes(getUserId(req), limit, offset);
    res.json(saved);
  } catch (error) {
    next(error);
  }
});

// Recipe history
router.post("/history", authMiddleware, rateLimitMiddleware, async (req, res, next) => {
  try {
    const historyData = insertRecipeHistorySchema.parse({
      ...req.body,
      userId: getUserId(req),
    });
    
    await logRecipeHistory(historyData);
    res.status(201).json({ success: true });
  } catch (error) {
    next(error);
  }
});

router.get("/history", authMiddleware, rateLimitMiddleware, async (req, res, next) => {
  try {
    const event = req.query.event as string;
    const limit = req.query.limit ? parseInt(req.query.limit as string) : 50;
    const offset = req.query.offset ? parseInt(req.query.offset as string) : 0;
    
    const history = await getRecipeHistory(getUserId(req), event, limit, offset);
    res.json(history);
  } catch (error) {
    next(error);
  }
});

router.delete("/history", authMiddleware, rateLimitMiddleware, async (req, res, next) => {
  try {
    await executeRaw("DELETE FROM recipe_history WHERE user_id = $1", [getUserId(req)]);
    res.status(204).end();
  } catch (error) {
    next(error);
  }
});

router.get("/recently-viewed", authMiddleware, rateLimitMiddleware, async (req, res, next) => {
  try {
    const limit = req.query.limit ? parseInt(req.query.limit as string) : 20;
    const recent = await getRecentlyViewed(getUserId(req), limit);
    res.json(recent);
  } catch (error) {
    next(error);
  }
});

router.get("/most-cooked", authMiddleware, rateLimitMiddleware, async (req, res, next) => {
  try {
    const limit = req.query.limit ? parseInt(req.query.limit as string) : 20;
    const cooked = await getMostCooked(getUserId(req), limit);
    res.json(cooked);
  } catch (error) {
    next(error);
  }
});

// User-generated recipes
router.post("/my-recipes", authMiddleware, rateLimitMiddleware, async (req, res, next) => {
  try {
    const recipeData = insertUserRecipeSchema.parse(req.body);
    const recipe = await createUserRecipe(getUserId(req), recipeData);
    res.status(201).json(recipe);
  } catch (error) {
    next(error);
  }
});

router.get("/my-recipes", authMiddleware, rateLimitMiddleware, async (req, res, next) => {
  try {
    const limit = req.query.limit ? parseInt(req.query.limit as string) : 50;
    const offset = req.query.offset ? parseInt(req.query.offset as string) : 0;
    
    const recipes = await getUserRecipes(getUserId(req), limit, offset);
    res.json(recipes);
  } catch (error) {
    next(error);
  }
});

router.patch("/my-recipes/:id", authMiddleware, rateLimitMiddleware, async (req, res, next) => {
  try {
    const updates = insertUserRecipeSchema.partial().parse(req.body);
    const recipe = await updateUserRecipe(getUserId(req), req.params.id, updates);
    res.json(recipe);
  } catch (error) {
    next(error);
  }
});

router.post("/my-recipes/:id/share", authMiddleware, rateLimitMiddleware, async (req, res, next) => {
  try {
    const result = await shareUserRecipe(getUserId(req), req.params.id);
    res.json(result);
  } catch (error) {
    next(error);
  }
});

router.post("/my-recipes/:id/unshare", authMiddleware, rateLimitMiddleware, async (req, res, next) => {
  try {
    const recipe = await unshareUserRecipe(getUserId(req), req.params.id);
    res.json(recipe);
  } catch (error) {
    next(error);
  }
});

router.post("/my-recipes/:id/submit", authMiddleware, rateLimitMiddleware, async (req, res, next) => {
  try {
    const recipe = await submitForReview(getUserId(req), req.params.id);
    res.json(recipe);
  } catch (error) {
    next(error);
  }
});

router.delete("/account", authMiddleware, rateLimitMiddleware, async (req, res, next) => {
  const uid = userId(req);
  try {
    // -------- Supabase: transactional cleanup --------
    await executeRaw("BEGIN");
    await executeRaw("DELETE FROM saved_recipes WHERE user_id = $1", [uid]);
    await executeRaw("DELETE FROM recipe_history WHERE user_id = $1", [uid]);
    await executeRaw("DELETE FROM user_recipe_history WHERE user_id = $1", [uid]);

    // if your schema has approved_recipe_id pointing into user_recipes:
    await executeRaw("UPDATE user_recipes SET approved_recipe_id = NULL WHERE owner_user_id = $1", [uid]);
    await executeRaw("DELETE FROM user_recipes WHERE owner_user_id = $1", [uid]);

    // reports authored by this user
    await executeRaw(`
      DELETE FROM recipe_report_resolutions
      WHERE report_id IN (SELECT id FROM recipe_reports WHERE reporter_user_id = $1)
    `, [uid]);
    await executeRaw("DELETE FROM recipe_reports WHERE reporter_user_id = $1", [uid]);

    // profiles last (honor FK)
    await executeRaw("DELETE FROM health_profiles WHERE user_id = $1", [uid]);
    await executeRaw("DELETE FROM user_profiles  WHERE user_id = $1", [uid]);
    await executeRaw("COMMIT");

    // -------- Appwrite: best-effort cleanup --------
    await deleteAppwriteDocuments(uid); // profiles + health_profiles collections
    await deleteAppwriteUser(uid);      // Appwrite auth user

    res.status(204).end();
  } catch (error) {
    try { await executeRaw("ROLLBACK"); } catch {}
    next(error);
  }
});

export default router;
