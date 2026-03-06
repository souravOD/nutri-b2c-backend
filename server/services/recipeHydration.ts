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

  // Use a ranked CTE to prefer per_serving values over per_100g / other bases.
  // For each (recipe, nutrient), pick the row whose per_amount is closest to
  // "per_serving", falling back to others if per_serving is absent.
  const rows = await executeRaw(
    `
    WITH ranked AS (
      SELECT
        nf.entity_id,
        nf.nutrient_id,
        nf.amount,
        nd.nutrient_name,
        ROW_NUMBER() OVER (
          PARTITION BY nf.entity_id, nf.nutrient_id
          ORDER BY CASE lower(nf.per_amount)
            WHEN 'per_serving'  THEN 1
            WHEN 'per serving'  THEN 1
            WHEN '1 serving'    THEN 1
            WHEN '100g'         THEN 2
            ELSE 3
          END
        ) AS rn
      FROM gold.nutrition_facts nf
      JOIN gold.nutrition_definitions nd ON nd.id = nf.nutrient_id
      WHERE nf.entity_type = 'recipe'
        AND nf.entity_id = ANY($1::uuid[])
    )
    SELECT
      entity_id AS recipe_id,
      max(CASE WHEN lower(nutrient_name) = ANY($2::text[]) THEN amount END) AS calories,
      max(CASE WHEN lower(nutrient_name) = ANY($3::text[]) THEN amount END) AS protein_g,
      max(CASE WHEN lower(nutrient_name) = ANY($4::text[]) THEN amount END) AS carbs_g,
      max(CASE WHEN lower(nutrient_name) = ANY($5::text[]) THEN amount END) AS fat_g,
      max(CASE WHEN lower(nutrient_name) = ANY($6::text[]) THEN amount END) AS fiber_g,
      max(CASE WHEN lower(nutrient_name) = ANY($7::text[]) THEN amount END) AS sugar_g,
      max(CASE WHEN lower(nutrient_name) = ANY($8::text[]) THEN amount END) AS sodium_mg,
      max(CASE WHEN lower(nutrient_name) = ANY($9::text[]) THEN amount END) AS saturated_fat_g
    FROM ranked
    WHERE rn = 1
    GROUP BY entity_id
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

  // Fallback: for any recipes not found in nutrition_facts,
  // try recipe_nutrition_profiles table (prefer per_serving rows)
  const missingIds = recipeIds.filter((id) => !map.has(id));
  if (missingIds.length > 0) {
    const fallbackRows = await executeRaw(
      `
      SELECT DISTINCT ON (recipe_id)
        recipe_id,
        calories,
        protein_g,
        total_carbs_g  AS carbs_g,
        total_fat_g    AS fat_g,
        dietary_fiber_g AS fiber_g,
        total_sugars_g AS sugar_g,
        sodium_mg,
        saturated_fat_g
      FROM gold.recipe_nutrition_profiles
      WHERE recipe_id = ANY($1::uuid[])
      ORDER BY recipe_id,
               CASE per_basis WHEN 'per_serving' THEN 1 ELSE 2 END
      `,
      [missingIds]
    );
    for (const row of fallbackRows as any[]) {
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
      coalesce(i.name, 'Unknown ingredient') as name,
      ri.quantity,
      ri.unit,
      ri.preparation_note,
      ri.ingredient_order
    from gold.recipe_ingredients ri
    left join gold.ingredients i on i.id = ri.ingredient_id
    where ri.recipe_id = $1
    order by ri.ingredient_order asc nulls last, i.name asc
    `,
    [recipeId]
  );
  return rows as unknown as RecipeIngredientRow[];
}

export async function hydrateRecipesByIds(ids: string[]) {
  if (!ids.length) return [];

  const rows = await executeRaw(
    `
    SELECT r.*, c.id AS cuisine_id, c.code AS cuisine_code, c.name AS cuisine_name
    FROM gold.recipes r
    LEFT JOIN gold.cuisines c ON c.id = r.cuisine_id
    WHERE r.id = ANY($1::uuid[])
    `,
    [ids]
  );

  // Preserve RAG ranking order
  const map = new Map((rows as any[]).map((r: any) => [r.id, r]));
  const nutritionMap = await getRecipeNutritionMap(ids);
  const allergenMap = await getRecipeAllergenMap(ids);

  return ids
    .map(id => {
      const row = map.get(id);
      if (!row) return null;
      return {
        id: row.id,
        title: row.title,
        description: row.description,
        imageUrl: row.image_url,
        sourceUrl: row.source_url,
        cuisine: row.cuisine_id
          ? { id: row.cuisine_id, code: row.cuisine_code, name: row.cuisine_name }
          : null,
        mealType: row.meal_type,
        difficulty: row.difficulty,
        prepTimeMinutes: row.prep_time_minutes,
        cookTimeMinutes: row.cook_time_minutes,
        totalTimeMinutes: row.total_time_minutes,
        servings: row.servings,
        nutrition: nutritionMap.get(row.id) ?? {},
        allergens: allergenMap.get(row.id) ?? [],
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      };
    })
    .filter(Boolean);
}
