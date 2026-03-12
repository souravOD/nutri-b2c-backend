import { Router } from "express";
import type { Request, Response, NextFunction } from "express";
import { z } from "zod";
import { authMiddleware } from "../middleware/auth.js";
import { rateLimitMiddleware } from "../middleware/rateLimit.js";
import { requireB2cCustomerIdFromReq } from "../services/b2cIdentity.js";
import { getOrCreateHousehold } from "../services/household.js";
import {
  getHouseholdPreferences,
  setHouseholdPreference,
  deleteHouseholdPreference,
} from "../services/householdPreference.js";

const router = Router();
router.use(authMiddleware);

function b2cId(req: Request): string {
  return requireB2cCustomerIdFromReq(req);
}

// ── Validation ──────────────────────────────────────────────────────────────

const setPreferenceSchema = z.object({
  preferenceType: z.string().min(1).max(50),
  preferenceValue: z.string().min(1).max(255),
  priority: z.number().int().optional(),
});

// ── Routes ──────────────────────────────────────────────────────────────────

// GET /api/v1/households/preferences
router.get(
  "/",
  rateLimitMiddleware,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const customerId = b2cId(req);
      const household = await getOrCreateHousehold(customerId);
      const preferences = await getHouseholdPreferences(household.id);
      res.json({ preferences });
    } catch (err) {
      next(err);
    }
  }
);

// POST /api/v1/households/preferences
router.post(
  "/",
  rateLimitMiddleware,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const customerId = b2cId(req);
      const household = await getOrCreateHousehold(customerId);
      const parsed = setPreferenceSchema.parse(req.body);
      const preference = await setHouseholdPreference(
        household.id,
        parsed.preferenceType,
        parsed.preferenceValue,
        parsed.priority
      );
      res.json({ preference });
    } catch (err) {
      next(err);
    }
  }
);

// DELETE /api/v1/households/preferences/:id
router.delete(
  "/:id",
  rateLimitMiddleware,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const customerId = b2cId(req);
      const household = await getOrCreateHousehold(customerId);
      await deleteHouseholdPreference(req.params.id, household.id);
      res.status(204).end();
    } catch (err) {
      next(err);
    }
  }
);

export default router;
