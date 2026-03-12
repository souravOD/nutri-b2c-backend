import { db, executeRaw } from "../config/database.js";
import { eq, and, desc, sql } from "drizzle-orm";
import {
  mealPlans,
  mealPlanItems,
  recipes,
  recipeNutritionProfiles,
  b2cCustomers,
} from "../../shared/goldSchema.js";
import {
  getOrCreateHousehold,
  getMemberHealthProfiles,
  type MemberHealthProfile,
} from "./household.js";
import { getRecipeNutritionMap } from "./recipeHydration.js";
import { getLowRatedRecipeIds } from "./recipeRating.js";
import {
  generateMealPlanWithLLM,
  suggestSwapWithLLM,
  getLLMModelName,
  type MemberContext,
  type LLMPlanResponse,
  type RecipeOption,
  type PlanGenerationContext,
} from "./mealPlanLLM.js";
import { addMealItem } from "./mealLog.js";
import { resolveCuisineIds } from "./b2cTaxonomy.js";
import { ragMealCandidates } from "./ragClient.js";

// ── Types ───────────────────────────────────────────────────────────────────

export interface GeneratePlanInput {
  startDate: string;
  endDate: string;
  memberIds: string[];
  budgetAmount?: number;
  budgetCurrency?: string;
  mealsPerDay: string[];
  preferences?: {
    maxCookTime?: number;
    cuisines?: string[];
    excludeRecipeIds?: string[];
    prompt?: string;
  };
}

interface NutritionSnapshot {
  calories: number;
  proteinG: number;
  carbsG: number;
  fatG: number;
  fiberG: number;
  sugarG: number;
  sodiumMg: number;
}

function n(val: string | number | null | undefined): number {
  if (val == null) return 0;
  const parsed = typeof val === "string" ? parseFloat(val) : val;
  return Number.isFinite(parsed) ? parsed : 0;
}

function dateRangeInclusive(startDate: string, endDate: string): string[] {
  const out: string[] = [];
  const current = new Date(`${startDate}T00:00:00Z`);
  const end = new Date(`${endDate}T00:00:00Z`);
  while (current <= end) {
    out.push(current.toISOString().slice(0, 10));
    current.setUTCDate(current.getUTCDate() + 1);
  }
  return out;
}

function buildRuleBasedFallbackPlan(context: PlanGenerationContext, reason: string): LLMPlanResponse {
  const meals: LLMPlanResponse["meals"] = [];
  const usedRecipeIds = new Set<string>();
  const dates = dateRangeInclusive(context.startDate, context.endDate);
  let pickCursor = 0;

  function candidatesForMealType(mealType: string): RecipeOption[] {
    const exact = context.recipes.filter((r) => r.mealType === mealType);
    const neutral = context.recipes.filter((r) => !r.mealType);
    if (exact.length > 0) return [...exact, ...neutral];
    return [...neutral, ...context.recipes];
  }

  for (const date of dates) {
    for (const mealType of context.mealsPerDay) {
      const baseCandidates = candidatesForMealType(mealType);
      const noRepeat = baseCandidates.filter((r) => !usedRecipeIds.has(r.id));
      const pool = noRepeat.length > 0 ? noRepeat : baseCandidates;
      if (pool.length === 0) continue;

      const chosen = pool[pickCursor % pool.length];
      pickCursor += 1;
      usedRecipeIds.add(chosen.id);

      meals.push({
        date,
        mealType,
        recipeId: chosen.id,
        servings: 1,
        estimatedCost: null,
        reasoning: "Rule-based fallback selection",
      });
    }
  }

  return {
    meals,
    totalEstimatedCost: null,
    planSummary: `Generated with fallback planner because AI planner was unavailable (${reason}).`,
  };
}

function buildRuleBasedSwapFallback(
  alternatives: RecipeOption[],
  currentRecipeId: string,
  reason?: string
) {
  const chosen = alternatives.find((r) => r.id !== currentRecipeId) ?? alternatives[0];
  return {
    recipeId: chosen.id,
    servings: 1,
    estimatedCost: null as number | null,
    reasoning: reason
      ? `Rule-based swap fallback used while AI was unavailable (${reason}).`
      : "Rule-based swap fallback used while AI was unavailable.",
  };
}

// ── Plan Name Builder ───────────────────────────────────────────────────────

