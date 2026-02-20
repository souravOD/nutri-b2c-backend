import { db, executeRaw } from "../config/database.js";
import { eq, and, inArray } from "drizzle-orm";
import {
  households,
  b2cCustomers,
  b2cCustomerHealthProfiles,
  b2cCustomerAllergens,
  b2cCustomerDietaryPreferences,
  b2cCustomerHealthConditions,
  allergens,
  dietaryPreferences,
  healthConditions,
} from "../../shared/goldSchema.js";

// ── Types ───────────────────────────────────────────────────────────────────

export interface MemberHealthProfile {
  targetCalories: number | null;
  targetProteinG: string | null;
  targetCarbsG: string | null;
  targetFatG: string | null;
  targetFiberG: string | null;
  targetSodiumMg: number | null;
  targetSugarG: string | null;
  allergens: { id: string; code: string; name: string; severity: string | null }[];
  diets: { id: string; code: string; name: string; strictness: string | null }[];
  conditions: { id: string; code: string; name: string; severity: string | null }[];
}

export interface HouseholdMember {
  id: string;
  fullName: string;
  firstName: string | null;
  age: number | null;
  gender: string | null;
  householdRole: string | null;
  isProfileOwner: boolean | null;
  healthProfile: MemberHealthProfile | null;
}

export interface AddMemberInput {
  fullName: string;
  firstName?: string;
  age?: number;
  gender?: string;
  householdRole?: string;
}

export interface UpdateMemberHealthInput {
  targetCalories?: number;
  targetProteinG?: number;
  targetCarbsG?: number;
  targetFatG?: number;
  targetFiberG?: number;
  targetSodiumMg?: number;
  targetSugarG?: number;
  allergenIds?: string[];
  dietIds?: string[];
  conditionIds?: string[];
}

// ── Get or Create Household ─────────────────────────────────────────────────

export async function getOrCreateHousehold(b2cCustomerId: string) {
  const customer = await db
    .select()
    .from(b2cCustomers)
    .where(eq(b2cCustomers.id, b2cCustomerId))
    .limit(1);

  if (!customer[0]) {
    const err = new Error("B2C customer not found");
    (err as any).status = 404;
    throw err;
  }

  if (customer[0].householdId) {
    const hh = await db
      .select()
      .from(households)
      .where(eq(households.id, customer[0].householdId))
      .limit(1);
    return hh[0];
  }

  const email = customer[0].email || "unknown@household.local";
  const name = customer[0].fullName ? `${customer[0].fullName}'s Household` : "My Household";

  const inserted = await db
    .insert(households)
    .values({
      householdName: name,
      primaryAccountEmail: email,
      householdType: "individual",
      totalMembers: 1,
    })
    .returning();

  await db
    .update(b2cCustomers)
    .set({ householdId: inserted[0].id })
    .where(eq(b2cCustomers.id, b2cCustomerId));

  return inserted[0];
}

// ── List Household Members ──────────────────────────────────────────────────

export async function getHouseholdMembers(householdId: string): Promise<HouseholdMember[]> {
  const members = await db
    .select()
    .from(b2cCustomers)
    .where(eq(b2cCustomers.householdId, householdId));

  const memberIds = members.map((m) => m.id);
  if (memberIds.length === 0) return [];

  const profiles = await getMemberHealthProfiles(memberIds);

  return members.map((m) => ({
    id: m.id,
    fullName: m.fullName,
    firstName: m.firstName,
    age: m.age,
    gender: m.gender,
    householdRole: m.householdRole,
    isProfileOwner: m.isProfileOwner,
    healthProfile: profiles.get(m.id) ?? null,
  }));
}

// ── Batch Fetch Member Health Profiles ──────────────────────────────────────

