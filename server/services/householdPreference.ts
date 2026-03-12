import { db } from "../config/database.js";
import { eq, and } from "drizzle-orm";
import {
  householdPreferences,
  type HouseholdPreference,
} from "../../shared/goldSchema.js";

// ── Get all preferences for a household ─────────────────────────────────────

export async function getHouseholdPreferences(
  householdId: string
): Promise<HouseholdPreference[]> {
  return db
    .select()
    .from(householdPreferences)
    .where(eq(householdPreferences.householdId, householdId));
}

// ── Set (upsert) a preference ───────────────────────────────────────────────

export async function setHouseholdPreference(
  householdId: string,
  preferenceType: string,
  preferenceValue: string,
  priority?: number
): Promise<HouseholdPreference> {
  // Check if preference already exists for this household+type
  const [existing] = await db
    .select()
    .from(householdPreferences)
    .where(
      and(
        eq(householdPreferences.householdId, householdId),
        eq(householdPreferences.preferenceType, preferenceType)
      )
    )
    .limit(1);

  if (existing) {
    // Update existing
    const [updated] = await db
      .update(householdPreferences)
      .set({
        preferenceValue,
        priority: priority ?? existing.priority,
      })
      .where(eq(householdPreferences.id, existing.id))
      .returning();
    return updated;
  }

  // Insert new
  const [inserted] = await db
    .insert(householdPreferences)
    .values({
      householdId,
      preferenceType,
      preferenceValue,
      priority: priority ?? null,
    })
    .returning();

  return inserted;
}

// ── Delete a preference ─────────────────────────────────────────────────────

export async function deleteHouseholdPreference(
  preferenceId: string,
  householdId: string
): Promise<void> {
  await db
    .delete(householdPreferences)
    .where(
      and(
        eq(householdPreferences.id, preferenceId),
        eq(householdPreferences.householdId, householdId)
      )
    );
}
