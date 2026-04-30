import { Router } from "express";
import { executeRaw } from "../config/database.js";
import { authMiddleware } from "../middleware/auth.js";
import { resolveCustomAllergen } from "../services/allergenResolver.js";

const router = Router();

/**
 * @openapi
 * /taxonomy/allergens:
 *   get:
 *     tags: [Taxonomy]
 *     summary: List all allergens
 *     security: []
 *     responses:
 *       200: { description: Array of allergens with id, code, name, category }
 */
router.get("/allergens", async (req, res, next) => {
  try {
    const rows = await executeRaw(
      `
      select id as gold_id, code, name, category
      from gold.allergens
      order by name
      `
    );
    res.json(rows);
  } catch (error) {
    next(error);
  }
});

/**
 * @openapi
 * /taxonomy/allergens/resolve:
 *   post:
 *     tags: [Taxonomy]
 *     summary: Resolve a custom allergen name via synonym lookup + LLM
 *     security: [{ bearerAuth: [] }]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               name: { type: string }
 *             required: [name]
 *     responses:
 *       200:
 *         description: Resolution result
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 matched: { type: boolean }
 *                 allergenId: { type: string }
 *                 allergenName: { type: string }
 *                 reasoning: { type: string }
 */
router.post("/allergens/resolve", authMiddleware, async (req, res, next) => {
  try {
    const { name } = req.body;
    if (!name || typeof name !== "string") {
      return res.status(400).json({ error: "name is required and must be a string" });
    }
    const result = await resolveCustomAllergen(name.trim());
    res.json(result);
  } catch (error) {
    next(error);
  }
});

/**
 * @openapi
 * /taxonomy/health-conditions:
 *   get:
 *     tags: [Taxonomy]
 *     summary: List all health conditions
 *     security: []
 *     responses:
 *       200: { description: Array of health conditions }
 */
router.get("/health-conditions", async (req, res, next) => {
  try {
    const rows = await executeRaw(
      `
      select id as gold_id, code, name, category
      from gold.health_conditions
      order by name
      `
    );
    res.json(rows);
  } catch (error) {
    next(error);
  }
});

/**
 * @openapi
 * /taxonomy/dietary-preferences:
 *   get:
 *     tags: [Taxonomy]
 *     summary: List dietary preferences (lifestyle and religious)
 *     security: []
 *     responses:
 *       200: { description: Array of dietary preferences }
 */
router.get("/dietary-preferences", async (req, res, next) => {
  try {
    const rows = await executeRaw(
      `
      select id as gold_id, code, name, category
      from gold.dietary_preferences
      where upper(category) in ('ETHICAL_RELIGIOUS', 'LIFESTYLE')
      order by name
      `
    );
    res.json(rows);
  } catch (error) {
    next(error);
  }
});

/**
 * @openapi
 * /taxonomy/cuisines:
 *   get:
 *     tags: [Taxonomy]
 *     summary: List all cuisines
 *     security: []
 *     responses:
 *       200: { description: Array of cuisines }
 */
router.get("/cuisines", async (req, res, next) => {
  try {
    const rows = await executeRaw(
      `
      select id as gold_id, code, name, coalesce(region, country) as category
      from gold.cuisines
      order by name
      `
    );
    res.json(rows);
  } catch (error) {
    next(error);
  }
});

export default router;
