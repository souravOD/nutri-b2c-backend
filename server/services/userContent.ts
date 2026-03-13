import { db, executeRaw } from "../config/database.js";
import { eq, and, desc, ilike } from "drizzle-orm";
import {
  recipes,
  recipeIngredients,
  ingredients,
  nutritionFacts,
  recipeNutritionProfiles,
} from "../../shared/goldSchema.js";
import { resolveCuisineIds } from "./b2cTaxonomy.js";
import { getRecipeIngredients, getRecipeNutritionMap } from "./recipeHydration.js";

type AnyObj = Record<string, any>;

type IngredientInput = {
  qty?: number | string | null;
  unit?: string | null;
  item?: string | null;
  name?: string | null;
  note?: string | null;
};

function toNullableNumericString(value: number | string | null | undefined): string | null {
  if (value === "" || value == null) return null;
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return null;
  return String(numeric);
}

function normalizeRecipeInput(payload: AnyObj) {
  const cuisineRaw = payload.cuisine ?? (Array.isArray(payload.cuisines) ? payload.cuisines[0] : null);
  // Fix 1: Read nutrition from nested object first, fallback to flat keys
  const nut = (payload.nutrition && typeof payload.nutrition === "object") ? payload.nutrition : {};
  return {
    title: payload.title ?? "",
    description: payload.description ?? null,
    imageUrl: payload.image_url ?? payload.imageUrl ?? null,
    servings: payload.servings ?? null,
    prepTimeMinutes: payload.prep_time_minutes ?? payload.prepTimeMinutes ?? null,
    cookTimeMinutes: payload.cook_time_minutes ?? payload.cookTimeMinutes ?? null,
    totalTimeMinutes: payload.total_time_minutes ?? payload.totalTimeMinutes ?? null,
    mealType: payload.meal_type ?? payload.mealType ?? null,
    difficulty: payload.difficulty ?? null,
    cuisineLabel: cuisineRaw ? String(cuisineRaw) : null,
    instructions: payload.instructions ?? [],
    ingredients: Array.isArray(payload.ingredients) ? (payload.ingredients as IngredientInput[]) : [],
    // Fix 4: pass percent_calories_* through
    percent_calories_protein: payload.percent_calories_protein ?? null,
    percent_calories_fat: payload.percent_calories_fat ?? null,
    percent_calories_carbs: payload.percent_calories_carbs ?? null,
    nutrition: {
      calories: nut.calories ?? payload.calories ?? null,
      protein_g: nut.protein_g ?? payload.protein_g ?? null,
      carbs_g: nut.carbs_g ?? payload.carbs_g ?? null,
      fat_g: nut.fat_g ?? payload.fat_g ?? null,
      fiber_g: nut.fiber_g ?? payload.fiber_g ?? null,
      sugar_g: nut.sugar_g ?? payload.sugar_g ?? null,
      sodium_mg: nut.sodium_mg ?? payload.sodium_mg ?? null,
      saturated_fat_g: nut.saturated_fat_g ?? payload.saturated_fat_g ?? null,
    },
  };
}

// Fix 5: Infer source_type from ingredient name for new user-generated ingredients
function inferSourceType(name: string): string | null {
  const lower = name.toLowerCase();
  if (/\b(chicken|beef|pork|lamb|turkey|venison|bacon|ham|sausage|steak|veal)\b/.test(lower)) return "animal";
  if (/\b(salmon|tuna|cod|tilapia|trout|sardine|anchov|mackerel|halibut|bass)\b/.test(lower)) return "fish";
  if (/\b(shrimp|crab|lobster|clam|mussel|oyster|scallop|squid|prawn)\b/.test(lower)) return "shellfish";
  if (/\b(milk|cream|cheese|yogurt|butter|whey|ghee|ricotta|parmesan|mozzarella|cheddar)\b/.test(lower)) return "dairy";
  if (/\b(egg)\b/.test(lower)) return "egg";
  if (/\b(mushroom|truffle|yeast)\b/.test(lower)) return "fungal";
  // Default to plant for vegetables, fruits, grains, spices, oils
  return "plant";
}

// Fix 5+6: Case-insensitive matching + enriched creation
async function getOrCreateIngredientId(name: string) {
  // Fix 6: case-insensitive matching to avoid duplicates
  const existing = await db
    .select()
    .from(ingredients)
    .where(ilike(ingredients.name, name))
    .limit(1);
  if (existing[0]?.id) return existing[0].id;

  // Fix 5: Enrich new ingredients with metadata
  const created = await db
    .insert(ingredients)
    .values({
      name,
      category: "user_generated",
      sourceType: inferSourceType(name),
      isAllergen: false,
      isAdditive: false,
      createdAt: new Date(),
      updatedAt: new Date(),
    })
    .returning({ id: ingredients.id });
  return created[0].id;
}

