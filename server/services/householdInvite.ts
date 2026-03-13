import { db } from "../config/database.js";
import { eq, and, ne, gt, lt, sql } from "drizzle-orm";
import crypto from "crypto";
import {
  householdInvitations,
  households,
  householdBudgets,
  householdPreferences,
  b2cCustomers,
  type HouseholdInvitation,
} from "../../shared/goldSchema.js";
import { AppError } from "../middleware/errorHandler.js";

// ── Create Invitation ───────────────────────────────────────────────────────

export async function createInvitation(
  householdId: string,
  invitedBy: string,
  role: string = "secondary_adult",
  invitedEmail?: string
): Promise<HouseholdInvitation> {
  // E6: Auto-revoke any existing pending invites for same email+household
  if (invitedEmail) {
    await db
      .update(householdInvitations)
      .set({ status: "revoked" })
      .where(
        and(
          eq(householdInvitations.householdId, householdId),
          eq(householdInvitations.invitedEmail, invitedEmail),
          eq(householdInvitations.status, "pending")
        )
      );
  }

  const token = crypto.randomUUID();
  const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000); // 7 days

  const [invitation] = await db
    .insert(householdInvitations)
    .values({
      householdId,
      invitedBy,
      inviteToken: token,
      invitedEmail: invitedEmail ?? null,
      role,
      status: "pending",
      expiresAt,
    })
    .returning();

  return invitation;
}

// ── Get Invitation by Token ─────────────────────────────────────────────────

export async function getInvitationByToken(token: string) {
  // First: try to find ANY invitation with this token (regardless of status)
  const [raw] = await db
    .select()
    .from(householdInvitations)
    .where(eq(householdInvitations.inviteToken, token))
    .limit(1);

  if (!raw) {
    throw new AppError(404, "Not Found", "Invitation not found");
  }

  // E2: Already accepted
  if (raw.status === "accepted") {
    throw new AppError(
      410,
      "Gone",
      "This invitation has already been accepted."
    );
  }

  // E3: Revoked by sender
  if (raw.status === "revoked") {
    throw new AppError(
      410,
      "Gone",
      "This invitation was cancelled by the sender."
    );
  }

  // E1: Expired
  if (raw.status === "expired" || new Date(raw.expiresAt) < new Date()) {
    throw new AppError(
      410,
      "Gone",
      "This invitation has expired. Ask the sender for a new one."
    );
  }

  // Valid pending invitation — enrich with household + inviter names
  const [household] = await db
    .select({ name: households.householdName, type: households.householdType, totalMembers: households.totalMembers })
    .from(households)
    .where(eq(households.id, raw.householdId))
    .limit(1);

  const [inviter] = await db
    .select({ name: b2cCustomers.fullName })
    .from(b2cCustomers)
    .where(eq(b2cCustomers.id, raw.invitedBy))
    .limit(1);

  return {
    ...raw,
    householdName: household?.name ?? "Unknown Household",
    householdType: household?.type ?? "individual",
    totalMembers: household?.totalMembers ?? 1,
    invitedByName: inviter?.name ?? "Someone",
  };
}

// ── Accept Invitation ───────────────────────────────────────────────────────

