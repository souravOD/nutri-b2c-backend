import { executeRaw } from "../config/database.js";

type Nutrition = {
  calories?: number | null;
  protein_g?: number | null;
  carbs_g?: number | null;
  fat_g?: number | null;
  fiber_g?: number | null;
  sugar_g?: number | null;
  sodium_mg?: number | null;
  saturated_fat_g?: number | null;
};

export type RecipeIngredientRow = {
  name: string;
  quantity: number | null;
  unit: string | null;
  preparation_note: string | null;
  ingredient_order: number | null;
};

const NAME = {
  calories: [
    "calories/energy",
    "calories",
    "energy",
    "energy (kcal)",
  ],
  protein: ["protein"],
  carbs: ["total carbohydrates", "carbohydrate", "carbohydrates"],
  fat: ["total fat", "fat"],
  fiber: ["dietary fiber", "fiber"],
  sugar: ["total sugars", "sugars", "sugar"],
  sodium: ["sodium"],
  satfat: ["saturated fat"],
};

export async function getRecipeNutritionMap(recipeIds: string[]) {
  if (!recipeIds.length) return new Map<string, Nutrition>();
  const rows = await executeRaw(
    `
    select
      nf.entity_id as recipe_id,
      max(case when lower(nd.nutrient_name) = any($2::text[]) then nf.amount end) as calories,
      max(case when lower(nd.nutrient_name) = any($3::text[]) then nf.amount end) as protein_g,
      max(case when lower(nd.nutrient_name) = any($4::text[]) then nf.amount end) as carbs_g,
      max(case when lower(nd.nutrient_name) = any($5::text[]) then nf.amount end) as fat_g,
      max(case when lower(nd.nutrient_name) = any($6::text[]) then nf.amount end) as fiber_g,
      max(case when lower(nd.nutrient_name) = any($7::text[]) then nf.amount end) as sugar_g,
      max(case when lower(nd.nutrient_name) = any($8::text[]) then nf.amount end) as sodium_mg,
      max(case when lower(nd.nutrient_name) = any($9::text[]) then nf.amount end) as saturated_fat_g
    from gold.nutrition_facts nf
    join gold.nutrition_definitions nd on nd.id = nf.nutrient_id
    where nf.entity_type = 'recipe'
      and nf.entity_id = any($1::uuid[])
    group by nf.entity_id
    `,
    [
      recipeIds,
      NAME.calories,
      NAME.protein,
      NAME.carbs,
      NAME.fat,
      NAME.fiber,
      NAME.sugar,
      NAME.sodium,
      NAME.satfat,
    ]
  );

  const map = new Map<string, Nutrition>();
  for (const row of rows as any[]) {
    map.set(row.recipe_id, {
      calories: row.calories ?? null,
      protein_g: row.protein_g ?? null,
      carbs_g: row.carbs_g ?? null,
      fat_g: row.fat_g ?? null,
      fiber_g: row.fiber_g ?? null,
      sugar_g: row.sugar_g ?? null,
      sodium_mg: row.sodium_mg ?? null,
      saturated_fat_g: row.saturated_fat_g ?? null,
    });
  }
  return map;
}

export async function getRecipeAllergenMap(recipeIds: string[]) {
  if (!recipeIds.length) return new Map<string, string[]>();
  const rows = await executeRaw(
    `
    select
      ri.recipe_id,
      array_remove(array_agg(distinct a.code), null) as allergens
    from gold.recipe_ingredients ri
    join gold.ingredient_allergens ia on ia.ingredient_id = ri.ingredient_id
    join gold.allergens a on a.id = ia.allergen_id
    where ri.recipe_id = any($1::uuid[])
    group by ri.recipe_id
    `,
    [recipeIds]
  );
  const map = new Map<string, string[]>();
  for (const row of rows as any[]) {
    map.set(row.recipe_id, row.allergens ?? []);
  }
  return map;
}

export async function getRecipeIngredients(recipeId: string) {
  const rows = await executeRaw(
    `
    select
      i.name,
      ri.quantity,
      ri.unit,
      ri.preparation_note,
      ri.ingredient_order
    from gold.recipe_ingredients ri
    join gold.ingredients i on i.id = ri.ingredient_id
    where ri.recipe_id = $1
    order by ri.ingredient_order asc nulls last, i.name asc
    `,
    [recipeId]
  );
  return rows as RecipeIngredientRow[];
}