export async function getMemberHealthProfiles(
  memberIds: string[]
): Promise<Map<string, MemberHealthProfile>> {
  if (memberIds.length === 0) return new Map();

  const healthRows = await db
    .select()
    .from(b2cCustomerHealthProfiles)
    .where(inArray(b2cCustomerHealthProfiles.b2cCustomerId, memberIds));

  const allergenRows = await db
    .select({
      b2cCustomerId: b2cCustomerAllergens.b2cCustomerId,
      allergenId: b2cCustomerAllergens.allergenId,
      severity: b2cCustomerAllergens.severity,
      code: allergens.code,
      name: allergens.name,
    })
    .from(b2cCustomerAllergens)
    .innerJoin(allergens, eq(b2cCustomerAllergens.allergenId, allergens.id))
    .where(
      and(
        inArray(b2cCustomerAllergens.b2cCustomerId, memberIds),
        eq(b2cCustomerAllergens.isActive, true)
      )
    );

  const dietRows = await db
    .select({
      b2cCustomerId: b2cCustomerDietaryPreferences.b2cCustomerId,
      dietId: b2cCustomerDietaryPreferences.dietId,
      strictness: b2cCustomerDietaryPreferences.strictness,
      code: dietaryPreferences.code,
      name: dietaryPreferences.name,
    })
    .from(b2cCustomerDietaryPreferences)
    .innerJoin(dietaryPreferences, eq(b2cCustomerDietaryPreferences.dietId, dietaryPreferences.id))
    .where(
      and(
        inArray(b2cCustomerDietaryPreferences.b2cCustomerId, memberIds),
        eq(b2cCustomerDietaryPreferences.isActive, true)
      )
    );

  const conditionRows = await db
    .select({
      b2cCustomerId: b2cCustomerHealthConditions.b2cCustomerId,
      conditionId: b2cCustomerHealthConditions.conditionId,
      severity: b2cCustomerHealthConditions.severity,
      code: healthConditions.code,
      name: healthConditions.name,
    })
    .from(b2cCustomerHealthConditions)
    .innerJoin(healthConditions, eq(b2cCustomerHealthConditions.conditionId, healthConditions.id))
    .where(
      and(
        inArray(b2cCustomerHealthConditions.b2cCustomerId, memberIds),
        eq(b2cCustomerHealthConditions.isActive, true)
      )
    );

  const result = new Map<string, MemberHealthProfile>();

  for (const id of memberIds) {
    const hp = healthRows.find((r) => r.b2cCustomerId === id);
    result.set(id, {
      targetCalories: hp?.targetCalories ?? null,
      targetProteinG: hp?.targetProteinG ?? null,
      targetCarbsG: hp?.targetCarbsG ?? null,
      targetFatG: hp?.targetFatG ?? null,
      targetFiberG: hp?.targetFiberG ?? null,
      targetSodiumMg: hp?.targetSodiumMg ?? null,
      targetSugarG: hp?.targetSugarG ?? null,
      allergens: allergenRows
        .filter((r) => r.b2cCustomerId === id)
        .map((r) => ({ id: r.allergenId, code: r.code, name: r.name, severity: r.severity })),
      diets: dietRows
        .filter((r) => r.b2cCustomerId === id)
        .map((r) => ({ id: r.dietId, code: r.code, name: r.name, strictness: r.strictness })),
      conditions: conditionRows
        .filter((r) => r.b2cCustomerId === id)
        .map((r) => ({ id: r.conditionId, code: r.code, name: r.name, severity: r.severity })),
    });
  }

  return result;
}

// ── Add Family Member ───────────────────────────────────────────────────────

export async function addFamilyMember(
  householdId: string,
  input: AddMemberInput
) {
  const inserted = await db
    .insert(b2cCustomers)
    .values({
      householdId,
      fullName: input.fullName,
      firstName: input.firstName ?? input.fullName.split(" ")[0],
      age: input.age ?? null,
      gender: input.gender ?? null,
      householdRole: input.householdRole ?? "dependent",
      isProfileOwner: false,
      accountStatus: "active",
    })
    .returning();

  const member = inserted[0];

  await db.insert(b2cCustomerHealthProfiles).values({
    b2cCustomerId: member.id,
    onboardingComplete: false,
  });

  await db
    .update(households)
    .set({
      totalMembers: (
        await db
          .select()
          .from(b2cCustomers)
          .where(eq(b2cCustomers.householdId, householdId))
      ).length,
    })
    .where(eq(households.id, householdId));

  return member;
}

// ── Get Single Member Detail ────────────────────────────────────────────────

