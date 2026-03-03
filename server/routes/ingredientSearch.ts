import { Router } from "express";
import { authMiddleware } from "../middleware/auth.js";
import { searchIngredients } from "../services/ingredientSearch.js";

const router = Router();

/**
 * GET /api/v1/ingredients/search?q=chicken&limit=10
 * Returns matching ingredients with inline nutrition data (per 100g).
 */
router.get("/search", authMiddleware, async (req, res, next) => {
    try {
        const q = String(req.query.q ?? "");
        const limit = Math.min(20, Math.max(1, Number(req.query.limit ?? 10)));

        if (q.trim().length < 2) {
            return res.json({ items: [] });
        }

        const items = await searchIngredients(q, limit);
        res.json({ items });
    } catch (err) {
        next(err);
    }
});

export default router;