function buildPlanName(input: {
  startDate: string;
  endDate: string;
  preferences?: { prompt?: string; cuisines?: string[] };
  budgetAmount?: number;
  memberDiets: string[];
}): string {
  const parts: string[] = [];

  // Extract keywords from user prompt
  if (input.preferences?.prompt) {
    const p = input.preferences.prompt.toLowerCase();
    const keywords: string[] = [];
    if (/high.?protein/i.test(p)) keywords.push("High Protein");
    if (/low.?cal/i.test(p) || /low.?calorie/i.test(p)) keywords.push("Low Calorie");
    if (/low.?carb/i.test(p)) keywords.push("Low Carb");
    if (/low.?fat/i.test(p)) keywords.push("Low Fat");
    if (/healthy/i.test(p)) keywords.push("Healthy");
    if (/quick|fast|easy/i.test(p)) keywords.push("Quick & Easy");
    if (/budget|cheap|affordable/i.test(p) || /under \$?\d+/i.test(p)) keywords.push("Budget-Friendly");
    if (/family/i.test(p)) keywords.push("Family");
    if (/keto/i.test(p)) keywords.push("Keto");
    if (keywords.length > 0) parts.push(keywords.slice(0, 3).join(" "));
  }

  // Add diet preference
  if (input.memberDiets.length > 0 && !parts.some((p) => /vegan|vegetarian|keto/i.test(p))) {
    const primaryDiet = input.memberDiets[0];
    if (primaryDiet) parts.push(primaryDiet);
  }

  // Add cuisine if specified
  if (input.preferences?.cuisines?.length) {
    const c = input.preferences.cuisines[0];
    if (c && !parts.some((p) => p.toLowerCase().includes(c.toLowerCase()))) {
      parts.push(c);
    }
  }

  // Add budget tag if not already from prompt
  if (input.budgetAmount && !parts.some((p) => /budget/i.test(p))) {
    parts.push("Budget-Friendly");
  }

  // Fallback
  if (parts.length === 0) parts.push("Weekly Meal");
  parts.push("Plan");

  // Add date range suffix (compact: "Mar 9–15")
  try {
    const start = new Date(input.startDate + "T00:00:00");
    const end = new Date(input.endDate + "T00:00:00");
    const monthNames = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
    const sameMonth = start.getMonth() === end.getMonth();
    const dateStr = sameMonth
      ? `${monthNames[start.getMonth()]} ${start.getDate()}–${end.getDate()}`
      : `${monthNames[start.getMonth()]} ${start.getDate()} – ${monthNames[end.getMonth()]} ${end.getDate()}`;
    parts.push(`· ${dateStr}`);
  } catch {
    // If date parsing fails, just use the raw dates
    parts.push(`· ${input.startDate} to ${input.endDate}`);
  }

  return parts.join(" ");
}

// ── Fetch Recipe Catalog ────────────────────────────────────────────────────

async function fetchRecipeCatalog(params: {
  cuisineIds?: string[];
  maxCookTime?: number;
  excludeIds: string[];
  limit: number;
  memberDiets?: string[];
}): Promise<RecipeOption[]> {
  let query = `
    SELECT
      r.id, r.title, r.meal_type, c.name AS cuisine,
      COALESCE(rnp.calories, 0)::int AS calories,
      COALESCE(rnp.protein_g, 0)::numeric AS protein_g,
      COALESCE(rnp.total_carbs_g, 0)::numeric AS carbs_g,
      COALESCE(rnp.total_fat_g, 0)::numeric AS fat_g,
      r.cook_time_minutes,
      COALESCE(
        ARRAY(
          SELECT a.code FROM gold.ingredient_allergens ia
          JOIN gold.recipe_ingredients ri ON ri.ingredient_id = ia.ingredient_id
          JOIN gold.allergens a ON a.id = ia.allergen_id
          WHERE ri.recipe_id = r.id
        ), '{}'
      ) AS allergen_codes,
      COALESCE(
        ARRAY(
          SELECT dp.code FROM gold.diet_ingredient_rules dir
          JOIN gold.recipe_ingredients ri ON ri.ingredient_id = dir.ingredient_id
          JOIN gold.dietary_preferences dp ON dp.id = dir.diet_id
          WHERE ri.recipe_id = r.id AND dir.rule_type = 'allowed'
        ), '{}'
      ) AS diet_codes
    FROM gold.recipes r
    LEFT JOIN gold.recipe_nutrition_profiles rnp ON rnp.recipe_id = r.id
    LEFT JOIN gold.cuisines c ON c.id = r.cuisine_id
    WHERE COALESCE(r.source_type, 'curated') IN ('curated', 'user_generated')
  `;

  const queryParams: any[] = [];
  let paramIdx = 1;

  if (params.excludeIds.length > 0) {
    query += ` AND r.id != ALL($${paramIdx}::uuid[])`;
    queryParams.push(params.excludeIds);
    paramIdx++;
  }

  if (params.maxCookTime) {
    query += ` AND (r.cook_time_minutes IS NULL OR r.cook_time_minutes <= $${paramIdx})`;
    queryParams.push(params.maxCookTime);
    paramIdx++;
  }

  if (params.cuisineIds && params.cuisineIds.length > 0) {
    query += ` AND r.cuisine_id = ANY($${paramIdx}::uuid[])`;
    queryParams.push(params.cuisineIds);
    paramIdx++;
  }

  query += ` ORDER BY RANDOM() LIMIT $${paramIdx}`;
  queryParams.push(params.limit);

  const rows = (await executeRaw(query, queryParams)) as any[];

  let results = rows.map((r) => ({
    id: r.id,
    title: r.title,
    mealType: r.meal_type,
    cuisine: r.cuisine,
    calories: n(r.calories),
    proteinG: n(r.protein_g),
    carbsG: n(r.carbs_g),
    fatG: n(r.fat_g),
    cookTimeMinutes: r.cook_time_minutes,
    allergens: r.allergen_codes || [],
    diets: r.diet_codes || [],
  }));

  // Diet compliance filter: drop recipes with meat/fish titles for vegan/vegetarian
  if (params.memberDiets && params.memberDiets.length > 0) {
    const dietSet = new Set(params.memberDiets.map((d) => d.toLowerCase()));
    const isVegDiet = dietSet.has("vegan") || dietSet.has("vegetarian");
    if (isVegDiet) {
      const BLOCKLIST = [
        "chicken", "beef", "pork", "lamb", "turkey", "duck", "steak",
        "bacon", "ham", "sausage", "venison", "fish", "salmon", "tuna",
        "shrimp", "lobster", "crab", "scallop", "meat", "seafood",
      ];
      results = results.filter((r) => {
        const title = r.title.toLowerCase();
        return !BLOCKLIST.some((term) => title.includes(term));
      });
    }
  }

  return results;
}

