import { Router } from "express";
import { upsertProfileFromAppwrite, upsertHealthFromAppwrite } from "../services/supabaseSync.js";
import { authMiddleware } from "../middleware/auth.js";

const router = Router();

function getJsonBody(req: any) {
  if (typeof req.body === "string") {
    try { return JSON.parse(req.body); } catch { return {}; }
  }
  return req.body || {};
}

/** POST /api/v1/sync/profile */
router.post("/profile", authMiddleware, async (req, res, next) => {
  try {
    const body = getJsonBody(req);
    const profile = body?.profile ?? null;

    // Use the authenticated user's ID — ignore any userId in the body
    const userId = (req as any).user?.effectiveUserId ?? (req as any).user?.userId;

    if (!userId || !profile) {
      return res.status(400).json({ error: "Missing authenticated user or profile" });
    }
    await upsertProfileFromAppwrite({ appwriteId: userId, profile, account: body?.account });
    res.json({ ok: true });
  } catch (err) { next(err); }
});

/** POST /api/v1/sync/health */
router.post("/health", authMiddleware, async (req, res, next) => {
  try {
    const body = getJsonBody(req);
    const health = body?.health ?? null;

    // Use the authenticated user's ID — ignore any userId in the body
    const userId = (req as any).user?.effectiveUserId ?? (req as any).user?.userId;

    if (!userId || !health) {
      return res.status(400).json({ error: "Missing authenticated user or health" });
    }
    await upsertHealthFromAppwrite({ appwriteId: userId, health });
    res.json({ ok: true });
  } catch (err) { next(err); }
});

export default router;
