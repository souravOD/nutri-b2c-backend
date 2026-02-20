import { db, executeRaw } from "../config/database.js";
import {
  b2cCustomerDietaryPreferences,
  b2cCustomerAllergens,
  b2cCustomerHealthConditions,
} from "../../shared/goldSchema.js";
import { eq } from "drizzle-orm";

function normalizeKeys(values: string[]): string[] {
  const out: string[] = [];
  for (const raw of values ?? []) {
    const v = String(raw ?? "").trim();
    if (!v) continue;
    const lower = v.toLowerCase();
    out.push(lower);
    out.push(lower.replace(/\s+/g, "-"));
    out.push(lower.replace(/\s+/g, "_"));
    out.push(lower.replace(/-/g, " "));
    out.push(lower.replace(/_/g, " "));
  }
  return Array.from(new Set(out));
}

export async function resolveDietIds(input: string[]): Promise<string[]> {
  const keys = normalizeKeys(input);
  if (!keys.length) return [];
  const rows = await executeRaw(
    `
    select id
    from gold.dietary_preferences
    where lower(code) = any($1::text[])
       or lower(name) = any($1::text[])
    `,
    [keys]
  );
  return rows.map((r: any) => r.id);
}

export async function resolveAllergenIds(input: string[]): Promise<string[]> {
  const keys = normalizeKeys(input);
  if (!keys.length) return [];
  const rows = await executeRaw(
    `
    select id
    from gold.allergens
    where lower(code) = any($1::text[])
       or lower(name) = any($1::text[])
    `,
    [keys]
  );
  return rows.map((r: any) => r.id);
}

export async function resolveConditionIds(input: string[]): Promise<string[]> {
  const keys = normalizeKeys(input);
  if (!keys.length) return [];
  const rows = await executeRaw(
    `
    select id
    from gold.health_conditions
    where lower(code) = any($1::text[])
       or lower(name) = any($1::text[])
    `,
    [keys]
  );
  return rows.map((r: any) => r.id);
}

export async function resolveCuisineIds(input: string[]): Promise<string[]> {
  const keys = normalizeKeys(input);
  if (!keys.length) return [];
  const rows = await executeRaw(
    `
    select id
    from gold.cuisines
    where lower(code) = any($1::text[])
       or lower(name) = any($1::text[])
    `,
    [keys]
  );
  return rows.map((r: any) => r.id);
}

export async function replaceCustomerDiets(customerId: string, dietIds: string[]) {
  await db
    .delete(b2cCustomerDietaryPreferences)
    .where(eq(b2cCustomerDietaryPreferences.b2cCustomerId, customerId));
  if (!dietIds.length) return;
  await db.insert(b2cCustomerDietaryPreferences).values(
    dietIds.map((dietId) => ({
      b2cCustomerId: customerId,
      dietId,
      strictness: "moderate",
      isActive: true,
      createdAt: new Date(),
    }))
  );
}

export async function replaceCustomerAllergens(customerId: string, allergenIds: string[]) {
  await db
    .delete(b2cCustomerAllergens)
    .where(eq(b2cCustomerAllergens.b2cCustomerId, customerId));
  if (!allergenIds.length) return;
  await db.insert(b2cCustomerAllergens).values(
    allergenIds.map((allergenId) => ({
      b2cCustomerId: customerId,
      allergenId,
      isActive: true,
      createdAt: new Date(),
    }))
  );
}

export async function replaceCustomerConditions(customerId: string, conditionIds: string[]) {
  await db
    .delete(b2cCustomerHealthConditions)
    .where(eq(b2cCustomerHealthConditions.b2cCustomerId, customerId));
  if (!conditionIds.length) return;
  await db.insert(b2cCustomerHealthConditions).values(
    conditionIds.map((conditionId) => ({
      b2cCustomerId: customerId,
      conditionId,
      isActive: true,
      createdAt: new Date(),
    }))
  );
}