// ── Graph-Scored Recipe Candidates (PRD-12) ─────────────────────────────────

async function getRecipeCandidates(
  b2cCustomerId: string,
  members: MemberContext[],
  params: { cuisineIds?: string[]; maxCookTime?: number; excludeIds: string[]; limit: number; memberDiets?: string[] }
): Promise<RecipeOption[]> {
  // Try RAG-scored candidates first
  const graphCandidates = await ragMealCandidates({
    customer_id: b2cCustomerId,
    members: members.map((m, i) => ({
      id: `member-${i}`,
      allergen_ids: m.allergens,
      diet_ids: m.diets,
      health_profile: {
        calorie_target: m.calorieTarget,
        protein_target_g: m.proteinTargetG,
      },
    })),
    meal_history: params.excludeIds,
    date_range: { start: new Date().toISOString().slice(0, 10), end: new Date().toISOString().slice(0, 10) },
    meals_per_day: ["breakfast", "lunch", "dinner"],
    limit: params.limit,
  });

  if (graphCandidates && graphCandidates.candidates.length > 0) {
    // Validate that candidate IDs are real UUIDs before using them
    const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    const hasValidIds = graphCandidates.candidates.every(
      (c: any) => c.recipe_id && UUID_RE.test(c.recipe_id)
    );

    if (hasValidIds) {
      return graphCandidates.candidates.map((c: any) => ({
        id: c.recipe_id,
        title: c.title,
        mealType: c.meal_type ?? null,
        cuisine: c.cuisine ?? null,
        calories: c.calories ?? 0,
        proteinG: c.protein_g ?? 0,
        carbsG: c.carbs_g ?? 0,
        fatG: c.fat_g ?? 0,
        cookTimeMinutes: c.cook_time_minutes ?? null,
        allergens: c.allergens ?? [],
        diets: c.diets ?? [],
        graphScore: c.score,
        graphReasons: c.reasons,
      }));
    } else {
      console.warn("[RAG] Meal candidates have non-UUID IDs, falling back to SQL catalog");
    }
  }

  // SQL fallback — existing fetchRecipeCatalog() with diet filtering
  return fetchRecipeCatalog(params);
}

// ── Get Nutrition for Recipe ────────────────────────────────────────────────

async function getRecipeNutrition(recipeId: string): Promise<NutritionSnapshot> {
  const rows = await db
    .select()
    .from(recipeNutritionProfiles)
    .where(eq(recipeNutritionProfiles.recipeId, recipeId))
    .limit(1);

  const r = rows[0];
  if (r && n(r.calories) > 0) {
    return {
      calories: Math.round(n(r.calories)),
      proteinG: Math.round(n(r.proteinG) * 100) / 100,
      carbsG: Math.round(n(r.totalCarbsG) * 100) / 100,
      fatG: Math.round(n(r.totalFatG) * 100) / 100,
      fiberG: Math.round(n(r.dietaryFiberG) * 100) / 100,
      sugarG: Math.round(n(r.totalSugarsG) * 100) / 100,
      sodiumMg: Math.round(n(r.sodiumMg)),
    };
  }

  // Fallback: use nutrition_facts + nutrition_definitions (same source as recipe detail drawer)
  const nutritionMap = await getRecipeNutritionMap([recipeId]);
  const nf = nutritionMap.get(recipeId);
  if (!nf) return { calories: 0, proteinG: 0, carbsG: 0, fatG: 0, fiberG: 0, sugarG: 0, sodiumMg: 0 };

  return {
    calories: Math.round(n(nf.calories)),
    proteinG: Math.round(n(nf.protein_g) * 100) / 100,
    carbsG: Math.round(n(nf.carbs_g) * 100) / 100,
    fatG: Math.round(n(nf.fat_g) * 100) / 100,
    fiberG: Math.round(n(nf.fiber_g) * 100) / 100,
    sugarG: Math.round(n(nf.sugar_g) * 100) / 100,
    sodiumMg: Math.round(n(nf.sodium_mg)),
  };
}

// ── Generate Meal Plan ──────────────────────────────────────────────────────

