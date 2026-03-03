import { Router } from "express";
import { executeRaw } from "../config/database.js";
import { authMiddleware } from "../middleware/auth.js";
import { requireB2cCustomerIdFromReq } from "../services/b2cIdentity.js";

const router = Router();

/**
 * GET /api/v1/recipe-meta
 * Returns all dropdown data needed by the Create Recipe form in a single call:
 *   - cuisines (from gold.cuisines)
 *   - mealTypes (from gold.recipes CHECK constraint)
 *   - diets (from gold.dietary_preferences)
 *   - allergens (from gold.allergens with is_top_9 flag)
 */
router.get("/", async (_req, res, next) => {
    try {
        const [cuisineRows, dietRows, allergenRows] = await Promise.all([
            executeRaw(`
        SELECT id, code, name, COALESCE(region, country) AS region
        FROM gold.cuisines
        ORDER BY name
      `),
            executeRaw(`
        SELECT id, code, name, category, COALESCE(is_medical, false) AS is_medical
        FROM gold.dietary_preferences
        ORDER BY name
      `),
            executeRaw(`
        SELECT id, code, name, category, COALESCE(is_top_9, false) AS is_top_9
        FROM gold.allergens
        ORDER BY name
      `),
        ]);

        res.json({
            cuisines: cuisineRows.map((r: any) => ({
                id: r.id,
                code: r.code,
                name: r.name,
                region: r.region,
            })),
            mealTypes: ["breakfast", "lunch", "dinner", "snack", "dessert"],
            diets: dietRows.map((r: any) => ({
                id: r.id,
                code: r.code,
                name: r.name,
                category: r.category,
                isMedical: r.is_medical,
            })),
            allergens: allergenRows.map((r: any) => ({
                id: r.id,
                code: r.code,
                name: r.name,
                category: r.category,
                isTop9: r.is_top_9,
            })),
        });
    } catch (err) {
        next(err);
    }
});

/**
 * POST /api/v1/recipe-meta/detect-allergens
 * Given ingredient names, returns auto-detected allergens via gold.ingredient_allergens.
 *
 * Body: { ingredient_names: string[] }
 * Response: { detected_allergens: [{ allergen_id, code, name, matched_ingredient }] }
 */
router.post("/detect-allergens", authMiddleware, async (req, res, next) => {
    try {
        requireB2cCustomerIdFromReq(req); // ensure authenticated

        const names: string[] = req.body?.ingredient_names ?? [];
        if (!Array.isArray(names) || names.length === 0) {
            return res.json({ detected_allergens: [] });
        }

        // Fuzzy-match ingredient names to gold.ingredients, then join to ingredient_allergens
        const rows = await executeRaw(
            `
      WITH matched_ingredients AS (
        SELECT DISTINCT ON (n.name)
          n.name AS input_name,
          i.id AS ingredient_id,
          i.name AS ingredient_name
        FROM unnest($1::text[]) AS n(name)
        CROSS JOIN LATERAL (
          SELECT id, name
          FROM gold.ingredients
          WHERE name ILIKE '%' || n.name || '%'
             OR n.name ILIKE '%' || name || '%'
          ORDER BY
            CASE WHEN LOWER(name) = LOWER(n.name) THEN 0 ELSE 1 END,
            LENGTH(name)
          LIMIT 1
        ) i
      )
      SELECT DISTINCT
        a.id AS allergen_id,
        a.code,
        a.name,
        mi.input_name AS matched_ingredient
      FROM matched_ingredients mi
      JOIN gold.ingredient_allergens ia ON ia.ingredient_id = mi.ingredient_id
      JOIN gold.allergens a ON a.id = ia.allergen_id
      ORDER BY a.name
      `,
            [names]
        );

        res.json({
            detected_allergens: rows.map((r: any) => ({
                allergen_id: r.allergen_id,
                code: r.code,
                name: r.name,
                matched_ingredient: r.matched_ingredient,
            })),
        });
    } catch (err) {
        next(err);
    }
});

export default router;
