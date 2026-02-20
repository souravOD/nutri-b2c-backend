import { Router } from "express";
import type { Request, Response, NextFunction } from "express";
import { z } from "zod";
import { authMiddleware } from "../middleware/auth.js";
import { rateLimitMiddleware } from "../middleware/rateLimit.js";
import { requireB2cCustomerIdFromReq } from "../services/b2cIdentity.js";
import { AppError } from "../middleware/errorHandler.js";
import {
  getOrCreateHousehold,
  getHouseholdMembers,
  addFamilyMember,
  getMemberDetail,
  updateMemberBasicInfo,
  updateMemberHealthProfile,
} from "../services/household.js";

const router = Router();
router.use(authMiddleware);

function b2cId(req: Request): string {
  return requireB2cCustomerIdFromReq(req);
}

// ── Validation Schemas ──────────────────────────────────────────────────────

const addMemberSchema = z.object({
  fullName: z.string().min(1).max(255),
  firstName: z.string().max(100).optional(),
  age: z.number().int().min(0).max(120).optional(),
  gender: z.enum(["male", "female", "other", "prefer_not_to_say"]).optional(),
  householdRole: z.enum(["primary_adult", "secondary_adult", "child", "dependent"]).optional(),
});

const updateMemberSchema = z.object({
  fullName: z.string().min(1).max(255).optional(),
  firstName: z.string().max(100).optional(),
  age: z.number().int().min(0).max(120).optional(),
  gender: z.enum(["male", "female", "other", "prefer_not_to_say"]).optional(),
  householdRole: z.enum(["primary_adult", "secondary_adult", "child", "dependent"]).optional(),
});

const updateHealthSchema = z.object({
  targetCalories: z.number().int().positive().optional(),
  targetProteinG: z.number().positive().optional(),
  targetCarbsG: z.number().positive().optional(),
  targetFatG: z.number().positive().optional(),
  targetFiberG: z.number().positive().optional(),
  targetSodiumMg: z.number().int().positive().optional(),
  targetSugarG: z.number().positive().optional(),
  allergenIds: z.array(z.string().uuid()).optional(),
  dietIds: z.array(z.string().uuid()).optional(),
  conditionIds: z.array(z.string().uuid()).optional(),
});

// ── Routes ──────────────────────────────────────────────────────────────────

// GET /api/v1/households/members
router.get(
  "/members",
  rateLimitMiddleware,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const customerId = b2cId(req);
      const household = await getOrCreateHousehold(customerId);
      const members = await getHouseholdMembers(household.id);
      res.json({ household, members });
    } catch (err) {
      next(err);
    }
  }
);

// POST /api/v1/households/members
router.post(
  "/members",
  rateLimitMiddleware,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const customerId = b2cId(req);
      const household = await getOrCreateHousehold(customerId);
      const parsed = addMemberSchema.parse(req.body);
      const member = await addFamilyMember(household.id, parsed);
      res.status(201).json({ member });
    } catch (err) {
      next(err);
    }
  }
);

// GET /api/v1/households/members/:id
router.get(
  "/members/:id",
  rateLimitMiddleware,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const member = await getMemberDetail(req.params.id);
      if (!member) {
        throw new AppError(404, "Not Found", "Household member not found");
      }
      res.json({ member });
    } catch (err) {
      next(err);
    }
  }
);

// PATCH /api/v1/households/members/:id
router.patch(
  "/members/:id",
  rateLimitMiddleware,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const parsed = updateMemberSchema.parse(req.body);
      const updated = await updateMemberBasicInfo(req.params.id, parsed);
      if (!updated) {
        throw new AppError(404, "Not Found", "Member not found or no changes");
      }
      res.json({ member: updated });
    } catch (err) {
      next(err);
    }
  }
);

// PATCH /api/v1/households/members/:id/health
router.patch(
  "/members/:id/health",
  rateLimitMiddleware,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const parsed = updateHealthSchema.parse(req.body);
      const member = await updateMemberHealthProfile(req.params.id, parsed);
      res.json({ member });
    } catch (err) {
      next(err);
    }
  }
);

export default router;