export async function generateMealPlan(
  b2cCustomerId: string,
  input: GeneratePlanInput
) {
  const startTime = Date.now();

  const household = await getOrCreateHousehold(b2cCustomerId);
  const memberProfiles = await getMemberHealthProfiles(input.memberIds);

  const members: MemberContext[] = [];
  for (const memberId of input.memberIds) {
    const customerRows = await db
      .select({ fullName: b2cCustomers.fullName, age: b2cCustomers.age })
      .from(b2cCustomers)
      .where(eq(b2cCustomers.id, memberId))
      .limit(1);

    const cust = customerRows[0];
    const profile = memberProfiles.get(memberId);

    members.push({
      name: cust?.fullName || "Member",
      age: cust?.age ?? null,
      allergens: profile?.allergens.map((a) => a.code) ?? [],
      diets: profile?.diets.map((d) => d.code) ?? [],
      conditions: profile?.conditions.map((c) => c.code) ?? [],
      calorieTarget: profile?.targetCalories ?? null,
      proteinTargetG: profile?.targetProteinG ? n(profile.targetProteinG) : null,
      carbsTargetG: profile?.targetCarbsG ? n(profile.targetCarbsG) : null,
      fatTargetG: profile?.targetFatG ? n(profile.targetFatG) : null,
    });
  }

  const lowRatedIds = await getLowRatedRecipeIds(b2cCustomerId);
  const allExcluded = [
    ...lowRatedIds,
    ...(input.preferences?.excludeRecipeIds ?? []),
  ];

  const maxRecipes = parseInt(process.env.MEAL_PLAN_MAX_RECIPES || "50", 10);
  const preferredCuisines = input.preferences?.cuisines ?? [];
  const cuisineIds = preferredCuisines.length > 0
    ? await resolveCuisineIds(preferredCuisines)
    : [];

  // Collect all member diets for candidate filtering
  const allMemberDiets = [...new Set(members.flatMap((m) => m.diets))];

  let recipeCatalog = await getRecipeCandidates(b2cCustomerId, members, {
    cuisineIds,
    maxCookTime: input.preferences?.maxCookTime,
    excludeIds: allExcluded,
    limit: maxRecipes,
    memberDiets: allMemberDiets,
  });
  let cuisineFallbackApplied = preferredCuisines.length > 0 && cuisineIds.length === 0;

  // Soft preference mode: if preferred cuisines produce no matches, fall back.
  if (preferredCuisines.length > 0 && recipeCatalog.length === 0) {
    recipeCatalog = await getRecipeCandidates(b2cCustomerId, members, {
      maxCookTime: input.preferences?.maxCookTime,
      excludeIds: allExcluded,
      limit: maxRecipes,
      memberDiets: allMemberDiets,
    });
    cuisineFallbackApplied = recipeCatalog.length > 0;
  }

  if (recipeCatalog.length === 0) {
    const err = new Error("No recipes available matching the given constraints. Try relaxing your filters.");
    (err as any).status = 422;
    throw err;
  }

  const llmContext: PlanGenerationContext = {
    members,
    recipes: recipeCatalog,
    startDate: input.startDate,
    endDate: input.endDate,
    mealsPerDay: input.mealsPerDay,
    budgetAmount: input.budgetAmount,
    budgetCurrency: input.budgetCurrency,
    excludeRecipeIds: allExcluded,
    maxCookTime: input.preferences?.maxCookTime,
    preferredCuisines,
    userPrompt: input.preferences?.prompt,
  };

  let llmResult: LLMPlanResponse;
  let llmFallbackApplied = false;
  try {
    llmResult = await generateMealPlanWithLLM(llmContext);
  } catch (error: any) {
    const reason = String(error?.message || "LLM unavailable");
    // Keep plan generation available even when LLM provider is rate-limited/down.
    llmResult = buildRuleBasedFallbackPlan(llmContext, reason);
    llmFallbackApplied = true;
  }

  const validRecipeIds = new Set(recipeCatalog.map((r) => r.id));
  const allowedMealTypes = new Set(["breakfast", "lunch", "dinner", "snack"]);
  const normalizedMeals = llmResult.meals.map((m) => ({
    ...m,
    mealType: String(m.mealType || "").toLowerCase(),
  }));
  let validatedMeals = normalizedMeals.filter(
    (m) => validRecipeIds.has(m.recipeId) && allowedMealTypes.has(m.mealType)
  );

  console.log("[MealPlan] Validation:", {
    totalLLMMeals: llmResult.meals.length,
    validMeals: validatedMeals.length,
    invalidRecipeIds: normalizedMeals
      .filter((m) => !validRecipeIds.has(m.recipeId))
      .map((m) => m.recipeId)
      .slice(0, 5),
  });

  if (validatedMeals.length === 0) {
    const fallback = buildRuleBasedFallbackPlan(
      llmContext,
      "LLM returned invalid recipe or meal type selections"
    );
    validatedMeals = fallback.meals.filter(
      (m) => validRecipeIds.has(m.recipeId) && allowedMealTypes.has(m.mealType)
    );
    llmFallbackApplied = true;
    if (validatedMeals.length === 0) {
      const err = new Error("Could not generate a valid meal plan from available recipes.");
      (err as any).status = 422;
      throw err;
    }
  }

  const generationTimeMs = Date.now() - startTime;

  let totalCost = 0;
  let totalCalories = 0;

  console.log("[MealPlan] Fetching nutrition for", validatedMeals.length, "unique recipes…");
  const nutritionSnapshots = new Map<string, NutritionSnapshot>();
  const uniqueRecipeIds = [...new Set(validatedMeals.map((m) => m.recipeId))];
  for (const rid of uniqueRecipeIds) {
    nutritionSnapshots.set(rid, await getRecipeNutrition(rid));
  }
  console.log("[MealPlan] Nutrition fetched for", nutritionSnapshots.size, "recipes");

  try {
    console.log("[MealPlan] Inserting meal plan into DB…");
    const planRows = await db
      .insert(mealPlans)
      .values({
        householdId: household.id,
        b2cCustomerId,
        planName: buildPlanName({
          startDate: input.startDate,
          endDate: input.endDate,
          preferences: input.preferences,
          budgetAmount: input.budgetAmount,
          memberDiets: allMemberDiets,
        }),
        startDate: input.startDate,
        endDate: input.endDate,
        status: "draft",
        mealsPerDay: input.mealsPerDay,
        generationParams: llmContext as any,
        aiModel: getLLMModelName(),
        budgetAmount: input.budgetAmount ? String(input.budgetAmount) : null,
        budgetCurrency: input.budgetCurrency ?? "USD",
        memberIds: input.memberIds,
        generationTimeMs,
      })
      .returning();

    const plan = planRows[0];
    console.log("[MealPlan] Plan inserted:", plan.id);

    const itemValues = validatedMeals.map((meal) => {
      const nutrition = nutritionSnapshots.get(meal.recipeId);
      if (!nutrition) {
        console.error("[MealPlan] Missing nutrition for recipeId:", meal.recipeId);
      }
      const safeNutrition = nutrition || { calories: 0, proteinG: 0, carbsG: 0, fatG: 0, fiberG: 0, sugarG: 0, sodiumMg: 0 };
      const cost = meal.estimatedCost ?? null;
      if (cost) totalCost += cost;
      totalCalories += safeNutrition.calories * (meal.servings || 1);

      return {
        mealPlanId: plan.id,
        recipeId: meal.recipeId,
        mealDate: meal.date,
        mealType: meal.mealType,
        servings: meal.servings || 1,
        forMemberIds: input.memberIds,
        estimatedCost: cost ? String(cost) : null,
        caloriesPerServing: safeNutrition.calories,
        status: "planned" as const,
        nutritionSnapshot: safeNutrition as any,
      };
    });

    console.log("[MealPlan] Inserting", itemValues.length, "meal items…");
    const insertedItems = await db.insert(mealPlanItems).values(itemValues).returning();
    console.log("[MealPlan] Items inserted:", insertedItems.length);

    await db
      .update(mealPlans)
      .set({
        totalEstimatedCost: totalCost > 0 ? String(totalCost) : null,
        totalCalories,
      })
      .where(eq(mealPlans.id, plan.id));
    console.log("[MealPlan] Plan updated with totals");

    const hydratedItems = await hydrateItems(insertedItems);
    console.log("[MealPlan] Hydration complete");

    return {
      plan: { ...plan, totalEstimatedCost: totalCost > 0 ? String(totalCost) : null, totalCalories },
      items: hydratedItems,
      generationTimeMs,
      summary: (() => {
        let out = llmResult.planSummary;
        if (llmFallbackApplied) {
          out = `${out} Note: AI planner fallback was used due to provider unavailability.`;
        }
        if (cuisineFallbackApplied) {
          out = `${out} Note: preferred cuisines were unavailable, so broader recipes were used.`;
        }
        return out;
      })(),
    };
  } catch (dbError: any) {
    console.error("[MealPlan] Post-LLM DB operation failed:", dbError?.message || dbError);
    console.error("[MealPlan] Full error:", dbError);
    throw dbError;
  }
}
// ── List Plans ──────────────────────────────────────────────────────────────