async function replaceRecipeIngredients(recipeId: string, rows: IngredientInput[]) {
  await db.delete(recipeIngredients).where(eq(recipeIngredients.recipeId, recipeId));

  const cleaned = rows
    .map((r) => ({
      name: (r.item ?? r.name ?? "").toString().trim(),
      qty: r.qty,
      unit: r.unit ?? null,
      note: r.note ?? null,
    }))
    .filter((r) => r.name.length > 0);

  for (let i = 0; i < cleaned.length; i += 1) {
    const row = cleaned[i];
    const ingredientId = await getOrCreateIngredientId(row.name);
    await db.insert(recipeIngredients).values({
      recipeId,
      ingredientId,
      quantity: toNullableNumericString(row.qty),
      unit: row.unit ? String(row.unit) : null,
      preparationNote: row.note ? String(row.note) : null,
      ingredientOrder: i + 1,
      createdAt: new Date(),
    });
  }
}

async function replaceRecipeNutrition(recipeId: string, nutrition: AnyObj) {
  await executeRaw(
    `delete from gold.nutrition_facts where entity_type = 'recipe' and entity_id = $1`,
    [recipeId]
  );

  const entries: { name: string; amount: number }[] = [];
  const push = (name: string, value: any) => {
    const num = value === "" || value == null ? null : Number(value);
    if (num == null || !Number.isFinite(num)) return;
    entries.push({ name, amount: num });
  };

  push("calories/energy", nutrition.calories);
  push("protein", nutrition.protein_g);
  push("total carbohydrates", nutrition.carbs_g);
  push("total fat", nutrition.fat_g);
  push("dietary fiber", nutrition.fiber_g);
  push("total sugars", nutrition.sugar_g);
  push("sodium", nutrition.sodium_mg);
  push("saturated fat", nutrition.saturated_fat_g);

  if (!entries.length) return;

  const names = entries.map((e) => e.name);
  const defs = await executeRaw(
    `
    select id, nutrient_name as name, unit_name as unit
    from gold.nutrition_definitions
    where lower(nutrient_name) = any($1::text[])
    `,
    [names.map((n) => n.toLowerCase())]
  );

  for (const entry of entries) {
    const def = defs.find((d) => d.name.toLowerCase() === entry.name);
    if (!def?.id) continue;
    await db.insert(nutritionFacts).values({
      entityType: "recipe",
      entityId: recipeId,
      nutrientId: def.id,
      amount: String(entry.amount),
      unit: def.unit ?? "g",
      createdAt: new Date(),
      updatedAt: new Date(),
    });
  }
}

/**
 * Dual-write: also insert a flat summary row into gold.recipe_nutrition_profiles
 * for direct access and consistency with curated recipes.
 */
async function replaceRecipeNutritionProfile(
  recipeId: string,
  nutrition: AnyObj,
  servings?: number | null
) {
  // Delete existing profile for this recipe
  await db
    .delete(recipeNutritionProfiles)
    .where(eq(recipeNutritionProfiles.recipeId, recipeId));

  const toNum = (v: any): string | null => {
    if (v === "" || v == null) return null;
    const n = Number(v);
    return Number.isFinite(n) ? String(n) : null;
  };

  // Only insert if we have at least some nutrition data
  const hasData = nutrition.calories || nutrition.protein_g || nutrition.fat_g || nutrition.carbs_g;
  if (!hasData) return;

  await db.insert(recipeNutritionProfiles).values({
    recipeId,
    perBasis: "per_serving",
    servings: toNum(servings ?? 1),
    calories: toNum(nutrition.calories),
    totalFatG: toNum(nutrition.fat_g),
    saturatedFatG: toNum(nutrition.saturated_fat_g),
    sodiumMg: toNum(nutrition.sodium_mg),
    totalCarbsG: toNum(nutrition.carbs_g),
    dietaryFiberG: toNum(nutrition.fiber_g),
    totalSugarsG: toNum(nutrition.sugar_g),
    proteinG: toNum(nutrition.protein_g),
    dataSource: "user_generated",
    createdAt: new Date(),
    updatedAt: new Date(),
  });
}

