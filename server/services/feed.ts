import { executeRaw } from "../config/database.js";
import { getRecipeAllergenMap, getRecipeNutritionMap } from "./recipeHydration.js";

export interface FeedResult {
  recipe: any;
  score: number;
  reasons: string[];
}

type UserPrefs = {
  dietIds: string[];
  allergenIds: string[];
  conditionIds: string[];
  dislikes: string[];
};

async function getUserPrefs(b2cCustomerId: string): Promise<UserPrefs> {
  const rows = await executeRaw(
    `
    select
      coalesce(array_remove(array_agg(distinct cdp.diet_id), null), '{}'::uuid[]) as diet_ids,
      coalesce(array_remove(array_agg(distinct ca.allergen_id), null), '{}'::uuid[]) as allergen_ids,
      coalesce(array_remove(array_agg(distinct chc.condition_id), null), '{}'::uuid[]) as condition_ids,
      coalesce(hp.disliked_ingredients, '{}'::text[]) as dislikes
    from gold.b2c_customers c
    left join gold.b2c_customer_dietary_preferences cdp
      on c.id = cdp.b2c_customer_id and cdp.is_active = true
    left join gold.b2c_customer_allergens ca
      on c.id = ca.b2c_customer_id and ca.is_active = true
    left join gold.b2c_customer_health_conditions chc
      on c.id = chc.b2c_customer_id and chc.is_active = true
    left join gold.b2c_customer_health_profiles hp
      on c.id = hp.b2c_customer_id
    where c.id = $1
    group by c.id, hp.disliked_ingredients
    `,
    [b2cCustomerId]
  );

  if (!rows.length) {
    return { dietIds: [], allergenIds: [], conditionIds: [], dislikes: [] };
  }

  const row = rows[0] as any;
  return {
    dietIds: row.diet_ids ?? [],
    allergenIds: row.allergen_ids ?? [],
    conditionIds: row.condition_ids ?? [],
    dislikes: row.dislikes ?? [],
  };
}

function mapFeedRecipe(row: any, nutritionMap: Map<string, any>, allergenMap: Map<string, any>) {
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
    createdByUserId: row.created_by_user_id,
  };
}

