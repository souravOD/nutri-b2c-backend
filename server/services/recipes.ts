import { db, executeRaw } from "../config/database.js";
import { eq, and, desc } from "drizzle-orm";
import { customerProductInteractions } from "../../shared/goldSchema.js";
import { getRecipeAllergenMap, getRecipeNutritionMap } from "./recipeHydration.js";

export async function toggleSaveRecipe(b2cCustomerId: string, recipeId: string): Promise<{ saved: boolean }> {
  const existing = await db
    .select()
    .from(customerProductInteractions)
    .where(
      and(
        eq(customerProductInteractions.b2cCustomerId, b2cCustomerId),
        eq(customerProductInteractions.recipeId, recipeId),
        eq(customerProductInteractions.entityType, "recipe"),
        eq(customerProductInteractions.interactionType, "saved")
      )
    )
    .limit(1);

  if (existing.length > 0) {
    await db
      .delete(customerProductInteractions)
      .where(
        and(
          eq(customerProductInteractions.b2cCustomerId, b2cCustomerId),
          eq(customerProductInteractions.recipeId, recipeId),
          eq(customerProductInteractions.entityType, "recipe"),
          eq(customerProductInteractions.interactionType, "saved")
        )
      );
    return { saved: false };
  }

  await db.insert(customerProductInteractions).values({
    b2cCustomerId,
    recipeId,
    entityType: "recipe",
    interactionType: "saved",
    interactionTimestamp: new Date(),
    createdAt: new Date(),
  });
  return { saved: true };
}

export async function getSavedRecipes(b2cCustomerId: string, limit: number = 50, offset: number = 0) {
  const rows = await executeRaw(
    `
    select
      r.*,
      c.id as cuisine_id,
      c.code as cuisine_code,
      c.name as cuisine_name,
      cpi.interaction_timestamp as saved_at
    from gold.customer_product_interactions cpi
    join gold.recipes r on r.id = cpi.recipe_id
    left join gold.cuisines c on c.id = r.cuisine_id
    where cpi.b2c_customer_id = $1
      and cpi.entity_type = 'recipe'
      and cpi.interaction_type = 'saved'
    order by cpi.interaction_timestamp desc
    limit $2 offset $3
    `,
    [b2cCustomerId, limit, offset]
  );

  const ids = rows.map((r: any) => r.id);
  const nutritionMap = await getRecipeNutritionMap(ids);
  const allergenMap = await getRecipeAllergenMap(ids);

  return rows.map((row: any) => ({
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
      nutrition: nutritionMap.get(row.id) ?? {},
      allergens: allergenMap.get(row.id) ?? [],
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    },
    savedAt: row.saved_at,
  }));
}

export async function logRecipeHistory(params: {
  b2cCustomerId: string;
  recipeId: string;
  event: string;
}) {
  const { b2cCustomerId, recipeId, event } = params;

  const interactionType = event === "viewed" ? "viewed" : null;
  await db.insert(customerProductInteractions).values({
    b2cCustomerId,
    recipeId,
    entityType: "recipe",
    interactionType,
    interactionTimestamp: new Date(),
    metadata: { event },
    createdAt: new Date(),
  });
}

export async function getRecipeHistory(
  b2cCustomerId: string,
  event?: string,
  limit: number = 50,
  offset: number = 0
) {
  const rows = await executeRaw(
    `
    select
      cpi.*,
      r.*,
      c.id as cuisine_id,
      c.code as cuisine_code,
      c.name as cuisine_name
    from gold.customer_product_interactions cpi
    join gold.recipes r on r.id = cpi.recipe_id
    left join gold.cuisines c on c.id = r.cuisine_id
    where cpi.b2c_customer_id = $1
      and cpi.entity_type = 'recipe'
      and (
        $2::text is null
        or cpi.interaction_type = $2
        or (cpi.metadata->>'event') = $2
      )
    order by cpi.interaction_timestamp desc
    limit $3 offset $4
    `,
    [b2cCustomerId, event ?? null, limit, offset]
  );

  const ids = rows.map((r: any) => r.id);
  const nutritionMap = await getRecipeNutritionMap(ids);
  const allergenMap = await getRecipeAllergenMap(ids);

  return rows.map((row: any) => ({
    history: {
      id: row.id,
      event: row.metadata?.event ?? row.interaction_type,
      viewedAt: row.interaction_timestamp ?? row.created_at,
    },
    recipe: {
      id: row.recipe_id ?? row.id,
      title: row.title,
      description: row.description,
      imageUrl: row.image_url,
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
    },
  }));
}

export async function getRecentlyViewed(b2cCustomerId: string, limit: number = 20) {
  return getRecipeHistory(b2cCustomerId, "viewed", limit);
}

export async function getMostCooked(_b2cCustomerId: string, _limit: number = 20) {
  return [];
}

export async function getSharedRecipe(_shareSlug: string) {
  throw new Error("Shared recipes are not supported in the gold schema.");
}