export async function createUserRecipe(b2cCustomerId: string, payload: AnyObj) {
  const input = normalizeRecipeInput(payload);
  if (!input.title || input.title.trim().length < 2) {
    throw new Error("Title is required");
  }

  const cuisineIds = input.cuisineLabel ? await resolveCuisineIds([input.cuisineLabel]) : [];
  const cuisineId = cuisineIds[0] ?? null;

  const toNumStr = (v: any): string | null => {
    if (v == null) return null;
    const n = Number(v);
    return Number.isFinite(n) ? String(n) : null;
  };

  const [row] = await db
    .insert(recipes)
    .values({
      title: input.title.trim(),
      description: input.description,
      imageUrl: input.imageUrl,
      cuisineId,
      mealType: input.mealType,
      difficulty: input.difficulty,
      prepTimeMinutes: input.prepTimeMinutes ?? null,
      cookTimeMinutes: input.cookTimeMinutes ?? null,
      totalTimeMinutes: input.totalTimeMinutes ?? null,
      servings: input.servings ?? 1,
      sourceType: "user_generated",
      createdByUserId: b2cCustomerId,
      // Fix 4: Insert percent_calories_* into recipe row
      percentCaloriesProtein: toNumStr(input.percent_calories_protein),
      percentCaloriesFat: toNumStr(input.percent_calories_fat),
      percentCaloriesCarbs: toNumStr(input.percent_calories_carbs),
      createdAt: new Date(),
      updatedAt: new Date(),
      instructions: Array.isArray(input.instructions) ? input.instructions : [],
    })
    .returning();

  await replaceRecipeIngredients(row.id, input.ingredients);
  await replaceRecipeNutrition(row.id, input.nutrition);
  await replaceRecipeNutritionProfile(row.id, input.nutrition, input.servings);

  return row;
}

export async function updateUserRecipe(b2cCustomerId: string, recipeId: string, updates: AnyObj) {
  const input = normalizeRecipeInput(updates);
  const cuisineIds = input.cuisineLabel ? await resolveCuisineIds([input.cuisineLabel]) : [];
  const cuisineId = cuisineIds[0] ?? null;

  const updated = await db
    .update(recipes)
    .set({
      title: input.title ? input.title.trim() : undefined,
      description: input.description,
      imageUrl: input.imageUrl,
      cuisineId,
      mealType: input.mealType,
      difficulty: input.difficulty,
      prepTimeMinutes: input.prepTimeMinutes ?? undefined,
      cookTimeMinutes: input.cookTimeMinutes ?? undefined,
      totalTimeMinutes: input.totalTimeMinutes ?? undefined,
      servings: input.servings ?? undefined,
      updatedAt: new Date(),
      instructions: Array.isArray(input.instructions) ? input.instructions : undefined,
    })
    .where(and(eq(recipes.id, recipeId), eq(recipes.createdByUserId, b2cCustomerId)))
    .returning();

  if (!updated.length) {
    throw new Error("Recipe not found or access denied");
  }

  if (updates.ingredients) {
    await replaceRecipeIngredients(recipeId, input.ingredients);
  }
  if (updates.calories !== undefined || updates.protein_g !== undefined) {
    await replaceRecipeNutrition(recipeId, input.nutrition);
    await replaceRecipeNutritionProfile(recipeId, input.nutrition, input.servings);
  }

  return updated[0];
}

export async function getUserRecipes(b2cCustomerId: string, limit: number = 50, offset: number = 0) {
  const rows = await db
    .select()
    .from(recipes)
    .where(and(eq(recipes.createdByUserId, b2cCustomerId), eq(recipes.sourceType, "user_generated")))
    .orderBy(desc(recipes.updatedAt))
    .limit(limit)
    .offset(offset);

  return rows;
}

export async function getUserRecipe(b2cCustomerId: string, recipeId: string) {
  const rows = await db
    .select()
    .from(recipes)
    .where(and(eq(recipes.id, recipeId), eq(recipes.createdByUserId, b2cCustomerId)))
    .limit(1);
  if (!rows.length) throw new Error("Recipe not found or access denied");

  const [nutritionMap] = await Promise.all([getRecipeNutritionMap([recipeId])]);
  const ingredients = await getRecipeIngredients(recipeId);

  return {
    ...rows[0],
    ingredients,
    nutrition: nutritionMap.get(recipeId) ?? {},
  };
}

export async function deleteUserRecipe(b2cCustomerId: string, recipeId: string) {
  await db.delete(recipes).where(and(eq(recipes.id, recipeId), eq(recipes.createdByUserId, b2cCustomerId)));
  await executeRaw(`delete from gold.recipe_ingredients where recipe_id = $1`, [recipeId]);
  await executeRaw(`delete from gold.nutrition_facts where entity_type = 'recipe' and entity_id = $1`, [recipeId]);
}

export async function shareUserRecipe(_userId: string, recipeId: string) {
  return { shareUrl: `/recipes/${recipeId}` };
}

export async function unshareUserRecipe(_userId: string, recipeId: string) {
  return { recipeId };
}

export async function submitForReview(_userId: string, recipeId: string) {
  return { recipeId, status: "pending" };
}

export async function approveUserRecipe(_adminUserId: string, _userRecipeId: string, _reviewNotes?: string) {
  throw new Error("Recipe moderation is not supported in the gold schema.");
}

export async function rejectUserRecipe(_adminUserId: string, _userRecipeId: string, _reviewNotes: string) {
  throw new Error("Recipe moderation is not supported in the gold schema.");
}
