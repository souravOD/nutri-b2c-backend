import { Router } from "express";
import type { Request, Response, NextFunction } from "express";
import { z } from "zod";
import { authMiddleware } from "../middleware/auth.js";
import { rateLimitMiddleware } from "../middleware/rateLimit.js";
import { ipRateLimitMiddleware } from "../middleware/ipRateLimit.js";
import { requireB2cCustomerIdFromReq } from "../services/b2cIdentity.js";
import { getOrCreateHousehold } from "../services/household.js";
import {
  createInvitation,
  getInvitationByToken,
  getInvitationPreview,
  acceptInvitation,
  revokeInvitation,
  listHouseholdInvitations,
} from "../services/householdInvite.js";
import { sendInvitationEmail } from "../services/emailService.js";
import { db } from "../config/database.js";
import { eq } from "drizzle-orm";
import { b2cCustomers, households } from "../../shared/goldSchema.js";

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

/**
 * @openapi
 * /households/invitations:
 *   post:
 *     tags: [Household Invites]
 *     summary: Create a household invitation
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               role: { type: string, enum: [secondary_adult, child, dependent], default: secondary_adult }
 *               invitedEmail: { type: string, format: email }
 *     responses:
 *       201:
 *         description: Invitation created
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 invitation: { type: object }
 *                 inviteUrl: { type: string, format: uri }
 *                 expiresAt: { type: string, format: date-time }
 */
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

      // Fire-and-forget email delivery when invitedEmail is provided
      let emailQueued = false;
      if (parsed.invitedEmail) {
        const [inviter] = await db
          .select({ name: b2cCustomers.fullName })
          .from(b2cCustomers)
          .where(eq(b2cCustomers.id, customerId))
          .limit(1);
        const [hh] = await db
          .select({ name: households.householdName })
          .from(households)
          .where(eq(households.id, household.id))
          .limit(1);

        sendInvitationEmail({
          to: parsed.invitedEmail,
          inviterName: inviter?.name ?? "Someone",
          householdName: hh?.name ?? "their household",
          role: parsed.role,
          inviteUrl,
          expiresAt: invitation.expiresAt,
        }).catch((err) => console.error("[invite-email] send failed:", err));
        emailQueued = true;
      }

      res.status(201).json({
        invitation,
        inviteUrl,
        expiresAt: invitation.expiresAt,
        emailQueued,
      });
    } catch (err) {
      next(err);
    }
  }
);

/**
 * @openapi
 * /households/invitations:
 *   get:
 *     tags: [Household Invites]
 *     summary: List pending household invitations
 *     responses:
 *       200: { description: List of pending invitations }
 */
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

/**
 * @openapi
 * /households/invitations/{id}:
 *   delete:
 *     tags: [Household Invites]
 *     summary: Revoke a household invitation
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string, format: uuid }
 *     responses:
 *       204: { description: Invitation revoked }
 */
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

/**
 * @openapi
 * /invitations/{token}/preview:
 *   get:
 *     tags: [Household Invites]
 *     summary: Get invitation preview (unauthenticated)
 *     description: Returns display-safe invitation details without requiring authentication.
 *     parameters:
 *       - in: path
 *         name: token
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200: { description: Invitation preview }
 *       404: { description: Invitation not found }
 *       410: { description: Invitation expired, accepted, or revoked }
 */
invitationTokenRouter.get(
  "/:token/preview",
  ipRateLimitMiddleware(30), // SEC-1: IP-based, 30 req/min
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const details = await getInvitationPreview(req.params.token);
      res.json(details);
    } catch (err) {
      next(err);
    }
  }
);

/**
 * @openapi
 * /invitations/{token}:
 *   get:
 *     tags: [Household Invites]
 *     summary: Get invitation details by token
 *     parameters:
 *       - in: path
 *         name: token
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200: { description: Invitation details }
 *       404: { description: Invitation not found or expired }
 */
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

/**
 * @openapi
 * /invitations/{token}/accept:
 *   post:
 *     tags: [Household Invites]
 *     summary: Accept a household invitation
 *     parameters:
 *       - in: path
 *         name: token
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: Invitation accepted
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success: { type: boolean }
 *                 message: { type: string }
 *                 householdId: { type: string, format: uuid }
 */
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