export async function listPlans(
  b2cCustomerId: string,
  status?: string,
  limit = 20,
  offset = 0,
  memberId?: string
) {
  const household = await getOrCreateHousehold(b2cCustomerId);

  let conditions = [eq(mealPlans.householdId, household.id)];
  if (status) {
    conditions.push(eq(mealPlans.status, status));
  }
  if (memberId) {
    // PostgreSQL: member_ids @> ARRAY[memberId]::uuid[]
    conditions.push(sql`${mealPlans.memberIds} @> ARRAY[${memberId}]::uuid[]`);
  }

  const plans = await db
    .select()
    .from(mealPlans)
    .where(and(...conditions))
    .orderBy(desc(mealPlans.createdAt))
    .limit(limit)
    .offset(offset);

  return { plans };
}

// ── Get Plan Detail ─────────────────────────────────────────────────────────

export async function getPlanDetail(planId: string) {
  const planRows = await db
    .select()
    .from(mealPlans)
    .where(eq(mealPlans.id, planId))
    .limit(1);

  if (!planRows[0]) {
    const err = new Error("Meal plan not found");
    (err as any).status = 404;
    throw err;
  }

  const items = await db
    .select()
    .from(mealPlanItems)
    .where(eq(mealPlanItems.mealPlanId, planId))
    .orderBy(mealPlanItems.mealDate, mealPlanItems.mealType);

  // Self-heal: backfill items missing caloriesPerServing
  const nullCalItems = items.filter((i) => (i.caloriesPerServing == null || i.caloriesPerServing === 0) && i.recipeId);
  if (nullCalItems.length > 0) {
    for (const item of nullCalItems) {
      try {
        const nutrition = await getRecipeNutrition(item.recipeId!);
        if (nutrition.calories > 0) {
          await db
            .update(mealPlanItems)
            .set({
              caloriesPerServing: nutrition.calories,
              nutritionSnapshot: nutrition as any,
            })
            .where(eq(mealPlanItems.id, item.id));
          // Patch the in-memory item so hydrated response is correct
          item.caloriesPerServing = nutrition.calories;
          item.nutritionSnapshot = nutrition as any;
        }
      } catch { /* silent */ }
    }
  }

  const hydratedItems = await hydrateItems(items);

  return { plan: planRows[0], items: hydratedItems };
}

