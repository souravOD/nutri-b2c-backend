// server/services/memberPrefs.ts
// Household-aware member preference resolution for feed/search/chat personalization
// ─────────────────────────────────────────────────────────────────────────────

import { executeRaw } from "../config/database.js";

// ── Types ────────────────────────────────────────────────────────────────────

export interface MemberPrefs {
  dietIds: string[];
  allergenIds: string[];
  conditionIds: string[];
  dislikes: string[];
  dietNames: string[];        // Human-readable — for RAG profile
  allergenNames: string[];    // Human-readable — for RAG profile
  conditionNames: string[];   // Human-readable — for RAG profile
  healthGoal: string | null;
  activityLevel: string | null;
}

/**
 * Build a RAG-compatible member_profile dict from MemberPrefs.
 * Shape matches what fetch_customer_profile() returns in the RAG pipeline.
 */
export interface RagMemberProfile {
  diets: string[];
  allergens: string[];
  health_conditions: string[];
  health_goal: string | null;
  activity_level: string | null;
}

// ── Single Member Preferences ────────────────────────────────────────────────

/**
 * Resolve health preferences for a given b2c_customer_id.
 * Works for both primary users (with Appwrite account) and
 * dependents (children/teens without Appwrite account).
 *
 * @param memberId — gold.b2c_customers.id (NOT appwrite_id)
 */
export async function getMemberPrefs(memberId: string): Promise<MemberPrefs> {
  const rows = await executeRaw(
    `
    SELECT
      coalesce(array_remove(array_agg(DISTINCT cdp.diet_id), null), '{}'::uuid[])   AS diet_ids,
      coalesce(array_remove(array_agg(DISTINCT ca.allergen_id), null), '{}'::uuid[]) AS allergen_ids,
      coalesce(array_remove(array_agg(DISTINCT chc.condition_id), null), '{}'::uuid[]) AS condition_ids,
      coalesce(hp.disliked_ingredients, '{}'::text[])                               AS dislikes,
      coalesce(array_remove(array_agg(DISTINCT dp.name), null), '{}'::text[])       AS diet_names,
      coalesce(array_remove(array_agg(DISTINCT a.name), null), '{}'::text[])        AS allergen_names,
      coalesce(array_remove(array_agg(DISTINCT hc.name), null), '{}'::text[])       AS condition_names,
      hp.health_goal                                                                AS health_goal,
      hp.activity_level                                                             AS activity_level
    FROM gold.b2c_customers c
    LEFT JOIN gold.b2c_customer_dietary_preferences cdp
      ON c.id = cdp.b2c_customer_id AND cdp.is_active = true
    LEFT JOIN gold.dietary_preferences dp ON dp.id = cdp.diet_id
    LEFT JOIN gold.b2c_customer_allergens ca
      ON c.id = ca.b2c_customer_id AND ca.is_active = true
    LEFT JOIN gold.allergens a ON a.id = ca.allergen_id
    LEFT JOIN gold.b2c_customer_health_conditions chc
      ON c.id = chc.b2c_customer_id AND chc.is_active = true
    LEFT JOIN gold.health_conditions hc ON hc.id = chc.condition_id
    LEFT JOIN gold.b2c_customer_health_profiles hp
      ON c.id = hp.b2c_customer_id
    WHERE c.id = $1
    GROUP BY c.id, hp.disliked_ingredients, hp.health_goal, hp.activity_level
    `,
    [memberId]
  );

  if (!rows.length) {
    return {
      dietIds: [],
      allergenIds: [],
      conditionIds: [],
      dislikes: [],
      dietNames: [],
      allergenNames: [],
      conditionNames: [],
      healthGoal: null,
      activityLevel: null,
    };
  }

  const row = rows[0] as any;
  return {
    dietIds: row.diet_ids ?? [],
    allergenIds: row.allergen_ids ?? [],
    conditionIds: row.condition_ids ?? [],
    dislikes: row.dislikes ?? [],
    dietNames: row.diet_names ?? [],
    allergenNames: row.allergen_names ?? [],
    conditionNames: row.condition_names ?? [],
    healthGoal: row.health_goal ?? null,
    activityLevel: row.activity_level ?? null,
  };
}

