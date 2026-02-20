import { db } from "../config/database.js";
import {
  b2cCustomers,
  b2cCustomerHealthProfiles,
  b2cCustomerAllergens,
  b2cCustomerDietaryPreferences,
  b2cCustomerHealthConditions,
  households,
} from "../../shared/goldSchema.js";
import { eq } from "drizzle-orm";
import { getB2cCustomerByAppwriteId } from "./b2cIdentity.js";

function pickDefined(values: Record<string, any>) {
  const out: Record<string, any> = {};
  for (const [key, value] of Object.entries(values)) {
    if (value !== undefined) out[key] = value;
  }
  return out;
}

function coerceArray(value: any): string[] | undefined {
  if (value === undefined || value === null) return undefined;
  if (Array.isArray(value)) return value.filter(Boolean).map((v) => String(v));
  if (typeof value === "string") {
    return value
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
  }
  return undefined;
}

export async function upsertProfileFromAppwrite(params: {
  appwriteId: string;
  profile: {
    displayName?: string | null;
    imageUrl?: string | null;
    phone?: string | null;
    country?: string | null;
    email?: string | null;
  };
  account?: { email?: string | null; name?: string | null };
}) {
  const email = params.account?.email ?? params.profile?.email ?? null;
  const fullName =
    params.profile.displayName ??
    params.account?.name ??
    (email ? email.split("@")[0] : null) ??
    "User";

  const existing = await getB2cCustomerByAppwriteId(params.appwriteId);

  if (existing?.id) {
    await db
      .update(b2cCustomers)
      .set(pickDefined({
        fullName,
        email,
        phone: params.profile.phone ?? null,
        appwriteUserId: params.appwriteId,
        updatedAt: new Date(),
      }))
      .where(eq(b2cCustomers.id, existing.id));
  } else {
    // Create an individual household for the new customer
    const [household] = await db.insert(households).values({
      householdName: `${fullName}'s Household`,
      primaryAccountEmail: email ?? params.appwriteId,
      householdType: "individual",
      totalMembers: 1,
    }).returning({ id: households.id });

    await db.insert(b2cCustomers).values({
      email,
      fullName,
      phone: params.profile.phone ?? null,
      appwriteUserId: params.appwriteId,
      householdId: household.id,
      isProfileOwner: true,
      accountStatus: "active",
    });
  }
}

export async function upsertHealthFromAppwrite(params: {
  appwriteId: string;
  health: any;
}) {
  const hw = normalizeHW(params.health);
  const existing = await getB2cCustomerByAppwriteId(params.appwriteId);
  if (!existing?.id) {
    throw new Error("B2C customer mapping not found. Run profile sync first.");
  }

  // Update demographic info on the customer record (Gold stores these on b2c_customers)
  await db
    .update(b2cCustomers)
    .set(pickDefined({
      dateOfBirth: params.health.dateOfBirth ?? undefined,
      gender: params.health.sex ?? undefined,
      updatedAt: new Date(),
    }))
    .where(eq(b2cCustomers.id, existing.id));

  // Upsert health profile
  const profileRow = await db
    .select()
    .from(b2cCustomerHealthProfiles)
    .where(eq(b2cCustomerHealthProfiles.b2cCustomerId, existing.id))
    .limit(1);

  const healthFields = pickDefined({
    heightCm: hw.height_cm?.toString(),
    weightKg: hw.weight_kg?.toString(),
    activityLevel: params.health.activityLevel ?? undefined,
    healthGoal: params.health.goal ?? undefined,
    targetWeightKg: params.health.targetWeightKg?.toString() ?? undefined,
    targetCalories: params.health.targetCalories ?? undefined,
    targetProteinG: params.health.targetProteinG?.toString() ?? undefined,
    targetCarbsG: params.health.targetCarbsG?.toString() ?? undefined,
    targetFatG: params.health.targetFatG?.toString() ?? undefined,
    targetFiberG: params.health.targetFiberG?.toString() ?? undefined,
    targetSodiumMg: params.health.targetSodiumMg ?? undefined,
    targetSugarG: params.health.targetSugarG?.toString() ?? undefined,
    intolerances: coerceArray(params.health.intolerances),
    dislikedIngredients: coerceArray(params.health.dislikedIngredients),
    onboardingComplete: params.health.onboardingComplete ?? undefined,
  });

  if (profileRow.length > 0) {
    await db
      .update(b2cCustomerHealthProfiles)
      .set({ ...healthFields, updatedAt: new Date() })
      .where(eq(b2cCustomerHealthProfiles.b2cCustomerId, existing.id));
  } else {
    await db.insert(b2cCustomerHealthProfiles).values({
      b2cCustomerId: existing.id,
      ...healthFields,
    });
  }

  // Sync allergens to junction table
  const allergenIds = coerceArray(params.health.allergen_ids ?? params.health.allergenIds);
  if (allergenIds && allergenIds.length > 0) {
    await db.delete(b2cCustomerAllergens).where(eq(b2cCustomerAllergens.b2cCustomerId, existing.id));
    await db.insert(b2cCustomerAllergens).values(
      allergenIds.map((allergenId) => ({
        b2cCustomerId: existing.id,
        allergenId,
      }))
    );
  }

  // Sync dietary preferences to junction table
  const dietIds = coerceArray(params.health.diet_ids ?? params.health.dietIds);
  if (dietIds && dietIds.length > 0) {
    await db.delete(b2cCustomerDietaryPreferences).where(eq(b2cCustomerDietaryPreferences.b2cCustomerId, existing.id));
    await db.insert(b2cCustomerDietaryPreferences).values(
      dietIds.map((dietId) => ({
        b2cCustomerId: existing.id,
        dietId,
      }))
    );
  }

  // Sync health conditions to junction table
  const conditionIds = coerceArray(params.health.condition_ids ?? params.health.conditionIds);
  if (conditionIds && conditionIds.length > 0) {
    await db.delete(b2cCustomerHealthConditions).where(eq(b2cCustomerHealthConditions.b2cCustomerId, existing.id));
    await db.insert(b2cCustomerHealthConditions).values(
      conditionIds.map((conditionId) => ({
        b2cCustomerId: existing.id,
        conditionId,
      }))
    );
  }
}

function normalizeHW(h: any) {
  const parse = (v: any) => {
    if (!v) return { display: null, value: null, unit: null };
    if (typeof v === "string") {
      const m = v.trim().match(/^(\d+(?:\.\d+)?)\s*([a-zA-Z]+)$/);
      if (m) return { display: `${m[1]} ${m[2]}`, value: Number(m[1]), unit: m[2].toLowerCase() };
      return { display: v.trim(), value: null, unit: null };
    }
    if (typeof v === "object" && v.value != null && v.unit) {
      const num = Number(v.value); const unit = String(v.unit).toLowerCase();
      if (Number.isFinite(num)) return { display: `${num} ${unit}`, value: num, unit };
    }
    return { display: null, value: null, unit: null };
  };

  const hh = parse(h.height);
  const ww = parse(h.weight);

  const toCm = (val: number | null, unit: string | null) =>
    val == null ? null : unit === "ft" ? Math.round(val * 30.48 * 100) / 100 : unit === "cm" ? val : null;
  const toKg = (val: number | null, unit: string | null) =>
    val == null ? null : (unit === "lb" || unit === "lbs") ? Math.round(val * 0.45359237 * 1000) / 1000 : unit === "kg" ? val : null;

  return {
    height_cm: toCm(hh.value, hh.unit),
    weight_kg: toKg(ww.value, ww.unit),
  };
}
