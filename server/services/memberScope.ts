import { eq } from "drizzle-orm";
import { db } from "../config/database.js";
import { b2cCustomers } from "../../shared/goldSchema.js";
import { getOrCreateHousehold } from "./household.js";
import {
  resolveTargetMemberFromRows,
  type MemberRow,
  type MemberScope,
} from "./memberScopeUtils.js";

export async function resolveMemberScope(
  actorMemberId: string,
  requestedMemberId?: string | null
): Promise<MemberScope> {
  const household = await getOrCreateHousehold(actorMemberId);

  const actorRows = await db
    .select({ id: b2cCustomers.id, householdId: b2cCustomers.householdId })
    .from(b2cCustomers)
    .where(eq(b2cCustomers.id, actorMemberId))
    .limit(1);

  const actor = actorRows[0]
    ? {
        id: actorRows[0].id,
        householdId: actorRows[0].householdId ?? household.id,
      }
    : null;

  let target: MemberRow | null = null;
  if (requestedMemberId && requestedMemberId !== actorMemberId) {
    const targetRows = await db
      .select({ id: b2cCustomers.id, householdId: b2cCustomers.householdId })
      .from(b2cCustomers)
      .where(eq(b2cCustomers.id, requestedMemberId))
      .limit(1);
    target = targetRows[0] ?? null;
  }

  return resolveTargetMemberFromRows(actor, target, requestedMemberId);
}

export async function listHouseholdMemberIds(householdId: string): Promise<string[]> {
  const rows = await db
    .select({ id: b2cCustomers.id })
    .from(b2cCustomers)
    .where(eq(b2cCustomers.householdId, householdId));
  return rows.map((r) => r.id);
}
