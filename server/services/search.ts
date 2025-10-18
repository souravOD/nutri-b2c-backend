import { db, executeRaw } from "../config/database.js";
import { recipes } from "../../shared/schema.js";
import { eq, and, sql } from "drizzle-orm";

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
    const results = await executeRaw(
      `
      with prefs as (
        select
          coalesce($1::text[], '{}')  as diets,
          coalesce($2::text[], '{}')  as allergens,
          coalesce($3::text[], '{}')  as cuisines,
          coalesce($4::text[], '{}')  as conditions
      ),
      candidates as (
        select r.*
        from recipes r, prefs p
        where r.status = 'published'
          and r.market_country = 'US'
          and recipe_is_safe_for_profile(r, (select diets from prefs), (select allergens from prefs), '{}'::text[], (select conditions from prefs))
          and (coalesce(cardinality($19::text[]),0)=0 or r.diet_tags  @> $19::text[]) -- AND logic for diets
          and (coalesce(cardinality($20::text[]),0)=0 or NOT (r.allergens && $20::text[]))     -- Exclude recipes with any selected allergen
          and (coalesce(cardinality($21::text[]),0)=0 or r.major_conditions @> $21::text[])    -- AND logic for conditions
          and ($5::text is null
               or r.tsv @@ plainto_tsquery('english', $5)
               or r.title ilike '%'||$5||'%')
          and ($6::int is null or r.total_time_minutes <= $6)
          and ($7::int is null or r.calories >= $7)
          and ($8::int is null or r.calories <= $8)
          and ($9::numeric is null or r.protein_g >= $9)
          and ($10::numeric is null or r.sugar_g <= $10)
          and ($11::int is null or r.sodium_mg <= $11)
          and ($12::numeric is null or r.fiber_g >= $12)
          and ($13::numeric is null or r.saturated_fat_g <= $13)
          and ($14::text is null or r.difficulty = $14)
          and ($15::text is null or r.meal_type = $15)
          and (coalesce(cardinality($16::text[]),0)=0 or r.cuisines && $16::text[])
      )
      select
        to_jsonb(c.*) as recipe,
        (
          0.45 * coalesce(ts_rank_cd(c.tsv, plainto_tsquery('english', $5)), 0) +
          0.25 * public.diet_match_score(c.diet_tags, (select diets from prefs)) +
          0.10 * public.cuisine_preference_score(c.cuisines, (select cuisines from prefs)) +
          0.10 * public.recency_score(c.updated_at) +
          0.10 * public.popularity_score(p.cooked_30d)
        ) as score,
        public.build_reasons_array(c, (select diets from prefs), (select cuisines from prefs), $5)
          || public.build_health_reasons(c, (select allergens from prefs), (select conditions from prefs))
          as reasons
      from candidates c
      left join lateral (
        select count(*)::int as cooked_30d
        from recipe_history rh
        where rh.recipe_id = c.id
          and rh.event = 'cooked'
          and rh.at > now() - interval '30 days'
      ) p on true
      order by score desc, c.updated_at desc, c.id asc
      limit $17 offset $18
      `,
      [
        diets,
        allergensExclude,
        cuisines,
        majorConditions,
        q || null,
        timeMax || null,
        calMin || null,
        calMax || null,
        proteinMin || null,
        sugarMax || null,
        sodiumMax || null,
        fiberMin || null,
        satfatMax || null,
        difficulty || null,
        mealType || null,
        cuisines,
        limit,
        offset,
        diets,
        allergensExclude,
        majorConditions,
      ]
    );

    return results.map((row: any) => ({
      recipe: row.recipe,
      score: Number(row.score ?? 0),
      reasons: Array.isArray(row.reasons) ? row.reasons : [],
    }));
  } catch (error) {
    console.error("Search error:", error);
    throw new Error("Recipe search failed");
  }
}

export async function getRecipeDetail(id: string): Promise<any> {
  const recipe = await db
    .select()
    .from(recipes)
    .where(and(
      eq(recipes.id, id),
      eq(recipes.status, "published"),
      eq(recipes.marketCountry, "US")
    ))
    .limit(1);
  
  if (recipe.length === 0) {
    throw new Error("Recipe not found");
  }
  
  return recipe[0];
}

export async function getPopularRecipes(limit: number = 20): Promise<any[]> {
  try {
    const results = await executeRaw(`
      SELECT r.*, COALESCE(mv.cooked_30d, 0) as popularity_score
      FROM recipes r
      LEFT JOIN mv_recipe_popularity_30d mv ON r.id = mv.recipe_id
      WHERE r.status = 'published' AND r.market_country = 'US'
      ORDER BY mv.cooked_30d DESC NULLS LAST, r.updated_at DESC
      LIMIT $1
    `, [limit]);
    
    return results;
  } catch (error) {
    console.error("Popular recipes error:", error);
    throw new Error("Failed to fetch popular recipes");
  }
}