export async function getMemberDetail(memberId: string): Promise<HouseholdMember | null> {
  const rows = await db
    .select()
    .from(b2cCustomers)
    .where(eq(b2cCustomers.id, memberId))
    .limit(1);

  if (!rows[0]) return null;

  const profiles = await getMemberHealthProfiles([memberId]);

  return {
    id: rows[0].id,
    fullName: rows[0].fullName,
    firstName: rows[0].firstName,
    age: rows[0].age,
    gender: rows[0].gender,
    householdRole: rows[0].householdRole,
    isProfileOwner: rows[0].isProfileOwner,
    healthProfile: profiles.get(memberId) ?? null,
  };
}

// ── Update Member Basic Info ────────────────────────────────────────────────

export async function updateMemberBasicInfo(
  memberId: string,
  data: Partial<Pick<AddMemberInput, "fullName" | "firstName" | "age" | "gender" | "householdRole">>
) {
  const setValues: Record<string, any> = {};
  if (data.fullName) setValues.fullName = data.fullName;
  if (data.firstName) setValues.firstName = data.firstName;
  if (data.age !== undefined) setValues.age = data.age;
  if (data.gender !== undefined) setValues.gender = data.gender;
  if (data.householdRole) setValues.householdRole = data.householdRole;

  if (Object.keys(setValues).length === 0) return null;

  const updated = await db
    .update(b2cCustomers)
    .set(setValues)
    .where(eq(b2cCustomers.id, memberId))
    .returning();

  return updated[0] ?? null;
}

// ── Update Member Health Profile ────────────────────────────────────────────

export async function updateMemberHealthProfile(
  memberId: string,
  input: UpdateMemberHealthInput
) {
  const existing = await db
    .select()
    .from(b2cCustomerHealthProfiles)
    .where(eq(b2cCustomerHealthProfiles.b2cCustomerId, memberId))
    .limit(1);

  const healthValues: Record<string, any> = {};
  if (input.targetCalories !== undefined) healthValues.targetCalories = input.targetCalories;
  if (input.targetProteinG !== undefined) healthValues.targetProteinG = String(input.targetProteinG);
  if (input.targetCarbsG !== undefined) healthValues.targetCarbsG = String(input.targetCarbsG);
  if (input.targetFatG !== undefined) healthValues.targetFatG = String(input.targetFatG);
  if (input.targetFiberG !== undefined) healthValues.targetFiberG = String(input.targetFiberG);
  if (input.targetSodiumMg !== undefined) healthValues.targetSodiumMg = input.targetSodiumMg;
  if (input.targetSugarG !== undefined) healthValues.targetSugarG = String(input.targetSugarG);

  if (existing[0] && Object.keys(healthValues).length > 0) {
    await db
      .update(b2cCustomerHealthProfiles)
      .set(healthValues)
      .where(eq(b2cCustomerHealthProfiles.b2cCustomerId, memberId));
  } else if (!existing[0]) {
    await db.insert(b2cCustomerHealthProfiles).values({
      b2cCustomerId: memberId,
      ...healthValues,
    });
  }

  if (input.allergenIds) {
    await db
      .delete(b2cCustomerAllergens)
      .where(eq(b2cCustomerAllergens.b2cCustomerId, memberId));
    if (input.allergenIds.length > 0) {
      await db.insert(b2cCustomerAllergens).values(
        input.allergenIds.map((allergenId) => ({
          b2cCustomerId: memberId,
          allergenId,
          isActive: true,
        }))
      );
    }
  }

  if (input.dietIds) {
    await db
      .delete(b2cCustomerDietaryPreferences)
      .where(eq(b2cCustomerDietaryPreferences.b2cCustomerId, memberId));
    if (input.dietIds.length > 0) {
      await db.insert(b2cCustomerDietaryPreferences).values(
        input.dietIds.map((dietId) => ({
          b2cCustomerId: memberId,
          dietId,
          isActive: true,
        }))
      );
    }
  }

  if (input.conditionIds) {
    await db
      .delete(b2cCustomerHealthConditions)
      .where(eq(b2cCustomerHealthConditions.b2cCustomerId, memberId));
    if (input.conditionIds.length > 0) {
      await db.insert(b2cCustomerHealthConditions).values(
        input.conditionIds.map((conditionId) => ({
          b2cCustomerId: memberId,
          conditionId,
          isActive: true,
        }))
      );
    }
  }

  return getMemberDetail(memberId);
}