export async function acceptInvitation(
  token: string,
  acceptorB2cCustomerId: string
) {
  // Use a transaction for atomicity
  const result = await db.transaction(async (tx) => {
    // 1. Fetch and validate (E1/E2/E3 checks via status+expiry filter)
    const [invitation] = await tx
      .select()
      .from(householdInvitations)
      .where(
        and(
          eq(householdInvitations.inviteToken, token),
          eq(householdInvitations.status, "pending"),
          gt(householdInvitations.expiresAt, new Date())
        )
      )
      .limit(1);

    if (!invitation) {
      throw new AppError(410, "Gone", "Invitation expired or invalid");
    }

    // 2. Get acceptor's current state
    const [acceptor] = await tx
      .select()
      .from(b2cCustomers)
      .where(eq(b2cCustomers.id, acceptorB2cCustomerId))
      .limit(1);

    if (!acceptor) {
      throw new AppError(404, "Not Found", "User not found");
    }

    const oldHouseholdId = acceptor.householdId;

    // E4: Already in target household
    if (oldHouseholdId === invitation.householdId) {
      throw new AppError(
        409,
        "Conflict",
        "You are already a member of this household"
      );
    }

    // E5: Acceptor has dependents — can't abandon them
    if (oldHouseholdId) {
      const [othersCount] = await tx
        .select({ count: sql<number>`count(*)` })
        .from(b2cCustomers)
        .where(
          and(
            eq(b2cCustomers.householdId, oldHouseholdId),
            ne(b2cCustomers.id, acceptorB2cCustomerId)
          )
        );
      if (Number(othersCount.count) > 0) {
        throw new AppError(
          409,
          "Conflict",
          `Cannot leave household — you have ${othersCount.count} other member(s). Remove them or transfer head role first.`
        );
      }
    }

    // 5. Transfer acceptor to new household
    await tx
      .update(b2cCustomers)
      .set({
        householdId: invitation.householdId,
        householdRole: invitation.role ?? "secondary_adult",
        isProfileOwner: false,
      })
      .where(eq(b2cCustomers.id, acceptorB2cCustomerId));

    // 6. Update target household counts + type
    await tx
      .update(households)
      .set({
        totalMembers: sql`total_members + 1`,
        householdType: sql`CASE
          WHEN total_members + 1 = 2 THEN 'couple'
          ELSE 'family' END`,
      })
      .where(eq(households.id, invitation.householdId));

    // 7. Mark invitation accepted
    await tx
      .update(householdInvitations)
      .set({
        status: "accepted",
        acceptedAt: new Date(),
        acceptedBy: acceptorB2cCustomerId,
      })
      .where(eq(householdInvitations.id, invitation.id));

    // E6 (post-accept): Auto-revoke other pending invites for same email
    if (invitation.invitedEmail) {
      await tx
        .update(householdInvitations)
        .set({ status: "revoked" })
        .where(
          and(
            eq(householdInvitations.invitedEmail, invitation.invitedEmail),
            eq(householdInvitations.status, "pending"),
            ne(householdInvitations.id, invitation.id)
          )
        );
    }

    // 8. Cleanup orphan household
    if (oldHouseholdId) {
      const [remaining] = await tx
        .select({ count: sql<number>`count(*)` })
        .from(b2cCustomers)
        .where(eq(b2cCustomers.householdId, oldHouseholdId));

      if (Number(remaining.count) === 0) {
        // Delete related data before deleting the household
        await tx
          .delete(householdBudgets)
          .where(eq(householdBudgets.householdId, oldHouseholdId));
        await tx
          .delete(householdPreferences)
          .where(eq(householdPreferences.householdId, oldHouseholdId));
        await tx
          .delete(households)
          .where(eq(households.id, oldHouseholdId));
      }
    }

    // E7: Multiple pending invites from other households are NOT affected.
    // Each invite is token-scoped. Accepting one doesn't touch others.

    return { householdId: invitation.householdId };
  });

  return result;
}

// ── Revoke Invitation ───────────────────────────────────────────────────────

export async function revokeInvitation(
  invitationId: string,
  revokerB2cCustomerId: string
): Promise<void> {
  const [invitation] = await db
    .select()
    .from(householdInvitations)
    .where(eq(householdInvitations.id, invitationId))
    .limit(1);

  if (!invitation) {
    throw new AppError(404, "Not Found", "Invitation not found");
  }
  if (invitation.invitedBy !== revokerB2cCustomerId) {
    throw new AppError(
      403,
      "Forbidden",
      "Only the person who sent this invite can revoke it"
    );
  }
  if (invitation.status !== "pending") {
    throw new AppError(
      409,
      "Conflict",
      `Cannot revoke — invitation is already ${invitation.status}`
    );
  }

  await db
    .update(householdInvitations)
    .set({ status: "revoked" })
    .where(eq(householdInvitations.id, invitationId));
}

// ── List Pending Invitations for a Household ────────────────────────────────

export async function listHouseholdInvitations(householdId: string) {
  return db
    .select()
    .from(householdInvitations)
    .where(
      and(
        eq(householdInvitations.householdId, householdId),
        eq(householdInvitations.status, "pending")
      )
    );
}

// ── Cleanup Expired Invitations ─────────────────────────────────────────────

export async function cleanupExpiredInvitations() {
  await db
    .update(householdInvitations)
    .set({ status: "expired" })
    .where(
      and(
        eq(householdInvitations.status, "pending"),
        lt(householdInvitations.expiresAt, new Date())
      )
    );
  return { cleaned: true };
}
