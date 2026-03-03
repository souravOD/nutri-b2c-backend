import { executeRaw } from "../config/database.js";

export interface IngredientSearchResult {
    id: string;
    name: string;
    category: string | null;
    calories: number | null;
    protein_g: number | null;
    total_carbs_g: number | null;
    total_fat_g: number | null;
    dietary_fiber_g: number | null;
    sodium_mg: number | null;
    total_sugars_g: number | null;
    saturated_fat_g: number | null;
    cholesterol_mg: number | null;
    calcium_mg: number | null;
    iron_mg: number | null;
    potassium_mg: number | null;
    vitamin_a_mcg: number | null;
    vitamin_c_mg: number | null;
    vitamin_d_mcg: number | null;
}

/**
 * Search ingredients using PostgreSQL trigram similarity + prefix matching.
 * Requires: CREATE EXTENSION IF NOT EXISTS pg_trgm;
 * Requires: CREATE INDEX idx_ingredients_name_trgm ON gold.ingredients USING GIN (name gin_trgm_ops);
 */
export async function searchIngredients(
    query: string,
    limit: number = 10,
): Promise<IngredientSearchResult[]> {
    const q = query.trim();
    if (q.length < 2) return [];

    const rows = await executeRaw(
        `SELECT
      id, name, category,
      calories, protein_g, total_carbs_g, total_fat_g,
      dietary_fiber_g, sodium_mg, total_sugars_g, saturated_fat_g,
      cholesterol_mg, calcium_mg, iron_mg, potassium_mg,
      vitamin_a_mcg, vitamin_c_mg, vitamin_d_mcg
    FROM gold.ingredients
    WHERE
      name % $1
      OR lower(name) LIKE lower($1) || '%'
    ORDER BY
      CASE WHEN lower(name) LIKE lower($1) || '%' THEN 0 ELSE 1 END,
      similarity(name, $1) DESC
    LIMIT $2`,
        [q, limit],
    );

    return rows as unknown as IngredientSearchResult[];
}
