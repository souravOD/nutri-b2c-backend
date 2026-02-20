import { and, asc, desc, eq } from "drizzle-orm";
import { db, executeRaw } from "../config/database.js";
import {
  b2cCustomerHealthProfiles,
  b2cCustomerWeightHistory,
  b2cCustomers,
  households,
  mealLogs,
} from "../../shared/goldSchema.js";
import { resolveMemberScope } from "./memberScope.js";
import {
  calculateNutrientGaps,
  computeBmr,
  computeTdee,
  computeWeightGoalProgress,
  convertUnit,
  dedupeSnapshotRows,
  n,
  round2,
  type SnapshotUpsertRow,
} from "./nutritionDashboardUtils.js";

type CuratedNutrientKey =
  | "calories"
  | "protein"
  | "carbs"
  | "fat"
  | "fiber"
  | "sugar"
  | "sodium"
  | "vitamin_d"
  | "calcium"
  | "iron"
  | "potassium";

interface CuratedNutrientConfig {
  key: CuratedNutrientKey;
  label: string;
  defaultTarget: number;
  defaultUnit: string;
  profileField?: keyof Pick<
    typeof b2cCustomerHealthProfiles.$inferSelect,
    | "targetCalories"
    | "targetProteinG"
    | "targetCarbsG"
    | "targetFatG"
    | "targetFiberG"
    | "targetSugarG"
    | "targetSodiumMg"
  >;
}

interface CuratedDefinition {
  nutrientId: string | null;
  nutrientName: string;
  unitName: string;
  recommendedDailyValue: number | null;
  rdvUnit: string | null;
}

const CURATED: CuratedNutrientConfig[] = [
  { key: "calories", label: "Calories", defaultTarget: 2000, defaultUnit: "kcal", profileField: "targetCalories" },
  { key: "protein", label: "Protein", defaultTarget: 50, defaultUnit: "g", profileField: "targetProteinG" },
  { key: "carbs", label: "Carbs", defaultTarget: 275, defaultUnit: "g", profileField: "targetCarbsG" },
  { key: "fat", label: "Fat", defaultTarget: 70, defaultUnit: "g", profileField: "targetFatG" },
  { key: "fiber", label: "Fiber", defaultTarget: 28, defaultUnit: "g", profileField: "targetFiberG" },
  { key: "sugar", label: "Sugar", defaultTarget: 50, defaultUnit: "g", profileField: "targetSugarG" },
  { key: "sodium", label: "Sodium", defaultTarget: 2300, defaultUnit: "mg", profileField: "targetSodiumMg" },
  { key: "vitamin_d", label: "Vitamin D", defaultTarget: 20, defaultUnit: "mcg" },
  { key: "calcium", label: "Calcium", defaultTarget: 1000, defaultUnit: "mg" },
  { key: "iron", label: "Iron", defaultTarget: 18, defaultUnit: "mg" },
  { key: "potassium", label: "Potassium", defaultTarget: 4700, defaultUnit: "mg" },
];

