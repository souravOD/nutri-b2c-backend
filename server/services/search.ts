import { db, executeRaw } from "../config/database.js";
import { recipes } from "../../shared/goldSchema.js";
import { eq, and } from "drizzle-orm";
import {
  resolveDietIds,
  resolveAllergenIds,
  resolveConditionIds,
  resolveCuisineIds,
} from "./b2cTaxonomy.js";
import { getRecipeAllergenMap, getRecipeNutritionMap, getRecipeIngredients } from "./recipeHydration.js";

export interface SearchParams {
  q?: string;
  diets?: string[];
  cuisines?: string[];
  allergensExclude?: string[];
  majorConditions?: string[];
  calMin?: number;
  calMax?: number;
  proteinMin?: number;
  sugarMax?: number;
  sodiumMax?: number;
  fiberMin?: number;
  satfatMax?: number;
  timeMax?: number;
  difficulty?: string;
  mealType?: string;
  limit?: number;
  offset?: number;
}

export interface SearchResult {
  recipe: any;
  score: number;
  reasons: string[];
}

export async function searchRecipes(params: SearchParams): Promise<SearchResult[]> {
  const {
    q,
    diets = [],
    cuisines = [],
    allergensExclude = [],
    majorConditions = [],
    calMin,
    calMax,
    proteinMin,
    sugarMax,
    sodiumMax,
    fiberMin,
    satfatMax,
    timeMax,
    difficulty,
    mealType,
    limit = 50,
    offset = 0,
  } = params;

  try {
    const dietIds = await resolveDietIds(diets);
    const allergenIds = await resolveAllergenIds(allergensExclude);
    const conditionIds = await resolveConditionIds(majorConditions);
    const cuisineIds = await resolveCuisineIds(cuisines);

    const rows = await executeRaw(
      `
      with candidates as (
        select
          r.*,
          c.id as cuisine_id,
          c.code as cuisine_code,
          c.name as cuisine_name
        from gold.recipes r
        left join gold.cuisines c on c.id = r.cuisine_id
        where ($1::text is null or r.title ilike '%' || $1 || '%' or r.description ilike '%' || $1 || '%')
          and (coalesce(cardinality($2::uuid[]),0)=0 or r.cuisine_id = any($2))
          and (coalesce(cardinality($3::uuid[]),0)=0 or not exists (
            select 1
            from gold.recipe_ingredients ri
            join gold.diet_ingredient_rules dir on dir.ingredient_id = ri.ingredient_id
            where ri.recipe_id = r.id
              and dir.diet_id = any($3)
              and dir.rule_type = 'forbidden'
          ))
          and (coalesce(cardinality($4::uuid[]),0)=0 or not exists (
            select 1
            from gold.recipe_ingredients ri
            join gold.ingredient_allergens ia on ia.ingredient_id = ri.ingredient_id
            where ri.recipe_id = r.id
              and ia.allergen_id = any($4)
          ))
          and (coalesce(cardinality($5::uuid[]),0)=0 or not exists (
            select 1
            from gold.recipe_ingredients ri
            join gold.health_condition_ingredient_restrictions hcir on hcir.ingredient_id = ri.ingredient_id
            where ri.recipe_id = r.id
              and hcir.condition_id = any($5)
              and hcir.restriction_type = 'forbidden'
          ))
      )
      select
        c.*,
        nf.calories,
        nf.protein_g,
        nf.carbs_g,
        nf.fat_g,
        nf.fiber_g,
        nf.sugar_g,
        nf.sodium_mg,
        nf.saturated_fat_g
      from candidates c
      left join lateral (
        select
          max(case when lower(nd.nutrient_name) = any($10::text[]) then nf.amount end) as calories,
          max(case when lower(nd.nutrient_name) = any($11::text[]) then nf.amount end) as protein_g,
          max(case when lower(nd.nutrient_name) = any($12::text[]) then nf.amount end) as carbs_g,
          max(case when lower(nd.nutrient_name) = any($13::text[]) then nf.amount end) as fat_g,
          max(case when lower(nd.nutrient_name) = any($14::text[]) then nf.amount end) as fiber_g,
          max(case when lower(nd.nutrient_name) = any($15::text[]) then nf.amount end) as sugar_g,
          max(case when lower(nd.nutrient_name) = any($16::text[]) then nf.amount end) as sodium_mg,
          max(case when lower(nd.nutrient_name) = any($17::text[]) then nf.amount end) as saturated_fat_g
        from gold.nutrition_facts nf
        join gold.nutrition_definitions nd on nd.id = nf.nutrient_id
        where nf.entity_type = 'recipe'
          and nf.entity_id = c.id
      ) nf on true
      where ($6::int is null or coalesce(c.total_time_minutes, c.prep_time_minutes + c.cook_time_minutes, 0) <= $6)
        and ($7::numeric is null or nf.calories >= $7)
        and ($8::numeric is null or nf.calories <= $8)
        and ($9::numeric is null or nf.protein_g >= $9)
        and ($18::numeric is null or nf.sugar_g <= $18)
        and ($19::numeric is null or nf.sodium_mg <= $19)
        and ($20::numeric is null or nf.fiber_g >= $20)
        and ($21::numeric is null or nf.saturated_fat_g <= $21)
        and ($22::text is null or c.difficulty = $22)
        and ($23::text is null or c.meal_type = $23)
      order by c.updated_at desc nulls last, c.id asc
      limit $24 offset $25
      `,
      [
        q || null,
        cuisineIds.length ? cuisineIds : [],
        dietIds.length ? dietIds : [],
        allergenIds.length ? allergenIds : [],
        conditionIds.length ? conditionIds : [],
        timeMax ?? null,
        calMin ?? null,
        calMax ?? null,
        proteinMin ?? null,
        ["calories/energy", "calories", "energy", "energy (kcal)"],
        ["protein"],
        ["total carbohydrates", "carbohydrate", "carbohydrates"],
        ["total fat", "fat"],
        ["dietary fiber", "fiber"],
        ["total sugars", "sugars", "sugar"],
        ["sodium"],
        ["saturated fat"],
        sugarMax ?? null,
        sodiumMax ?? null,
        fiberMin ?? null,
        satfatMax ?? null,
        difficulty ?? null,
        mealType ?? null,
        limit,
        offset,
      ]
    );

    const ids = rows.map((r: any) => r.id);
    const allergenMap = await getRecipeAllergenMap(ids);

    return rows.map((row: any) => {
      const createdAt = row.created_at ?? null;
      const score = createdAt ? 1 / (1 + Math.max(0, (Date.now() - new Date(createdAt).getTime()) / 86400000)) : 0;
      return {
        recipe: {
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
          nutrition: {
            calories: row.calories ?? null,
            protein_g: row.protein_g ?? null,
            carbs_g: row.carbs_g ?? null,
            fat_g: row.fat_g ?? null,
            fiber_g: row.fiber_g ?? null,
            sugar_g: row.sugar_g ?? null,
            sodium_mg: row.sodium_mg ?? null,
            saturated_fat_g: row.saturated_fat_g ?? null,
          },
          allergens: allergenMap.get(row.id) ?? [],
          createdAt: row.created_at,
          updatedAt: row.updated_at,
          createdByUserId: row.created_by_user_id,
        },
        score,
        reasons: [],
      };
    });
  } catch (error) {
    console.error("Search error:", error);
    throw new Error("Recipe search failed");
  }
}

