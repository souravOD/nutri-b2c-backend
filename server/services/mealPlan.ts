import { db, executeRaw } from "../config/database.js";
import { eq, and, desc } from "drizzle-orm";
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

// ── Fetch Recipe Catalog ────────────────────────────────────────────────────

async function fetchRecipeCatalog(params: {
  cuisineIds?: string[];
  maxCookTime?: number;
  excludeIds: string[];
  limit: number;
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

  return rows.map((r) => ({
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
}

// ── Get Nutrition for Recipe ────────────────────────────────────────────────

async function getRecipeNutrition(recipeId: string): Promise<NutritionSnapshot> {
  const rows = await db
    .select()
    .from(recipeNutritionProfiles)
    .where(eq(recipeNutritionProfiles.recipeId, recipeId))
    .limit(1);

  const r = rows[0];
  if (!r) return { calories: 0, proteinG: 0, carbsG: 0, fatG: 0, fiberG: 0, sugarG: 0, sodiumMg: 0 };

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

  const maxRecipes = parseInt(process.env.MEAL_PLAN_MAX_RECIPES || "150", 10);
  const preferredCuisines = input.preferences?.cuisines ?? [];
  const cuisineIds = preferredCuisines.length > 0
    ? await resolveCuisineIds(preferredCuisines)
    : [];

  let recipeCatalog = await fetchRecipeCatalog({
    cuisineIds,
    maxCookTime: input.preferences?.maxCookTime,
    excludeIds: allExcluded,
    limit: maxRecipes,
  });
  let cuisineFallbackApplied = preferredCuisines.length > 0 && cuisineIds.length === 0;

  // Soft preference mode: if preferred cuisines produce no matches, fall back.
  if (preferredCuisines.length > 0 && recipeCatalog.length === 0) {
    recipeCatalog = await fetchRecipeCatalog({
      maxCookTime: input.preferences?.maxCookTime,
      excludeIds: allExcluded,
      limit: maxRecipes,
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

  const nutritionSnapshots = new Map<string, NutritionSnapshot>();
  const uniqueRecipeIds = [...new Set(validatedMeals.map((m) => m.recipeId))];
  for (const rid of uniqueRecipeIds) {
    nutritionSnapshots.set(rid, await getRecipeNutrition(rid));
  }

  const planRows = await db
    .insert(mealPlans)
    .values({
      householdId: household.id,
      planName: `Meal Plan ${input.startDate} to ${input.endDate}`,
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

  const itemValues = validatedMeals.map((meal) => {
    const nutrition = nutritionSnapshots.get(meal.recipeId)!;
    const cost = meal.estimatedCost ?? null;
    if (cost) totalCost += cost;
    totalCalories += nutrition.calories * (meal.servings || 1);

    return {
      mealPlanId: plan.id,
      recipeId: meal.recipeId,
      mealDate: meal.date,
      mealType: meal.mealType,
      servings: meal.servings || 1,
      forMemberIds: input.memberIds,
      estimatedCost: cost ? String(cost) : null,
      caloriesPerServing: nutrition.calories,
      status: "planned" as const,
      nutritionSnapshot: nutrition as any,
    };
  });

  const insertedItems = await db.insert(mealPlanItems).values(itemValues).returning();

  await db
    .update(mealPlans)
    .set({
      totalEstimatedCost: totalCost > 0 ? String(totalCost) : null,
      totalCalories,
    })
    .where(eq(mealPlans.id, plan.id));

  const hydratedItems = await hydrateItems(insertedItems);

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
}

// ── List Plans ──────────────────────────────────────────────────────────────

export async function listPlans(
  b2cCustomerId: string,
  status?: string,
  limit = 20,
  offset = 0
) {
  const household = await getOrCreateHousehold(b2cCustomerId);

  let conditions = [eq(mealPlans.householdId, household.id)];
  if (status) {
    conditions.push(eq(mealPlans.status, status));
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

  const hydratedItems = await hydrateItems(items);

  return { plan: planRows[0], items: hydratedItems };
}

// ── Activate Plan ───────────────────────────────────────────────────────────

export async function activatePlan(planId: string, b2cCustomerId: string) {
  const household = await getOrCreateHousehold(b2cCustomerId);

  await db
    .update(mealPlans)
    .set({ status: "archived" })
    .where(
      and(
        eq(mealPlans.householdId, household.id),
        eq(mealPlans.status, "active")
      )
    );

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

  const alternatives = await fetchRecipeCatalog({
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

// ── Delete (Archive) Plan ───────────────────────────────────────────────────

export async function deletePlan(planId: string) {
  const updated = await db
    .update(mealPlans)
    .set({ status: "archived" })
    .where(eq(mealPlans.id, planId))
    .returning();

  if (!updated[0]) {
    const err = new Error("Meal plan not found");
    (err as any).status = 404;
    throw err;
  }

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
