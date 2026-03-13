import { db } from "../config/database.js";
import { eq, and, ilike, sql, inArray } from "drizzle-orm";
import {
  householdPreferences,
  certifications,
  products,
  productCertifications,
  type Certification,
  type HouseholdPreference,
} from "../../shared/goldSchema.js";

// ── Types ───────────────────────────────────────────────────────────────────

export interface GroceryPreferences {
  certificationIds: string[];
  brands: { name: string; priority: number }[];
  mealsPerDay: number;
  daysPerWeek: number;
}

export interface UpdateGroceryPreferencesInput {
  certificationIds?: string[];
  brands?: { name: string; priority: number }[];
  mealsPerDay?: number;
  daysPerWeek?: number;
}

// ── Get all certifications (for UI) ─────────────────────────────────────────

export async function getAllCertifications(): Promise<Certification[]> {
  return db.select().from(certifications).orderBy(certifications.category, certifications.name);
}

// ── Get grocery preferences for a household ─────────────────────────────────

export async function getGroceryPreferences(
  householdId: string
): Promise<GroceryPreferences> {
  const rows = await db
    .select()
    .from(householdPreferences)
    .where(
      and(
        eq(householdPreferences.householdId, householdId),
        inArray(householdPreferences.preferenceType, [
          "certification",
          "brand",
          "meals_per_day",
          "days_per_week",
        ])
      )
    );

  const certificationIds: string[] = [];
  const brands: { name: string; priority: number }[] = [];
  let mealsPerDay = 3;
  let daysPerWeek = 7;

  for (const row of rows) {
    switch (row.preferenceType) {
      case "certification":
        if (row.preferenceValue) certificationIds.push(row.preferenceValue);
        break;
      case "brand":
        brands.push({
          name: row.preferenceValue ?? "",
          priority: row.priority ?? 1,
        });
        break;
      case "meals_per_day":
        mealsPerDay = parseInt(row.preferenceValue ?? "3", 10);
        break;
      case "days_per_week":
        daysPerWeek = parseInt(row.preferenceValue ?? "7", 10);
        break;
    }
  }

  brands.sort((a, b) => a.priority - b.priority);

  return { certificationIds, brands, mealsPerDay, daysPerWeek };
}

// ── Update grocery preferences (full replace in transaction) ────────────────

export async function updateGroceryPreferences(
  householdId: string,
  input: UpdateGroceryPreferencesInput
): Promise<GroceryPreferences> {
  await db.transaction(async (tx) => {
    // 1. Delete all existing grocery-related preferences for this household
    const prefTypes = ["certification", "brand", "meals_per_day", "days_per_week"];
    await tx
      .delete(householdPreferences)
      .where(
        and(
          eq(householdPreferences.householdId, householdId),
          inArray(householdPreferences.preferenceType, prefTypes)
        )
      );

    const rows: Array<{
      householdId: string;
      preferenceType: string;
      preferenceValue: string;
      priority: number | null;
    }> = [];

    // 2. Insert certification preferences
    if (input.certificationIds?.length) {
      for (const certId of input.certificationIds) {
        rows.push({
          householdId,
          preferenceType: "certification",
          preferenceValue: certId,
          priority: null,
        });
      }
    }

    // 3. Insert brand preferences with priority ordering
    if (input.brands?.length) {
      for (const brand of input.brands) {
        rows.push({
          householdId,
          preferenceType: "brand",
          preferenceValue: brand.name,
          priority: brand.priority,
        });
      }
    }

    // 4. Insert meal frequency preferences
    if (input.mealsPerDay !== undefined) {
      rows.push({
        householdId,
        preferenceType: "meals_per_day",
        preferenceValue: String(input.mealsPerDay),
        priority: null,
      });
    }

    if (input.daysPerWeek !== undefined) {
      rows.push({
        householdId,
        preferenceType: "days_per_week",
        preferenceValue: String(input.daysPerWeek),
        priority: null,
      });
    }

    if (rows.length > 0) {
      await tx.insert(householdPreferences).values(rows);
    }
  });

  return getGroceryPreferences(householdId);
}

// ── Search brands (autocomplete) ────────────────────────────────────────────

export async function searchBrands(
  query: string,
  limit: number = 20
): Promise<string[]> {
  const rows = await db
    .selectDistinct({ brand: products.brand })
    .from(products)
    .where(
      and(
        ilike(products.brand, `%${query}%`),
        eq(products.status, "active")
      )
    )
    .orderBy(products.brand)
    .limit(limit);

  return rows.map((r) => r.brand).filter(Boolean) as string[];
}

// ── Get cert categories for RAG pass-through ────────────────────────────────

export async function getCertCategoriesForPreferences(
  certificationIds: string[]
): Promise<string[]> {
  if (certificationIds.length === 0) return [];

  const rows = await db
    .selectDistinct({ category: certifications.category })
    .from(certifications)
    .where(inArray(certifications.id, certificationIds));

  return rows.map((r) => r.category).filter(Boolean) as string[];
}