export async function getRecipeDetail(id: string): Promise<any> {
  const rows = await executeRaw(
    `
    select
      r.*,
      c.id as cuisine_id,
      c.code as cuisine_code,
      c.name as cuisine_name
    from gold.recipes r
    left join gold.cuisines c on c.id = r.cuisine_id
    where r.id = $1
    limit 1
    `,
    [id]
  );

  if (!rows.length) {
    throw new Error("Recipe not found");
  }

  const row = rows[0] as any;
  const nutritionMap = await getRecipeNutritionMap([id]);
  const allergenMap = await getRecipeAllergenMap([id]);
  const ingredients = await getRecipeIngredients(id);

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
    instructions: Array.isArray(row.instructions) ? row.instructions : [],
    ingredients,
    nutrition: nutritionMap.get(id) ?? {},
    allergens: allergenMap.get(id) ?? [],
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    createdByUserId: row.created_by_user_id,
  };
}

export async function getPopularRecipes(limit: number = 20): Promise<any[]> {
  try {
    const results = await executeRaw(
      `
      select r.*
      from gold.recipes r
      left join lateral (
        select count(*)::int as saved_30d
        from gold.customer_product_interactions cpi
        where cpi.recipe_id = r.id
          and cpi.entity_type = 'recipe'
          and cpi.interaction_type = 'saved'
          and cpi.interaction_timestamp > now() - interval '30 days'
      ) p on true
      order by p.saved_30d desc nulls last, r.updated_at desc
      limit $1
      `,
      [limit]
    );
    return results;
  } catch (error) {
    console.error("Popular recipes error:", error);
    throw new Error("Failed to fetch popular recipes");
  }
}
