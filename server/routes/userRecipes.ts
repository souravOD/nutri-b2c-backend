import { Router } from "express";
import { createUserRecipe, deleteUserRecipe, getUserRecipe, getUserRecipes, updateUserRecipe } from "../services/userContent.js";
import { requireB2cCustomerIdFromReq } from "../services/b2cIdentity.js";
import { authMiddleware } from "../middleware/auth.js";

function getJsonBody(req: any) {
  if (typeof req.body === "string") {
    try { return JSON.parse(req.body); } catch { return {}; }
  }
  return req.body || {};
}

const router = Router();

/** GET /api/v1/user-recipes  (list current user's recipes) */
router.get("/", authMiddleware, async (req, res, next) => {
  try {
    const b2cCustomerId = requireB2cCustomerIdFromReq(req);
    const limit = Math.max(1, Math.min(100, Number(req.query.limit ?? 50)));
    const offset = Math.max(0, Number(req.query.offset ?? 0));
    const items = await getUserRecipes(b2cCustomerId, limit, offset);
    res.json({ items, limit, offset });
  } catch (err) { next(err); }
});

/** GET /api/v1/user-recipes/:id */
router.get("/:id", authMiddleware, async (req, res, next) => {
  try {
    const b2cCustomerId = requireB2cCustomerIdFromReq(req);
    const row = await getUserRecipe(b2cCustomerId, req.params.id);
    res.json(row);
  } catch (err) { next(err); }
});

/** POST /api/v1/user-recipes */
router.post("/", authMiddleware, async (req, res, next) => {
  try {
    const b2cCustomerId = requireB2cCustomerIdFromReq(req);

    const body = getJsonBody(req);
    const p = body?.recipe ?? body;

    if (!p?.title || String(p.title).trim().length < 2) {
      return res.status(400).json({ error: "Title is required" });
    }
    if (!p?.ingredients || !Array.isArray(p.ingredients) || p.ingredients.length === 0) {
      return res.status(400).json({ error: "At least one ingredient is required" });
    }
    if (!p?.instructions || !Array.isArray(p.instructions) || p.instructions.length === 0) {
      return res.status(400).json({ error: "At least one instruction step is required" });
    }

    const row = await createUserRecipe(b2cCustomerId, p);
    res.status(201).json(row);
  } catch (err) { next(err); }
});

/** PATCH /api/v1/user-recipes/:id */
router.patch("/:id", authMiddleware, async (req, res, next) => {
  try {
    const patch = getJsonBody(req)?.recipe ?? getJsonBody(req);
    const b2cCustomerId = requireB2cCustomerIdFromReq(req);
    const row = await updateUserRecipe(b2cCustomerId, req.params.id, patch);
    res.json(row);
  } catch (err) { next(err); }
});

/** DELETE /api/v1/user-recipes/:id */
router.delete("/:id", authMiddleware, async (req, res, next) => {
  try {
    const b2cCustomerId = requireB2cCustomerIdFromReq(req);
    await deleteUserRecipe(b2cCustomerId, req.params.id);
    res.status(204).end();
  } catch (err) { next(err); }
});

export default router;