// ── Activate Plan ───────────────────────────────────────────────────────────

export async function activatePlan(planId: string, b2cCustomerId: string) {
  const household = await getOrCreateHousehold(b2cCustomerId);

  // Fetch the plan being activated to know its memberIds
  const planToActivate = await db
    .select({ memberIds: mealPlans.memberIds })
    .from(mealPlans)
    .where(eq(mealPlans.id, planId))
    .limit(1);

  if (!planToActivate[0]) {
    const err = new Error("Meal plan not found");
    (err as any).status = 404;
    throw err;
  }

  const targetMemberIds = planToActivate[0].memberIds ?? [];

  // Archive only active plans whose memberIds overlap with this plan's memberIds
  if (targetMemberIds.length > 0) {
    await db
      .update(mealPlans)
      .set({ status: "archived" })
      .where(
        and(
          eq(mealPlans.householdId, household.id),
          eq(mealPlans.status, "active"),
          sql`${mealPlans.memberIds} && ARRAY[${sql.join(targetMemberIds.map(id => sql`${id}`), sql`,`)}]::uuid[]`
        )
      );
  } else {
    // Fallback: archive all active plans for this household
    await db
      .update(mealPlans)
      .set({ status: "archived" })
      .where(
        and(
          eq(mealPlans.householdId, household.id),
          eq(mealPlans.status, "active")
        )
      );
  }

  const updated = await db
    .update(mealPlans)
    .set({ status: "active" })
    .where(eq(mealPlans.id, planId))
    .returning();

  if (!updated[0]) {
    const err = new Error("Meal plan not found");
    (err as any).status = 404;
    throw err;
  }

  return updated[0];
}

// ── Swap Meal ───────────────────────────────────────────────────────────────