function ymd(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function addDays(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return ymd(d);
}

function pickDefinitionForKey(rows: any[], key: CuratedNutrientKey): any | null {
  const lowered = (value: string | null | undefined) => (value || "").trim().toLowerCase();
  const byCode = (row: any) => lowered(row.nutrient_code);
  const byName = (row: any) => lowered(row.nutrient_name);

  const match = (predicate: (row: any) => boolean) => rows.find(predicate) ?? null;

  switch (key) {
    case "calories":
      return (
        match((r) => ["energy", "calories", "kcal"].includes(byCode(r))) ??
        match((r) => byName(r).includes("energy"))
      );
    case "protein":
      return (
        match((r) => ["protein"].includes(byCode(r))) ??
        match((r) => byName(r) === "protein")
      );
    case "carbs":
      return (
        match((r) => ["carbohydrate", "carbs", "total_carbs"].includes(byCode(r))) ??
        match((r) => byName(r).includes("carbohydrate"))
      );
    case "fat":
      return (
        match((r) => ["fat", "total_fat"].includes(byCode(r))) ??
        match((r) => byName(r).includes("total fat"))
      );
    case "fiber":
      return (
        match((r) => ["fiber", "dietary_fiber"].includes(byCode(r))) ??
        match((r) => byName(r).includes("fiber"))
      );
    case "sugar":
      return (
        match((r) => ["sugar", "total_sugars"].includes(byCode(r))) ??
        match((r) => byName(r).includes("sugar"))
      );
    case "sodium":
      return (
        match((r) => ["sodium"].includes(byCode(r))) ??
        match((r) => byName(r).includes("sodium"))
      );
    case "vitamin_d":
      return match((r) => byName(r).includes("vitamin d"));
    case "calcium":
      return (
        match((r) => ["calcium"].includes(byCode(r))) ??
        match((r) => byName(r).includes("calcium"))
      );
    case "iron":
      return (
        match((r) => ["iron"].includes(byCode(r))) ??
        match((r) => byName(r) === "iron")
      );
    case "potassium":
      return (
        match((r) => ["potassium"].includes(byCode(r))) ??
        match((r) => byName(r).includes("potassium"))
      );
    default:
      return null;
  }
}

async function loadCuratedDefinitions(): Promise<Record<CuratedNutrientKey, CuratedDefinition>> {
  const rows = (await executeRaw(
    `SELECT
       id,
       nutrient_name,
       nutrient_code,
       unit_name,
       recommended_daily_value,
       rdv_unit
     FROM gold.nutrition_definitions`
  )) as any[];

  const out = {} as Record<CuratedNutrientKey, CuratedDefinition>;
  for (const cfg of CURATED) {
    const row = pickDefinitionForKey(rows, cfg.key);
    out[cfg.key] = {
      nutrientId: row?.id ?? null,
      nutrientName: row?.nutrient_name ?? cfg.label,
      unitName: (row?.unit_name || cfg.defaultUnit) as string,
      recommendedDailyValue:
        row?.recommended_daily_value == null ? null : n(row.recommended_daily_value),
      rdvUnit: row?.rdv_unit ?? null,
    };
  }
  return out;
}

function mapNutrientKeyFromName(name: string | null | undefined): CuratedNutrientKey | null {
  const v = (name || "").toLowerCase();
  if (!v) return null;
  if (v.includes("vitamin d")) return "vitamin_d";
  if (v.includes("potassium")) return "potassium";
  if (v.includes("calcium")) return "calcium";
  if (v.includes("iron")) return "iron";
  if (v.includes("sodium")) return "sodium";
  if (v.includes("sugar")) return "sugar";
  if (v.includes("fiber")) return "fiber";
  if (v.includes("carb")) return "carbs";
  if (v.includes("protein")) return "protein";
  if (v.includes("total fat") || v === "fat") return "fat";
  if (v.includes("energy") || v.includes("calories")) return "calories";
  return null;
}

function getFallbackAmountForKey(key: CuratedNutrientKey, row: any): number {
  switch (key) {
    case "calories":
      return n(row.calories);
    case "protein":
      return n(row.protein_g ?? row.proteinG);
    case "carbs":
      return n(row.total_carbs_g ?? row.totalCarbsG ?? row.carbs_g ?? row.carbsG);
    case "fat":
      return n(row.total_fat_g ?? row.totalFatG ?? row.fat_g ?? row.fatG);
    case "fiber":
      return n(row.dietary_fiber_g ?? row.dietaryFiberG ?? row.fiber_g ?? row.fiberG);
    case "sugar":
      return n(row.total_sugars_g ?? row.totalSugarsG ?? row.sugar_g ?? row.sugarG);
    case "sodium":
      return n(row.sodium_mg ?? row.sodiumMg);
    case "vitamin_d":
      return n(row.vitamin_d_mcg ?? row.vitaminDMcg);
    case "calcium":
      return n(row.calcium_mg ?? row.calciumMg);
    case "iron":
      return n(row.iron_mg ?? row.ironMg);
    case "potassium":
      return n(row.potassium_mg ?? row.potassiumMg);
    default:
      return 0;
  }
}

function estimateFactPerServing(row: any, servingSizeG: number): number {
  const amount = n(row.amount);
  if (amount <= 0) return 0;

  const perAmount = String(row.per_amount || "").toLowerCase();
  const perAmountGrams = n(row.per_amount_grams);
  if (perAmount.includes("serving")) return amount;
  if (perAmountGrams > 0 && servingSizeG > 0) {
    return amount * (servingSizeG / perAmountGrams);
  }
  if (perAmount.startsWith("100") && servingSizeG > 0) {
    return amount * (servingSizeG / 100);
  }
  return amount;
}

function getNutritionFromSnapshotOrFacts(params: {
  cfg: CuratedNutrientConfig;
  def: CuratedDefinition;
  item: any;
  recipeProfile?: any;
  productProfile?: any;
  factRow?: any;
}): number {
  const servings = Math.max(1, n(params.item.servings));
  const servingSizeG =
    n(params.item.serving_size_g) ||
    n(params.recipeProfile?.servingSizeG ?? params.recipeProfile?.serving_size_g) ||
    n(params.productProfile?.servingSizeG ?? params.productProfile?.serving_size_g) ||
    0;

  if (params.factRow) {
    const base = estimateFactPerServing(params.factRow, servingSizeG);
    return round2(convertUnit(base * servings, params.factRow.unit || params.cfg.defaultUnit, params.cfg.defaultUnit));
  }

  const source = params.recipeProfile ?? params.productProfile ?? params.item;
  const fallback = getFallbackAmountForKey(params.cfg.key, source) * servings;
  return round2(convertUnit(fallback, params.def.unitName || params.cfg.defaultUnit, params.cfg.defaultUnit));
}

function buildTargets(
  profile: typeof b2cCustomerHealthProfiles.$inferSelect | null,
  defs: Record<CuratedNutrientKey, CuratedDefinition>
): Record<CuratedNutrientKey, { value: number; unit: string }> {
  const targets = {} as Record<CuratedNutrientKey, { value: number; unit: string }>;
  for (const cfg of CURATED) {
    const profileValue = cfg.profileField && profile ? n(profile[cfg.profileField]) : 0;
    const def = defs[cfg.key];
    const rdv = def.recommendedDailyValue
      ? convertUnit(
          def.recommendedDailyValue,
          def.rdvUnit || def.unitName || cfg.defaultUnit,
          cfg.defaultUnit
        )
      : 0;
    const value = profileValue > 0 ? profileValue : rdv > 0 ? rdv : cfg.defaultTarget;
    targets[cfg.key] = { value: round2(value), unit: cfg.defaultUnit };
  }
  return targets;
}

async function ensureRecentNutrientSnapshots(
  memberId: string,
  startDate: string,
  endDate: string,
  defs: Record<CuratedNutrientKey, CuratedDefinition>
): Promise<void> {
  const cappedStart = startDate < addDays(endDate, -90) ? addDays(endDate, -90) : startDate;
  const nutrientIds = CURATED.map((cfg) => defs[cfg.key].nutrientId).filter(Boolean) as string[];
  if (nutrientIds.length === 0) return;

  const items = (await executeRaw(
    `SELECT
       mli.id,
       mli.recipe_id,
       mli.product_id,
       mli.servings,
       mli.serving_size_g,
       mli.calories,
       mli.protein_g,
       mli.carbs_g,
       mli.fat_g,
       mli.fiber_g,
       mli.sugar_g,
       mli.sodium_mg
     FROM gold.meal_log_items mli
     JOIN gold.meal_logs ml ON ml.id = mli.meal_log_id
     LEFT JOIN (
       SELECT meal_log_item_id, COUNT(*)::int AS nutrient_count
       FROM gold.meal_log_item_nutrients
       GROUP BY meal_log_item_id
     ) snap ON snap.meal_log_item_id = mli.id
     WHERE ml.b2c_customer_id = $1
       AND ml.log_date BETWEEN $2 AND $3
       AND COALESCE(snap.nutrient_count, 0) = 0
     LIMIT 500`,
    [memberId, cappedStart, endDate]
  )) as any[];

  if (items.length === 0) return;

  const recipeIds = Array.from(new Set(items.map((i) => i.recipe_id).filter(Boolean))) as string[];
  const productIds = Array.from(new Set(items.map((i) => i.product_id).filter(Boolean))) as string[];

  const recipeProfiles = recipeIds.length
    ? ((await executeRaw(
        `SELECT *
         FROM gold.recipe_nutrition_profiles
         WHERE recipe_id = ANY($1::uuid[])`,
        [recipeIds]
      )) as any[])
    : [];
  const productProfiles = productIds.length
    ? ((await executeRaw(
        `SELECT *
         FROM gold.products
         WHERE id = ANY($1::uuid[])`,
        [productIds]
      )) as any[])
    : [];

  const recipeMap = new Map<string, any>(recipeProfiles.map((r: any) => [r.recipeId ?? r.recipe_id, r]));
  const productMap = new Map<string, any>(productProfiles.map((p: any) => [p.id, p]));

  const factRows =
    recipeIds.length || productIds.length
      ? ((await executeRaw(
          `SELECT
             entity_type,
             entity_id,
             nutrient_id,
             amount,
             unit,
             per_amount,
             per_amount_grams
           FROM gold.nutrition_facts
           WHERE nutrient_id = ANY($1::uuid[])
             AND (
               (entity_type = 'recipe' AND entity_id = ANY($2::uuid[]))
               OR
               (entity_type = 'product' AND entity_id = ANY($3::uuid[]))
             )`,
          [nutrientIds, recipeIds.length ? recipeIds : ["00000000-0000-0000-0000-000000000000"], productIds.length ? productIds : ["00000000-0000-0000-0000-000000000000"]]
        )) as any[])
      : [];

  const factMap = new Map<string, any>();
  for (const row of factRows) {
    factMap.set(`${row.entity_type}:${row.entity_id}:${row.nutrient_id}`, row);
  }

  const rows: SnapshotUpsertRow[] = [];
  for (const item of items) {
    for (const cfg of CURATED) {
      const def = defs[cfg.key];
      if (!def.nutrientId) continue;
      const entityType = item.recipe_id ? "recipe" : item.product_id ? "product" : null;
      const entityId = item.recipe_id || item.product_id || null;
      const fact = entityType && entityId ? factMap.get(`${entityType}:${entityId}:${def.nutrientId}`) : undefined;

      const amount = getNutritionFromSnapshotOrFacts({
        cfg,
        def,
        item,
        recipeProfile: item.recipe_id ? recipeMap.get(item.recipe_id) : undefined,
        productProfile: item.product_id ? productMap.get(item.product_id) : undefined,
        factRow: fact,
      });

      if (amount <= 0) continue;
      rows.push({
        mealLogItemId: item.id,
        nutrientId: def.nutrientId,
        amount,
        unit: cfg.defaultUnit,
        source: fact ? "backfill" : "derived",
      });
    }
  }

  const deduped = dedupeSnapshotRows(rows);
  for (const row of deduped) {
    await executeRaw(
      `INSERT INTO gold.meal_log_item_nutrients (
         meal_log_item_id,
         nutrient_id,
         amount,
         unit,
         source
       ) VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (meal_log_item_id, nutrient_id)
       DO UPDATE SET
         amount = EXCLUDED.amount,
         unit = EXCLUDED.unit,
         source = EXCLUDED.source`,
      [row.mealLogItemId, row.nutrientId, row.amount, row.unit, row.source]
    );
  }
}

async function getDailyCore(memberId: string, date: string) {
  const rows = await db
    .select()
    .from(mealLogs)
    .where(and(eq(mealLogs.b2cCustomerId, memberId), eq(mealLogs.logDate, date)))
    .limit(1);
  return rows[0] ?? null;
}

async function getMemberProfile(memberId: string) {
  const rows = await db
    .select()
    .from(b2cCustomerHealthProfiles)
    .where(eq(b2cCustomerHealthProfiles.b2cCustomerId, memberId))
    .limit(1);
  return rows[0] ?? null;
}

async function getNutrientTotalsByKey(
  memberId: string,
  startDate: string,
  endDate: string,
  defs: Record<CuratedNutrientKey, CuratedDefinition>
): Promise<Record<CuratedNutrientKey, number>> {
  const rows = (await executeRaw(
    `SELECT
       mn.nutrient_id,
       nd.nutrient_name,
       SUM(mn.amount)::numeric AS amount
     FROM gold.meal_log_item_nutrients mn
     JOIN gold.meal_log_items mli ON mli.id = mn.meal_log_item_id
     JOIN gold.meal_logs ml ON ml.id = mli.meal_log_id
     LEFT JOIN gold.nutrition_definitions nd ON nd.id = mn.nutrient_id
     WHERE ml.b2c_customer_id = $1
       AND ml.log_date BETWEEN $2 AND $3
     GROUP BY mn.nutrient_id, nd.nutrient_name`,
    [memberId, startDate, endDate]
  )) as any[];

  const out = {} as Record<CuratedNutrientKey, number>;
  for (const cfg of CURATED) out[cfg.key] = 0;

  for (const row of rows) {
    const keyFromId = (CURATED.find((cfg) => defs[cfg.key].nutrientId === row.nutrient_id)?.key ?? null) as
      | CuratedNutrientKey
      | null;
    const key = keyFromId ?? mapNutrientKeyFromName(row.nutrient_name);
    if (!key) continue;
    out[key] = round2(out[key] + n(row.amount));
  }

  return out;
}

function buildDailyIntake(log: typeof mealLogs.$inferSelect | null, snapshots: Record<CuratedNutrientKey, number>) {
  const intake = { ...snapshots };
  intake.calories = round2(n(log?.totalCalories) || snapshots.calories);
  intake.protein = round2(n(log?.totalProteinG) || snapshots.protein);
  intake.carbs = round2(n(log?.totalCarbsG) || snapshots.carbs);
  intake.fat = round2(n(log?.totalFatG) || snapshots.fat);
  intake.fiber = round2(n(log?.totalFiberG) || snapshots.fiber);
  intake.sugar = round2(n(log?.totalSugarG) || snapshots.sugar);
  intake.sodium = round2(n(log?.totalSodiumMg) || snapshots.sodium);
  return intake;
}

async function buildConditionAlerts(
  memberId: string,
  intake: Record<CuratedNutrientKey, number>,
  defs: Record<CuratedNutrientKey, CuratedDefinition>
) {
  const rows = (await executeRaw(
    `SELECT
       hc.name AS condition_name,
       t.nutrient_name,
       t.nutrient_id,
       t.min_daily_mg,
       t.max_daily_mg,
       t.target_daily_mg
     FROM gold.b2c_customer_health_conditions chc
     JOIN gold.health_conditions hc ON hc.id = chc.condition_id
     JOIN gold.health_condition_nutrient_thresholds t ON t.condition_id = chc.condition_id
     WHERE chc.b2c_customer_id = $1
       AND chc.is_active = true`,
    [memberId]
  )) as any[];

  const alerts: Array<{
    conditionName: string;
    nutrient: string;
    intake: number;
    threshold: number;
    unit: string;
    direction: "high" | "low";
    message: string;
  }> = [];

  for (const row of rows) {
    const keyById = (CURATED.find((cfg) => defs[cfg.key].nutrientId === row.nutrient_id)?.key ?? null) as
      | CuratedNutrientKey
      | null;
    const key = keyById ?? mapNutrientKeyFromName(row.nutrient_name);
    if (!key) continue;

    const intakeInMg = convertUnit(intake[key] || 0, CURATED.find((c) => c.key === key)!.defaultUnit, "mg");
    const min = n(row.min_daily_mg);
    const max = n(row.max_daily_mg);
    if (max > 0 && intakeInMg > max) {
      alerts.push({
        conditionName: row.condition_name,
        nutrient: CURATED.find((c) => c.key === key)!.label,
        intake: round2(intakeInMg),
        threshold: round2(max),
        unit: "mg",
        direction: "high",
        message: `Intake is above condition threshold for ${row.condition_name}`,
      });
    } else if (min > 0 && intakeInMg < min) {
      alerts.push({
        conditionName: row.condition_name,
        nutrient: CURATED.find((c) => c.key === key)!.label,
        intake: round2(intakeInMg),
        threshold: round2(min),
        unit: "mg",
        direction: "low",
        message: `Intake is below condition threshold for ${row.condition_name}`,
      });
    }
  }

  return alerts;
}

export async function getNutritionDashboardDaily(input: {
  actorMemberId: string;
  date: string;
  memberId?: string;
}) {
  const scope = await resolveMemberScope(input.actorMemberId, input.memberId);
  const defs = await loadCuratedDefinitions();
  await ensureRecentNutrientSnapshots(scope.targetMemberId, input.date, input.date, defs);

  const [log, profile, memberRows, nutrientTotals, mealTypeCounts] = await Promise.all([
    getDailyCore(scope.targetMemberId, input.date),
    getMemberProfile(scope.targetMemberId),
    db
      .select({ id: b2cCustomers.id, fullName: b2cCustomers.fullName, householdRole: b2cCustomers.householdRole })
      .from(b2cCustomers)
      .where(eq(b2cCustomers.id, scope.targetMemberId))
      .limit(1),
    getNutrientTotalsByKey(scope.targetMemberId, input.date, input.date, defs),
    executeRaw(
      `SELECT mli.meal_type, COUNT(*)::int AS count
       FROM gold.meal_log_items mli
       JOIN gold.meal_logs ml ON ml.id = mli.meal_log_id
       WHERE ml.b2c_customer_id = $1
         AND ml.log_date = $2
       GROUP BY mli.meal_type`,
      [scope.targetMemberId, input.date]
    ) as Promise<any[]>,
  ]);

  const intake = buildDailyIntake(log, nutrientTotals);
  const targets = buildTargets(profile, defs);
  const gaps = calculateNutrientGaps(
    CURATED.map((cfg) => ({
      key: cfg.key,
      label: cfg.label,
      intake: intake[cfg.key],
      intakeUnit: cfg.defaultUnit,
      target: targets[cfg.key].value,
      targetUnit: cfg.defaultUnit,
    }))
  );
  const conditionAlerts = await buildConditionAlerts(scope.targetMemberId, intake, defs);

  const mealCounts: Record<string, number> = {
    breakfast: 0,
    lunch: 0,
    dinner: 0,
    snack: 0,
  };
  for (const row of mealTypeCounts) {
    mealCounts[row.meal_type] = Number(row.count) || 0;
  }

  return {
    date: input.date,
    member: {
      id: memberRows[0]?.id ?? scope.targetMemberId,
      name: memberRows[0]?.fullName ?? "Member",
      householdRole: memberRows[0]?.householdRole ?? null,
    },
    totals: {
      calories: intake.calories,
      proteinG: intake.protein,
      carbsG: intake.carbs,
      fatG: intake.fat,
      fiberG: intake.fiber,
      sugarG: intake.sugar,
      sodiumMg: intake.sodium,
      vitaminDMcg: intake.vitamin_d,
      calciumMg: intake.calcium,
      ironMg: intake.iron,
      potassiumMg: intake.potassium,
      waterMl: n(log?.waterMl),
    },
    targets: {
      calories: targets.calories.value,
      proteinG: targets.protein.value,
      carbsG: targets.carbs.value,
      fatG: targets.fat.value,
      fiberG: targets.fiber.value,
      sugarG: targets.sugar.value,
      sodiumMg: targets.sodium.value,
      vitaminDMcg: targets.vitamin_d.value,
      calciumMg: targets.calcium.value,
      ironMg: targets.iron.value,
      potassiumMg: targets.potassium.value,
      waterMl: n(log?.waterGoalMl) || 2500,
    },
    progress: {
      caloriesPct: round2((intake.calories / targets.calories.value) * 100),
      proteinPct: round2((intake.protein / targets.protein.value) * 100),
      carbsPct: round2((intake.carbs / targets.carbs.value) * 100),
      fatPct: round2((intake.fat / targets.fat.value) * 100),
    },
    meals: {
      itemCount: Object.values(mealCounts).reduce((a, b) => a + b, 0),
      byType: mealCounts,
    },
    nutrientGaps: gaps,
    conditionAlerts,
  };
}

export async function getNutritionDashboardWeekly(input: {
  actorMemberId: string;
  weekStart: string;
  memberId?: string;
}) {
  const scope = await resolveMemberScope(input.actorMemberId, input.memberId);
  const defs = await loadCuratedDefinitions();
  const weekEnd = addDays(input.weekStart, 6);
  await ensureRecentNutrientSnapshots(scope.targetMemberId, input.weekStart, weekEnd, defs);

  const [profile, rows, nutrientTotals] = await Promise.all([
    getMemberProfile(scope.targetMemberId),
    executeRaw(
      `SELECT
         log_date,
         total_calories,
         total_protein_g,
         total_carbs_g,
         total_fat_g,
         total_fiber_g,
         total_sugar_g,
         total_sodium_mg
       FROM gold.meal_logs
       WHERE b2c_customer_id = $1
         AND log_date BETWEEN $2 AND $3
       ORDER BY log_date`,
      [scope.targetMemberId, input.weekStart, weekEnd]
    ) as Promise<any[]>,
    getNutrientTotalsByKey(scope.targetMemberId, input.weekStart, weekEnd, defs),
  ]);

  const byDate = new Map<string, any>();
  for (const row of rows) byDate.set(row.log_date, row);

  const days: Array<{
    date: string;
    calories: number;
    proteinG: number;
    carbsG: number;
    fatG: number;
    fiberG: number;
    sugarG: number;
    sodiumMg: number;
  }> = [];
  for (let i = 0; i < 7; i += 1) {
    const date = addDays(input.weekStart, i);
    const row = byDate.get(date);
    days.push({
      date,
      calories: n(row?.total_calories),
      proteinG: n(row?.total_protein_g),
      carbsG: n(row?.total_carbs_g),
      fatG: n(row?.total_fat_g),
      fiberG: n(row?.total_fiber_g),
      sugarG: n(row?.total_sugar_g),
      sodiumMg: n(row?.total_sodium_mg),
    });
  }

  const totals = days.reduce(
    (acc, d) => {
      acc.calories += d.calories;
      acc.proteinG += d.proteinG;
      acc.carbsG += d.carbsG;
      acc.fatG += d.fatG;
      acc.fiberG += d.fiberG;
      acc.sugarG += d.sugarG;
      acc.sodiumMg += d.sodiumMg;
      return acc;
    },
    { calories: 0, proteinG: 0, carbsG: 0, fatG: 0, fiberG: 0, sugarG: 0, sodiumMg: 0 }
  );

  const targets = buildTargets(profile, defs);
  const avgIntake: Record<CuratedNutrientKey, number> = {
    calories: round2(totals.calories / 7),
    protein: round2(totals.proteinG / 7),
    carbs: round2(totals.carbsG / 7),
    fat: round2(totals.fatG / 7),
    fiber: round2(totals.fiberG / 7),
    sugar: round2(totals.sugarG / 7),
    sodium: round2(totals.sodiumMg / 7),
    vitamin_d: round2((nutrientTotals.vitamin_d || 0) / 7),
    calcium: round2((nutrientTotals.calcium || 0) / 7),
    iron: round2((nutrientTotals.iron || 0) / 7),
    potassium: round2((nutrientTotals.potassium || 0) / 7),
  };

  const nutrientGaps = calculateNutrientGaps(
    CURATED.map((cfg) => ({
      key: cfg.key,
      label: cfg.label,
      intake: avgIntake[cfg.key],
      intakeUnit: cfg.defaultUnit,
      target: targets[cfg.key].value,
      targetUnit: cfg.defaultUnit,
    }))
  );

  const targetCalories = targets.calories.value;
  const compliantDays = days.filter(
    (d) => targetCalories > 0 && d.calories >= targetCalories * 0.8 && d.calories <= targetCalories * 1.1
  ).length;
  const loggedDays = days.filter((d) => d.calories > 0).length;

  return {
    weekStart: input.weekStart,
    weekEnd,
    days,
    averages: {
      calories: round2(totals.calories / 7),
      proteinG: round2(totals.proteinG / 7),
      carbsG: round2(totals.carbsG / 7),
      fatG: round2(totals.fatG / 7),
      fiberG: round2(totals.fiberG / 7),
      sugarG: round2(totals.sugarG / 7),
      sodiumMg: round2(totals.sodiumMg / 7),
      vitaminDMcg: avgIntake.vitamin_d,
      calciumMg: avgIntake.calcium,
      ironMg: avgIntake.iron,
      potassiumMg: avgIntake.potassium,
    },
    compliance: {
      loggedDays,
      calorieGoalDays: compliantDays,
      calorieGoalPct: round2((compliantDays / 7) * 100),
    },
    nutrientGaps,
  };
}

export async function getNutritionMemberSummary(input: {
  actorMemberId: string;
  date: string;
}) {
  const scope = await resolveMemberScope(input.actorMemberId);
  const rows = (await executeRaw(
    `SELECT
       c.id,
       c.full_name,
       c.household_role,
       ml.total_calories,
       hp.target_calories,
       (SELECT COUNT(*)::int
        FROM gold.meal_log_items mli
        WHERE mli.meal_log_id = ml.id) AS item_count
     FROM gold.b2c_customers c
     LEFT JOIN gold.meal_logs ml
       ON ml.b2c_customer_id = c.id
      AND ml.log_date = $2
     LEFT JOIN gold.b2c_customer_health_profiles hp
       ON hp.b2c_customer_id = c.id
     WHERE c.household_id = $1
     ORDER BY c.is_profile_owner DESC, c.created_at`,
    [scope.householdId, input.date]
  )) as any[];

  return {
    date: input.date,
    members: rows.map((row) => {
      const calories = n(row.total_calories);
      const target = n(row.target_calories);
      const pct = target > 0 ? round2((calories / target) * 100) : 0;
      let status: "ok" | "under" | "over" | "no_data" = "no_data";
      if (calories > 0 && target > 0) {
        if (pct < 80) status = "under";
        else if (pct > 110) status = "over";
        else status = "ok";
      } else if (calories > 0) {
        status = "ok";
      }

      return {
        memberId: row.id,
        name: row.full_name,
        householdRole: row.household_role,
        calories,
        targetCalories: target || null,
        progressPct: pct,
        itemCount: Number(row.item_count) || 0,
        status,
      };
    }),
  };
}

export async function getNutritionHealthMetrics(input: {
  actorMemberId: string;
  memberId?: string;
}) {
  const scope = await resolveMemberScope(input.actorMemberId, input.memberId);
  const [memberRows, profile, weightRows, oldestWeightRows] = await Promise.all([
    db
      .select({
        id: b2cCustomers.id,
        fullName: b2cCustomers.fullName,
        age: b2cCustomers.age,
        gender: b2cCustomers.gender,
      })
      .from(b2cCustomers)
      .where(eq(b2cCustomers.id, scope.targetMemberId))
      .limit(1),
    getMemberProfile(scope.targetMemberId),
    db
      .select()
      .from(b2cCustomerWeightHistory)
      .where(eq(b2cCustomerWeightHistory.b2cCustomerId, scope.targetMemberId))
      .orderBy(desc(b2cCustomerWeightHistory.recordedAt))
      .limit(30),
    db
      .select()
      .from(b2cCustomerWeightHistory)
      .where(eq(b2cCustomerWeightHistory.b2cCustomerId, scope.targetMemberId))
      .orderBy(asc(b2cCustomerWeightHistory.recordedAt))
      .limit(1),
  ]);

  const member = memberRows[0];
  const currentWeight = n(profile?.weightKg) || n(weightRows[0]?.weightKg);
  const currentBmi =
    n(profile?.bmi) > 0
      ? round2(n(profile?.bmi))
      : n(profile?.heightCm) > 0 && currentWeight > 0
        ? round2(currentWeight / ((n(profile?.heightCm) / 100) ** 2))
        : null;

  const bmr = n(profile?.bmr) > 0 ? round2(n(profile?.bmr)) : computeBmr(currentWeight, n(profile?.heightCm), member?.age, member?.gender);
  const tdee = n(profile?.tdee) > 0 ? round2(n(profile?.tdee)) : computeTdee(bmr, profile?.activityLevel);

  const startWeight = n(oldestWeightRows[0]?.weightKg) || currentWeight;
  const targetWeight = n(profile?.targetWeightKg) || 0;
  const goalProgressPct = computeWeightGoalProgress(startWeight, currentWeight, targetWeight || null);

  const trend = [...weightRows]
    .reverse()
    .map((row) => ({
      date: row.recordedAt ? ymd(new Date(row.recordedAt)) : ymd(new Date()),
      value: round2(n(row.weightKg)),
    }));

  return {
    member: {
      id: member?.id ?? scope.targetMemberId,
      name: member?.fullName ?? "Member",
      age: member?.age ?? null,
      gender: member?.gender ?? null,
    },
    bmi: currentBmi,
    bmr,
    tdee,
    weight: {
      currentKg: currentWeight || null,
      startKg: startWeight || null,
      targetKg: targetWeight || null,
      progressPct: goalProgressPct,
      changeKg: startWeight > 0 && currentWeight > 0 ? round2(currentWeight - startWeight) : null,
      trend,
    },
    activityLevel: profile?.activityLevel ?? null,
    healthGoal: profile?.healthGoal ?? null,
  };
}

export async function getHouseholdTimezone(actorMemberId: string): Promise<string> {
  const scope = await resolveMemberScope(actorMemberId);
  const rows = await db
    .select({ timezone: households.timezone })
    .from(households)
    .where(eq(households.id, scope.householdId))
    .limit(1);
  return rows[0]?.timezone || "UTC";
}
