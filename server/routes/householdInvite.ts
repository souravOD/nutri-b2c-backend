import { Router } from "express";
import type { Request, Response, NextFunction } from "express";
import { z } from "zod";
import { authMiddleware } from "../middleware/auth.js";
import { rateLimitMiddleware } from "../middleware/rateLimit.js";
import { requireB2cCustomerIdFromReq } from "../services/b2cIdentity.js";
import { getOrCreateHousehold } from "../services/household.js";
import {
  createInvitation,
  getInvitationByToken,
  acceptInvitation,
  revokeInvitation,
  listHouseholdInvitations,
} from "../services/householdInvite.js";

const router = Router();

function b2cId(req: Request): string {
  return requireB2cCustomerIdFromReq(req);
}

// ── Validation Schemas ──────────────────────────────────────────────────────

const createInvitationSchema = z.object({
  role: z
    .enum(["secondary_adult", "child", "dependent"])
    .optional()
    .default("secondary_adult"),
  invitedEmail: z.string().email().optional(),
});

// ── Routes ──────────────────────────────────────────────────────────────────

// POST /api/v1/households/invitations — Generate invite token
router.post(
  "/",
  authMiddleware,
  rateLimitMiddleware,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const customerId = b2cId(req);
      const household = await getOrCreateHousehold(customerId);
      const parsed = createInvitationSchema.parse(req.body);

      const invitation = await createInvitation(
        household.id,
        customerId,
        parsed.role,
        parsed.invitedEmail
      );

      const inviteUrl = `${
        process.env.FRONTEND_URL || "https://app.nutrismarts.ai"
      }/join?token=${invitation.inviteToken}`;

      res.status(201).json({
        invitation,
        inviteUrl,
        expiresAt: invitation.expiresAt,
      });
    } catch (err) {
      next(err);
    }
  }
);

// GET /api/v1/households/invitations — List pending invites for my household
router.get(
  "/",
  authMiddleware,
  rateLimitMiddleware,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const customerId = b2cId(req);
      const household = await getOrCreateHousehold(customerId);
      const invitations = await listHouseholdInvitations(household.id);
      res.json({ invitations });
    } catch (err) {
      next(err);
    }
  }
);

// DELETE /api/v1/households/invitations/:id — Revoke invite
router.delete(
  "/:id",
  authMiddleware,
  rateLimitMiddleware,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const customerId = b2cId(req);
      await revokeInvitation(req.params.id, customerId);
      res.status(204).end();
    } catch (err) {
      next(err);
    }
  }
);

export default router;

// ── Separate router for /api/v1/invitations/:token routes ───────────────────
// These are on a different base path because they're accessed by the
// invited user (not necessarily the household owner)

export const invitationTokenRouter = Router();

// GET /api/v1/invitations/:token — Get invitation details (requires auth)
invitationTokenRouter.get(
  "/:token",
  authMiddleware,
  rateLimitMiddleware,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const details = await getInvitationByToken(req.params.token);
      res.json(details);
    } catch (err) {
      next(err);
    }
  }
);

// POST /api/v1/invitations/:token/accept — Accept invitation
invitationTokenRouter.post(
  "/:token/accept",
  authMiddleware,
  rateLimitMiddleware,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const customerId = b2cId(req);
      const result = await acceptInvitation(req.params.token, customerId);
      res.json({
        success: true,
        message: "Welcome to the household!",
        householdId: result.householdId,
      });
    } catch (err) {
      next(err);
    }
  }
);