export async function getPersonalizedFeed(
  b2cCustomerId: string,
  limit: number = 200,
  offset: number = 0
): Promise<FeedResult[]> {
  try {
    const prefs = await getUserPrefs(b2cCustomerId);
    const dislikes = prefs.dislikes.map((d) => d.toLowerCase());

    const rows = await executeRaw(
      `
      select
        r.*,
        c.id as cuisine_id,
        c.code as cuisine_code,
        c.name as cuisine_name,
        coalesce(p.saved_30d, 0) as saved_30d
      from gold.recipes r
      left join gold.cuisines c on c.id = r.cuisine_id
      left join lateral (
        select count(*)::int as saved_30d
        from gold.customer_product_interactions cpi
        where cpi.recipe_id = r.id
          and cpi.entity_type = 'recipe'
          and cpi.interaction_type = 'saved'
          and cpi.interaction_timestamp > now() - interval '30 days'
      ) p on true
      where (coalesce(cardinality($1::uuid[]),0)=0 or not exists (
        select 1
        from gold.recipe_ingredients ri
        join gold.diet_ingredient_rules dir on dir.ingredient_id = ri.ingredient_id
        where ri.recipe_id = r.id
          and dir.diet_id = any($1)
          and dir.rule_type = 'forbidden'
      ))
      and (coalesce(cardinality($2::uuid[]),0)=0 or not exists (
        select 1
        from gold.recipe_ingredients ri
        join gold.ingredient_allergens ia on ia.ingredient_id = ri.ingredient_id
        where ri.recipe_id = r.id
          and ia.allergen_id = any($2)
      ))
      and (coalesce(cardinality($3::uuid[]),0)=0 or not exists (
        select 1
        from gold.recipe_ingredients ri
        join gold.health_condition_ingredient_restrictions hcir on hcir.ingredient_id = ri.ingredient_id
        where ri.recipe_id = r.id
          and hcir.condition_id = any($3)
          and hcir.restriction_type = 'forbidden'
      ))
      and (coalesce(cardinality($4::text[]),0)=0 or not exists (
        select 1
        from gold.recipe_ingredients ri
        join gold.ingredients i on i.id = ri.ingredient_id
        where ri.recipe_id = r.id
          and lower(i.name) = any($4)
      ))
      and not exists (
        select 1
        from gold.customer_product_interactions cpi
        where cpi.recipe_id = r.id
          and cpi.entity_type = 'recipe'
          and (cpi.interaction_type = 'viewed' or cpi.metadata->>'event' = 'viewed')
          and cpi.interaction_timestamp > now() - interval '48 hours'
          and cpi.b2c_customer_id = $5
      )
      order by saved_30d desc nulls last, r.updated_at desc, r.id asc
      limit $6 offset $7
      `,
      [
        prefs.dietIds,
        prefs.allergenIds,
        prefs.conditionIds,
        dislikes,
        b2cCustomerId,
        limit,
        offset,
      ]
    );

    const ids = rows.map((r: any) => r.id);
    const nutritionMap = await getRecipeNutritionMap(ids);
    const allergenMap = await getRecipeAllergenMap(ids);

    return rows.map((row: any) => {
      const updatedAt = row.updated_at ? new Date(row.updated_at).getTime() : Date.now();
      const daysOld = Math.max(0, (Date.now() - updatedAt) / 86400000);
      const score = Number(row.saved_30d ?? 0) + 1 / (1 + daysOld);
      return {
        recipe: mapFeedRecipe(row, nutritionMap, allergenMap),
        score,
        reasons: [],
      };
    });
  } catch (error) {
    console.error("Personalized feed error:", error);
    throw new Error("Failed to generate personalized feed");
  }
}

export async function getFeedRecommendations(b2cCustomerId: string): Promise<{
  trending: any[];
  forYou: FeedResult[];
  recent: any[];
}> {
  try {
    const trendingRows = await executeRaw(
      `
      select
        r.*,
        c.id as cuisine_id,
        c.code as cuisine_code,
        c.name as cuisine_name,
        coalesce(p.saved_7d, 0) as saved_7d
      from gold.recipes r
      left join gold.cuisines c on c.id = r.cuisine_id
      left join lateral (
        select count(*)::int as saved_7d
        from gold.customer_product_interactions cpi
        where cpi.recipe_id = r.id
          and cpi.entity_type = 'recipe'
          and cpi.interaction_type = 'saved'
          and cpi.interaction_timestamp > now() - interval '7 days'
      ) p on true
      order by saved_7d desc nulls last, r.updated_at desc
      limit 10
      `
    );

    const recentRows = await executeRaw(
      `
      select
        r.*,
        c.id as cuisine_id,
        c.code as cuisine_code,
        c.name as cuisine_name
      from gold.recipes r
      left join gold.cuisines c on c.id = r.cuisine_id
      order by r.updated_at desc nulls last
      limit 10
      `
    );

    const ids = [...trendingRows, ...recentRows].map((r: any) => r.id);
    const nutritionMap = await getRecipeNutritionMap(ids);
    const allergenMap = await getRecipeAllergenMap(ids);

    const trending = trendingRows.map((row: any) => mapFeedRecipe(row, nutritionMap, allergenMap));
    const recent = recentRows.map((row: any) => mapFeedRecipe(row, nutritionMap, allergenMap));
    const forYou = await getPersonalizedFeed(b2cCustomerId, 20);

    return {
      trending,
      forYou,
      recent,
    };
  } catch (error) {
    console.error("Feed recommendations error:", error);
    throw new Error("Failed to get feed recommendations");
  }
}