/**
 * Convert MemberPrefs to the RAG-compatible member_profile dict.
 * This shape mirrors what the RAG pipeline's fetch_customer_profile() returns.
 */
export function toRagProfile(prefs: MemberPrefs): Record<string, unknown> {
  return {
    diets: prefs.dietNames,
    allergens: prefs.allergenNames,
    health_conditions: prefs.conditionNames,
    health_goal: prefs.healthGoal,
    activity_level: prefs.activityLevel,
  };
}

// ── Household Combined Preferences ──────────────────────────────────────────

/**
 * Get combined allergen/diet/condition profile for ALL household members.
 * Used when chatbot detects "for my family" intent (family_scope: "all").
 *
 * Strategy (strictest safe approach):
 *   - Allergens: UNION   — if ANY member is allergic → exclude
 *   - Diets: INTERSECTION — only diets shared by ALL members
 *   - Conditions: UNION  — respect all health conditions
 */
export async function getHouseholdCombinedPrefs(
  householdId: string
): Promise<MemberPrefs> {
  // Step 1: Get all member IDs in the household
  const memberRows = await executeRaw(
    `SELECT id FROM gold.b2c_customers WHERE household_id = $1`,
    [householdId]
  );
  const memberIds = (memberRows as any[]).map((r) => r.id);

  if (memberIds.length === 0) {
    return {
      dietIds: [], allergenIds: [], conditionIds: [], dislikes: [],
      dietNames: [], allergenNames: [], conditionNames: [],
      healthGoal: null, activityLevel: null,
    };
  }

  // Step 2: Get per-member prefs
  const allPrefs = await Promise.all(memberIds.map(getMemberPrefs));

  // Step 3: UNION allergens (strictest — if ANY member is allergic, exclude)
  const allergenIdSet = new Set<string>();
  const allergenNameSet = new Set<string>();
  for (const p of allPrefs) {
    p.allergenIds.forEach((id) => allergenIdSet.add(id));
    p.allergenNames.forEach((n) => allergenNameSet.add(n));
  }

  // Step 4: INTERSECTION diets (only diets ALL members follow)
  let dietIdSet: Set<string> | null = null;
  let dietNameSet: Set<string> | null = null;
  for (const p of allPrefs) {
    if (dietIdSet === null) {
      dietIdSet = new Set(p.dietIds);
      dietNameSet = new Set(p.dietNames);
    } else {
      const prevIds: string[] = Array.from(dietIdSet);
      dietIdSet = new Set(prevIds.filter((id) => p.dietIds.includes(id)));
      const prevNames: string[] = Array.from(dietNameSet!);
      dietNameSet = new Set(prevNames.filter((n) => p.dietNames.includes(n)));
    }
  }

  // Step 5: UNION conditions (strictest — respect all conditions)
  const conditionIdSet = new Set<string>();
  const conditionNameSet = new Set<string>();
  for (const p of allPrefs) {
    p.conditionIds.forEach((id) => conditionIdSet.add(id));
    p.conditionNames.forEach((n) => conditionNameSet.add(n));
  }

  // Step 6: UNION dislikes
  const dislikeSet = new Set<string>();
  for (const p of allPrefs) {
    p.dislikes.forEach((d) => dislikeSet.add(d));
  }

  return {
    allergenIds: [...allergenIdSet],
    allergenNames: [...allergenNameSet],
    dietIds: [...(dietIdSet ?? [])],
    dietNames: [...(dietNameSet ?? [])],
    conditionIds: [...conditionIdSet],
    conditionNames: [...conditionNameSet],
    dislikes: [...dislikeSet],
    healthGoal: null,
    activityLevel: null,
  };
}