export async function swapMeal(
  planId: string,
  itemId: string,
  b2cCustomerId: string,
  reason?: string
) {
  const planRows = await db
    .select()
    .from(mealPlans)
    .where(eq(mealPlans.id, planId))
    .limit(1);

  if (!planRows[0]) {
    const err = new Error("Meal plan not found");
    (err as any).status = 404;
    throw err;
  }

  const plan = planRows[0];

  const itemRows = await db
    .select()
    .from(mealPlanItems)
    .where(and(eq(mealPlanItems.id, itemId), eq(mealPlanItems.mealPlanId, planId)))
    .limit(1);

  if (!itemRows[0]) {
    const err = new Error("Meal plan item not found");
    (err as any).status = 404;
    throw err;
  }

  const item = itemRows[0];

  const currentPlanRecipeIds = (
    await db
      .select({ recipeId: mealPlanItems.recipeId })
      .from(mealPlanItems)
      .where(eq(mealPlanItems.mealPlanId, planId))
  ).map((r) => r.recipeId);

  const lowRatedIds = await getLowRatedRecipeIds(b2cCustomerId);
  const excludeIds = [...new Set([...currentPlanRecipeIds, ...lowRatedIds])];

  const memberIds = plan.memberIds ?? [];
  const memberProfiles: Map<string, MemberHealthProfile> =
    memberIds.length > 0 ? await getMemberHealthProfiles(memberIds) : new Map<string, MemberHealthProfile>();

  const members: MemberContext[] = [];
  for (const memberId of memberIds) {
    const customerRows = await db
      .select({ fullName: b2cCustomers.fullName, age: b2cCustomers.age })
      .from(b2cCustomers)
      .where(eq(b2cCustomers.id, memberId))
      .limit(1);
    const cust = customerRows[0];
    const profile = memberProfiles.get(memberId);
    members.push({
      name: cust?.fullName || "Member",
      age: cust?.age ?? null,
      allergens: profile?.allergens.map((a) => a.code) ?? [],
      diets: profile?.diets.map((d) => d.code) ?? [],
      conditions: profile?.conditions.map((c) => c.code) ?? [],
      calorieTarget: profile?.targetCalories ?? null,
      proteinTargetG: profile?.targetProteinG ? n(profile.targetProteinG) : null,
      carbsTargetG: profile?.targetCarbsG ? n(profile.targetCarbsG) : null,
      fatTargetG: profile?.targetFatG ? n(profile.targetFatG) : null,
    });
  }

  const alternatives = await getRecipeCandidates(b2cCustomerId, members, {
    maxCookTime: undefined,
    excludeIds,
    limit: 30,
  });

  if (alternatives.length === 0) {
    const err = new Error("No alternative recipes available");
    (err as any).status = 422;
    throw err;
  }

  const currentRecipe = await db
    .select({ title: recipes.title })
    .from(recipes)
    .where(eq(recipes.id, item.recipeId))
    .limit(1);

  let swapResult: {
    recipeId: string;
    servings: number;
    estimatedCost: number | null;
    reasoning: string;
  };
  try {
    swapResult = await suggestSwapWithLLM({
      currentRecipeId: item.recipeId,
      currentRecipeTitle: currentRecipe[0]?.title || "Unknown",
      mealDate: item.mealDate,
      mealType: item.mealType || "dinner",
      members,
      alternatives,
      swapReason: reason,
    });
  } catch (error: any) {
    swapResult = buildRuleBasedSwapFallback(alternatives, item.recipeId, String(error?.message || "LLM unavailable"));
  }

  const newNutrition = await getRecipeNutrition(swapResult.recipeId);

  const updated = await db
    .update(mealPlanItems)
    .set({
      recipeId: swapResult.recipeId,
      originalRecipeId: item.originalRecipeId ?? item.recipeId,
      swapReason: reason ?? swapResult.reasoning,
      swapCount: (item.swapCount ?? 0) + 1,
      estimatedCost: swapResult.estimatedCost ? String(swapResult.estimatedCost) : item.estimatedCost,
      caloriesPerServing: newNutrition.calories,
      nutritionSnapshot: newNutrition as any,
    })
    .where(eq(mealPlanItems.id, itemId))
    .returning();

  const hydratedItems = await hydrateItems(updated);
  return { item: hydratedItems[0], reasoning: swapResult.reasoning };
}

// ── Regenerate Plan ─────────────────────────────────────────────────────────

export async function regeneratePlan(planId: string, b2cCustomerId: string) {
  const planRows = await db
    .select()
    .from(mealPlans)
    .where(eq(mealPlans.id, planId))
    .limit(1);

  if (!planRows[0]) {
    const err = new Error("Meal plan not found");
    (err as any).status = 404;
    throw err;
  }

  const oldPlan = planRows[0];
  const genParams = (oldPlan.generationParams as any) ?? {};

  const oldRecipeIds = (
    await db
      .select({ recipeId: mealPlanItems.recipeId })
      .from(mealPlanItems)
      .where(eq(mealPlanItems.mealPlanId, planId))
  ).map((r) => r.recipeId);

  await db
    .update(mealPlans)
    .set({ status: "archived" })
    .where(eq(mealPlans.id, planId));

  const newInput: GeneratePlanInput = {
    startDate: oldPlan.startDate,
    endDate: oldPlan.endDate,
    memberIds: oldPlan.memberIds ?? [],
    budgetAmount: oldPlan.budgetAmount ? n(oldPlan.budgetAmount) : undefined,
    budgetCurrency: oldPlan.budgetCurrency ?? "USD",
    mealsPerDay: oldPlan.mealsPerDay ?? ["breakfast", "lunch", "dinner"],
    preferences: {
      maxCookTime: genParams.maxCookTime,
      cuisines: genParams.preferredCuisines,
      excludeRecipeIds: [...(genParams.excludeRecipeIds ?? []), ...oldRecipeIds],
    },
  };

  return generateMealPlan(b2cCustomerId, newInput);
}

// ── Delete Plan ─────────────────────────────────────────────────────────────

export async function deletePlan(planId: string) {
  // First check the plan exists
  const existing = await db
    .select({ id: mealPlans.id })
    .from(mealPlans)
    .where(eq(mealPlans.id, planId))
    .limit(1);

  if (!existing[0]) {
    const err = new Error("Meal plan not found");
    (err as any).status = 404;
    throw err;
  }

  // Delete child items first (FK constraint)
  await db
    .delete(mealPlanItems)
    .where(eq(mealPlanItems.mealPlanId, planId));

  // Hard-delete the plan
  await db
    .delete(mealPlans)
    .where(eq(mealPlans.id, planId));

  return { success: true };
}

// ── Log Meal from Plan ──────────────────────────────────────────────────────

export async function logMealFromPlan(
  planId: string,
  itemId: string,
  b2cCustomerId: string
) {
  const itemRows = await db
    .select()
    .from(mealPlanItems)
    .where(and(eq(mealPlanItems.id, itemId), eq(mealPlanItems.mealPlanId, planId)))
    .limit(1);

  if (!itemRows[0]) {
    const err = new Error("Meal plan item not found");
    (err as any).status = 404;
    throw err;
  }

  const item = itemRows[0];

  const result = await addMealItem(b2cCustomerId, {
    date: item.mealDate,
    mealType: (item.mealType as "breakfast" | "lunch" | "dinner" | "snack") || "dinner",
    recipeId: item.recipeId,
    servings: item.servings ?? 1,
    source: "meal_plan",
  });

  await db
    .update(mealPlanItems)
    .set({ status: "cooked" })
    .where(eq(mealPlanItems.id, itemId));

  return { mealLogItem: result.item, planItem: { ...item, status: "cooked" } };
}

// ── Add Item to Plan ────────────────────────────────────────────────────────

export async function addItemToPlan(
  planId: string,
  b2cCustomerId: string,
  input: { recipeId: string; mealDate: string; mealType: string; servings?: number; replaceItemId?: string }
) {
  const planRows = await db
    .select()
    .from(mealPlans)
    .where(eq(mealPlans.id, planId))
    .limit(1);

  if (!planRows[0]) {
    const err = new Error("Meal plan not found");
    (err as any).status = 404;
    throw err;
  }

  const plan = planRows[0];

  // If substituting, delete the old item first
  if (input.replaceItemId) {
    await db
      .delete(mealPlanItems)
      .where(
        and(
          eq(mealPlanItems.id, input.replaceItemId),
          eq(mealPlanItems.mealPlanId, planId)
        )
      );
  }

  // Verify recipe exists
  const recipeRows = await db
    .select({ id: recipes.id })
    .from(recipes)
    .where(eq(recipes.id, input.recipeId))
    .limit(1);

  if (!recipeRows[0]) {
    const err = new Error("Recipe not found");
    (err as any).status = 404;
    throw err;
  }

  const nutrition = await getRecipeNutrition(input.recipeId);
  const servings = input.servings ?? 1;

  const insertedRows = await db
    .insert(mealPlanItems)
    .values({
      mealPlanId: planId,
      recipeId: input.recipeId,
      mealDate: input.mealDate,
      mealType: input.mealType,
      servings,
      forMemberIds: plan.memberIds ?? [],
      caloriesPerServing: nutrition.calories,
      nutritionSnapshot: nutrition as any,
      status: "planned" as const,
    })
    .returning();

  const hydratedItems = await hydrateItems(insertedRows);
  return { item: hydratedItems[0] };
}

// ── Delete Item from Plan ───────────────────────────────────────────────────

export async function deleteItemFromPlan(planId: string, itemId: string) {
  const deleted = await db
    .delete(mealPlanItems)
    .where(
      and(
        eq(mealPlanItems.id, itemId),
        eq(mealPlanItems.mealPlanId, planId)
      )
    )
    .returning({ id: mealPlanItems.id });

  if (!deleted[0]) {
    const err = new Error("Meal plan item not found");
    (err as any).status = 404;
    throw err;
  }

  return { deleted: true, itemId };
}

// ── Reorder Items ───────────────────────────────────────────────────────────

export async function reorderItems(
  planId: string,
  moves: { itemId: string; mealDate: string; mealType: string }[]
) {
  const planRows = await db
    .select()
    .from(mealPlans)
    .where(eq(mealPlans.id, planId))
    .limit(1);

  if (!planRows[0]) {
    const err = new Error("Meal plan not found");
    (err as any).status = 404;
    throw err;
  }

  const updatedItems: any[] = [];

  for (const move of moves) {
    const updated = await db
      .update(mealPlanItems)
      .set({
        mealDate: move.mealDate,
        mealType: move.mealType,
      })
      .where(
        and(
          eq(mealPlanItems.id, move.itemId),
          eq(mealPlanItems.mealPlanId, planId)
        )
      )
      .returning();

    if (updated[0]) updatedItems.push(updated[0]);
  }

  const hydratedItems = await hydrateItems(updatedItems);
  return { items: hydratedItems };
}

// ── Hydrate Items with Recipe Data ──────────────────────────────────────────

async function hydrateItems(items: any[]) {
  if (items.length === 0) return [];

  const recipeIds = [...new Set(items.map((i) => i.recipeId))];
  const recipeRows = (await executeRaw(
    `SELECT id, title, image_url, meal_type, difficulty, cook_time_minutes, servings
     FROM gold.recipes WHERE id = ANY($1::uuid[])`,
    [recipeIds]
  )) as any[];

  const recipeMap = new Map<string, any>();
  for (const r of recipeRows) {
    recipeMap.set(r.id, {
      id: r.id,
      title: r.title,
      imageUrl: r.image_url,
      mealType: r.meal_type,
      difficulty: r.difficulty,
      cookTimeMinutes: r.cook_time_minutes,
      servings: r.servings,
    });
  }

  return items.map((item) => ({
    ...item,
    recipe: recipeMap.get(item.recipeId) ?? null,
  }));
}
