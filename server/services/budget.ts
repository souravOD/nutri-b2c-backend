import OpenAI from "openai";
import { and, desc, eq, ne } from "drizzle-orm";
import { db, executeRaw } from "../config/database.js";
import { householdBudgets } from "../../shared/goldSchema.js";
import { getOrCreateHousehold } from "./household.js";
import {
  type BudgetPeriod,
  type BudgetRecommendation,
  type BudgetType,
  buildRuleBasedRecommendations,
  getCurrentBudgetWindow,
  getRecentBudgetWindows,
  getUtilizationPct,
  mergeRecommendations,
  n,
  normalizeTimeZone,
  round2,
} from "./budgetUtils.js";

type SupportedCurrency = "USD";

export interface BudgetRecordDto {
  id: string;
  householdId: string;
  budgetType: BudgetType;
  amount: number;
  currency: SupportedCurrency;
  period: BudgetPeriod;
  startDate: string | null;
  endDate: string | null;
  isActive: boolean;
  createdAt: string | null;
  updatedAt: string | null;
}

export interface BudgetSnapshotResponse {
  budget: BudgetRecordDto | null;
  window: {
    period: BudgetPeriod;
    timezone: string;
    startAt: string;
    endAt: string;
    startDate: string;
    endDate: string;
  };
  spent: number;
  remaining: number | null;
  utilizationPct: number | null;
  breakdown: Array<{
    category: string;
    amount: number;
    pct: number;
    itemCount: number;
  }>;
  planVsActual: {
    mealPlanId: string;
    planName: string | null;
    estimated: number;
    actual: number;
    difference: number;
    differencePct: number | null;
  } | null;
  metadata: {
    unpricedPurchasedItems: number;
  };
}

export interface GetBudgetSnapshotInput {
  period: BudgetPeriod;
  budgetType: BudgetType;
}

export interface CreateBudgetInput {
  amount: number;
  period: BudgetPeriod;
  budgetType: BudgetType;
  currency?: SupportedCurrency;
  startDate?: string | null;
  endDate?: string | null;
}

export interface UpdateBudgetInput {
  amount?: number;
  period?: BudgetPeriod;
  startDate?: string | null;
  endDate?: string | null;
}

export interface GetBudgetTrendsInput {
  period: BudgetPeriod;
  budgetType: BudgetType;
  points: number;
}

export interface GetBudgetRecommendationsInput {
  period: BudgetPeriod;
  budgetType: BudgetType;
}

function normalizeBudgetRecord(row: any): BudgetRecordDto {
  return {
    id: row.id,
    householdId: row.householdId ?? row.household_id,
    budgetType: (row.budgetType ?? row.budget_type ?? "grocery") as BudgetType,
    amount: round2(n(row.amount)),
    currency: ((row.currency ?? "USD") as string).toUpperCase() as SupportedCurrency,
    period: (row.period ?? "weekly") as BudgetPeriod,
    startDate: row.startDate ?? row.start_date ?? null,
    endDate: row.endDate ?? row.end_date ?? null,
    isActive: Boolean(row.isActive ?? row.is_active),
    createdAt: row.createdAt
      ? new Date(row.createdAt).toISOString()
      : row.created_at
        ? new Date(row.created_at).toISOString()
        : null,
    updatedAt: row.updatedAt
      ? new Date(row.updatedAt).toISOString()
      : row.updated_at
        ? new Date(row.updated_at).toISOString()
        : null,
  };
}

function toSqlTimestamp(date: Date): string {
  return date.toISOString().replace("T", " ").slice(0, 19);
}

async function getActiveBudget(
  householdId: string,
  budgetType: BudgetType,
  period: BudgetPeriod
): Promise<BudgetRecordDto | null> {
  const rows = await db
    .select()
    .from(householdBudgets)
    .where(
      and(
        eq(householdBudgets.householdId, householdId),
        eq(householdBudgets.budgetType, budgetType),
        eq(householdBudgets.period, period),
        eq(householdBudgets.isActive, true)
      )
    )
    .orderBy(desc(householdBudgets.createdAt))
    .limit(1);

  if (!rows[0]) return null;
  return normalizeBudgetRecord(rows[0]);
}

async function requireBudgetForHousehold(householdId: string, budgetId: string) {
  const rows = await db
    .select()
    .from(householdBudgets)
    .where(and(eq(householdBudgets.id, budgetId), eq(householdBudgets.householdId, householdId)))
    .limit(1);

  if (!rows[0]) {
    const err = new Error("Budget not found");
    (err as any).status = 404;
    throw err;
  }

  return rows[0];
}

function coerceUsdCurrency(input?: string | null): SupportedCurrency {
  const currency = (input ?? "USD").toUpperCase();
  if (currency !== "USD") {
    const err = new Error("Only USD budgets are supported in this release");
    (err as any).status = 422;
    throw err;
  }
  return "USD";
}

function maybeParseDate(value: string | null | undefined): string | null {
  if (value == null) return null;
  const parsed = Date.parse(`${value}T00:00:00Z`);
  if (!Number.isFinite(parsed)) {
    const err = new Error("Invalid date format; expected YYYY-MM-DD");
    (err as any).status = 422;
    throw err;
  }
  return value;
}

async function getSpendingBreakdown(
  householdId: string,
  startAt: Date,
  endAt: Date
): Promise<Array<{ category: string; amount: number; itemCount: number }>> {
  const rows = (await executeRaw(
    `
    SELECT
      COALESCE(NULLIF(TRIM(sli.category), ''), pc.name, 'Other') AS category,
      COALESCE(SUM(sli.actual_price), 0)::numeric(12,2) AS amount,
      COUNT(*)::int AS item_count
    FROM gold.shopping_list_items sli
    JOIN gold.shopping_lists sl ON sl.id = sli.shopping_list_id
    LEFT JOIN gold.products p ON p.id = COALESCE(sli.substituted_product_id, sli.product_id)
    LEFT JOIN gold.product_categories pc ON pc.id = p.category_id
    WHERE sl.household_id = $1
      AND sli.is_purchased = true
      AND sli.actual_price IS NOT NULL
      AND sli.purchased_at >= $2
      AND sli.purchased_at < $3
    GROUP BY 1
    ORDER BY amount DESC
    `,
    [householdId, toSqlTimestamp(startAt), toSqlTimestamp(endAt)]
  )) as any[];

  return rows.map((row) => ({
    category: row.category || "Other",
    amount: round2(n(row.amount)),
    itemCount: Number(row.item_count) || 0,
  }));
}

async function getTotalSpent(householdId: string, startAt: Date, endAt: Date): Promise<number> {
  const rows = (await executeRaw(
    `
    SELECT COALESCE(SUM(sli.actual_price), 0)::numeric(12,2) AS spent
    FROM gold.shopping_list_items sli
    JOIN gold.shopping_lists sl ON sl.id = sli.shopping_list_id
    WHERE sl.household_id = $1
      AND sli.is_purchased = true
      AND sli.actual_price IS NOT NULL
      AND sli.purchased_at >= $2
      AND sli.purchased_at < $3
    `,
    [householdId, toSqlTimestamp(startAt), toSqlTimestamp(endAt)]
  )) as any[];

  return round2(n(rows[0]?.spent));
}

async function getUnpricedPurchasedCount(householdId: string, startAt: Date, endAt: Date): Promise<number> {
  const rows = (await executeRaw(
    `
    SELECT COUNT(*)::int AS count
    FROM gold.shopping_list_items sli
    JOIN gold.shopping_lists sl ON sl.id = sli.shopping_list_id
    WHERE sl.household_id = $1
      AND sli.is_purchased = true
      AND sli.actual_price IS NULL
      AND sli.purchased_at >= $2
      AND sli.purchased_at < $3
    `,
    [householdId, toSqlTimestamp(startAt), toSqlTimestamp(endAt)]
  )) as any[];

  return Number(rows[0]?.count) || 0;
}

async function getActivePlanVsActual(householdId: string) {
  const activePlanRows = (await executeRaw(
    `
    SELECT id, plan_name
    FROM gold.meal_plans
    WHERE household_id = $1
      AND status = 'active'
    ORDER BY updated_at DESC, created_at DESC
    LIMIT 1
    `,
    [householdId]
  )) as any[];

  const activePlan = activePlanRows[0];
  if (!activePlan) return null;

  const estimatedRows = (await executeRaw(
    `
    SELECT COALESCE(SUM(estimated_cost), 0)::numeric(12,2) AS estimated
    FROM gold.meal_plan_items
    WHERE meal_plan_id = $1
      AND COALESCE(status, 'planned') <> 'skipped'
    `,
    [activePlan.id]
  )) as any[];

  const actualRows = (await executeRaw(
    `
    SELECT COALESCE(SUM(sli.actual_price), 0)::numeric(12,2) AS actual
    FROM gold.shopping_list_items sli
    JOIN gold.shopping_lists sl ON sl.id = sli.shopping_list_id
    WHERE sl.household_id = $1
      AND sl.meal_plan_id = $2
      AND sli.is_purchased = true
      AND sli.actual_price IS NOT NULL
    `,
    [householdId, activePlan.id]
  )) as any[];

  const estimated = round2(n(estimatedRows[0]?.estimated));
  const actual = round2(n(actualRows[0]?.actual));
  const difference = round2(actual - estimated);
  const differencePct = estimated > 0 ? round2((difference / estimated) * 100) : null;

  return {
    mealPlanId: activePlan.id as string,
    planName: (activePlan.plan_name as string | null) ?? null,
    estimated,
    actual,
    difference,
    differencePct,
  };
}

async function getSubstitutionOpportunities(
  householdId: string,
  startAt: Date,
  endAt: Date
): Promise<{ count: number; potentialSavings: number }> {
  const rows = (await executeRaw(
    `
    WITH purchased_items AS (
      SELECT COALESCE(sli.substituted_product_id, sli.product_id) AS current_product_id
      FROM gold.shopping_list_items sli
      JOIN gold.shopping_lists sl ON sl.id = sli.shopping_list_id
      WHERE sl.household_id = $1
        AND sli.is_purchased = true
        AND sli.actual_price IS NOT NULL
        AND sli.purchased_at >= $2
        AND sli.purchased_at < $3
        AND COALESCE(sli.substituted_product_id, sli.product_id) IS NOT NULL
    ),
    cheapest_sub AS (
      SELECT
        pi.current_product_id,
        cp.price AS current_price,
        cp.currency AS current_currency,
        (
          SELECT p2.price
          FROM gold.product_substitutions ps
          JOIN gold.products p2 ON p2.id = ps.substitute_product_id
          WHERE ps.original_product_id = pi.current_product_id
            AND p2.price IS NOT NULL
            AND p2.currency = 'USD'
          ORDER BY p2.price ASC
          LIMIT 1
        ) AS cheapest_price
      FROM purchased_items pi
      JOIN gold.products cp ON cp.id = pi.current_product_id
      WHERE cp.price IS NOT NULL
        AND cp.currency = 'USD'
    )
    SELECT
      COUNT(*) FILTER (
        WHERE cheapest_price IS NOT NULL
          AND current_price > cheapest_price
      )::int AS opportunity_count,
      COALESCE(SUM(
        CASE
          WHEN cheapest_price IS NOT NULL AND current_price > cheapest_price
          THEN current_price - cheapest_price
          ELSE 0
        END
      ), 0)::numeric(12,2) AS potential_savings
    FROM cheapest_sub
    `,
    [householdId, toSqlTimestamp(startAt), toSqlTimestamp(endAt)]
  )) as any[];

  return {
    count: Number(rows[0]?.opportunity_count) || 0,
    potentialSavings: round2(n(rows[0]?.potential_savings)),
  };
}

async function enrichRecommendationsWithLLM(
  ruleTips: BudgetRecommendation[],
  snapshot: BudgetSnapshotResponse
): Promise<BudgetRecommendation[] | null> {
  const apiKey = process.env.LITELLM_API_KEY || process.env.LITELLM_API_KEY_MINI;
  const baseUrl = process.env.LITELLM_BASE_URL;
  const model = process.env.LLM_MODEL || "gpt-4o-mini";
  if (!apiKey || !baseUrl) return null;

  const client = new OpenAI({ apiKey, baseURL: baseUrl });

  try {
    const response = await client.chat.completions.create({
      model,
      temperature: 0.2,
      response_format: { type: "json_object" },
      messages: [
        {
          role: "system",
          content:
            "You are a budget coach. Return concise JSON only. Preserve factual amounts. Do not invent currencies.",
        },
        {
          role: "user",
          content: JSON.stringify({
            spent: snapshot.spent,
            remaining: snapshot.remaining,
            utilizationPct: snapshot.utilizationPct,
            breakdown: snapshot.breakdown.slice(0, 5),
            planVsActual: snapshot.planVsActual,
            rules: ruleTips,
            schema: {
              tips: [
                {
                  id: "string",
                  title: "string",
                  description: "string",
                  severity: "info|warning|critical",
                  potentialSavings: "number|null",
                },
              ],
            },
          }),
        },
      ],
    }, { timeout: 8_000 });

    const content = response.choices[0]?.message?.content;
    if (!content) return null;
    const parsed = JSON.parse(content) as { tips?: any[] };
    if (!Array.isArray(parsed.tips) || parsed.tips.length === 0) return null;

    return parsed.tips
      .map((tip, idx) => ({
        id: String(tip.id || `llm-${idx + 1}`),
        title: String(tip.title || "").trim(),
        description: String(tip.description || "").trim(),
        severity: (["info", "warning", "critical"].includes(String(tip.severity))
          ? tip.severity
          : "info") as "info" | "warning" | "critical",
        potentialSavings: tip.potentialSavings == null ? null : round2(n(tip.potentialSavings)),
        source: "llm" as const,
      }))
      .filter((tip) => tip.title && tip.description);
  } catch {
    return null;
  }
}

export async function getBudgetSnapshot(
  b2cCustomerId: string,
  input: GetBudgetSnapshotInput
): Promise<BudgetSnapshotResponse> {
  const startedAt = Date.now();
  const household = await getOrCreateHousehold(b2cCustomerId);
  const timezone = normalizeTimeZone((household as any).timezone);
  const window = getCurrentBudgetWindow(input.period, timezone);

  const [budget, spent, breakdown, planVsActual, unpricedPurchasedItems] = await Promise.all([
    getActiveBudget(household.id, input.budgetType, input.period),
    getTotalSpent(household.id, window.startUtc, window.endUtc),
    getSpendingBreakdown(household.id, window.startUtc, window.endUtc),
    getActivePlanVsActual(household.id),
    getUnpricedPurchasedCount(household.id, window.startUtc, window.endUtc),
  ]);

  const remaining = budget ? round2(budget.amount - spent) : null;
  const utilizationPct = getUtilizationPct(spent, budget?.amount ?? null);

  const breakdownWithPct = breakdown.map((item) => ({
    ...item,
    pct: spent > 0 ? round2((item.amount / spent) * 100) : 0,
  }));

  const response: BudgetSnapshotResponse = {
    budget,
    window: {
      period: input.period,
      timezone,
      startAt: window.startUtc.toISOString(),
      endAt: window.endUtc.toISOString(),
      startDate: window.startDateLocal,
      endDate: window.endDateLocal,
    },
    spent,
    remaining,
    utilizationPct,
    breakdown: breakdownWithPct,
    planVsActual,
    metadata: {
      unpricedPurchasedItems,
    },
  };

  console.log("[Budget] snapshot", {
    householdId: household.id,
    period: input.period,
    budgetType: input.budgetType,
    durationMs: Date.now() - startedAt,
  });

  return response;
}

export async function createOrReplaceActiveBudget(
  b2cCustomerId: string,
  input: CreateBudgetInput
): Promise<{ budget: BudgetRecordDto }> {
  const household = await getOrCreateHousehold(b2cCustomerId);
  const currency = coerceUsdCurrency(input.currency);
  const startDate = maybeParseDate(input.startDate);
  const endDate = maybeParseDate(input.endDate);

  const created = await db.transaction(async (tx) => {
    await tx
      .update(householdBudgets)
      .set({ isActive: false })
      .where(
        and(
          eq(householdBudgets.householdId, household.id),
          eq(householdBudgets.budgetType, input.budgetType),
          eq(householdBudgets.period, input.period),
          eq(householdBudgets.isActive, true)
        )
      );

    const rows = await tx
      .insert(householdBudgets)
      .values({
        householdId: household.id,
        budgetType: input.budgetType,
        amount: String(round2(input.amount)),
        currency,
        period: input.period,
        startDate,
        endDate,
        isActive: true,
      })
      .returning();

    return rows[0];
  });

  return { budget: normalizeBudgetRecord(created) };
}

export async function updateBudget(
  b2cCustomerId: string,
  budgetId: string,
  input: UpdateBudgetInput
): Promise<{ budget: BudgetRecordDto }> {
  const household = await getOrCreateHousehold(b2cCustomerId);
  const current = await requireBudgetForHousehold(household.id, budgetId);

  const nextPeriod = input.period ?? (current.period as BudgetPeriod);
  const startDate = input.startDate === undefined ? current.startDate : maybeParseDate(input.startDate);
  const endDate = input.endDate === undefined ? current.endDate : maybeParseDate(input.endDate);

  const setValues: Record<string, any> = {};
  if (input.amount !== undefined) setValues.amount = String(round2(input.amount));
  if (input.period !== undefined) setValues.period = input.period;
  if (input.startDate !== undefined) setValues.startDate = startDate;
  if (input.endDate !== undefined) setValues.endDate = endDate;

  if (Object.keys(setValues).length === 0) {
    const err = new Error("At least one field is required");
    (err as any).status = 400;
    throw err;
  }

  const updated = await db.transaction(async (tx) => {
    if (current.isActive) {
      await tx
        .update(householdBudgets)
        .set({ isActive: false })
        .where(
          and(
            eq(householdBudgets.householdId, household.id),
            eq(householdBudgets.budgetType, (current.budgetType as BudgetType) || "grocery"),
            eq(householdBudgets.period, nextPeriod),
            eq(householdBudgets.isActive, true),
            ne(householdBudgets.id, budgetId)
          )
        );
    }

    const rows = await tx
      .update(householdBudgets)
      .set(setValues)
      .where(eq(householdBudgets.id, budgetId))
      .returning();

    return rows[0];
  });

  return { budget: normalizeBudgetRecord(updated) };
}

export async function getBudgetTrends(
  b2cCustomerId: string,
  input: GetBudgetTrendsInput
): Promise<{
  period: BudgetPeriod;
  timezone: string;
  points: Array<{
    startDate: string;
    endDate: string;
    spent: number;
    budgetAmount: number | null;
    remaining: number | null;
    utilizationPct: number | null;
  }>;
}> {
  const household = await getOrCreateHousehold(b2cCustomerId);
  const timezone = normalizeTimeZone((household as any).timezone);
  const windows = getRecentBudgetWindows(input.period, timezone, input.points);
  const activeBudget = await getActiveBudget(household.id, input.budgetType, input.period);
  const budgetAmount = activeBudget?.amount ?? null;

  const points = await Promise.all(
    windows.map(async (window) => {
      const spent = await getTotalSpent(household.id, window.startUtc, window.endUtc);
      const remaining = budgetAmount != null ? round2(budgetAmount - spent) : null;
      return {
        startDate: window.startDateLocal,
        endDate: window.endDateLocal,
        spent,
        budgetAmount,
        remaining,
        utilizationPct: getUtilizationPct(spent, budgetAmount),
      };
    })
  );

  return {
    period: input.period,
    timezone,
    points,
  };
}

export async function getBudgetRecommendations(
  b2cCustomerId: string,
  input: GetBudgetRecommendationsInput
): Promise<{
  tips: BudgetRecommendation[];
  source: "rules" | "hybrid";
  generatedAt: string;
}> {
  const startedAt = Date.now();
  const snapshot = await getBudgetSnapshot(b2cCustomerId, {
    period: input.period,
    budgetType: input.budgetType,
  });

  const household = await getOrCreateHousehold(b2cCustomerId);
  const substitutionStats = await getSubstitutionOpportunities(
    household.id,
    new Date(snapshot.window.startAt),
    new Date(snapshot.window.endAt)
  );

  const ruleTips = buildRuleBasedRecommendations({
    period: input.period,
    spent: snapshot.spent,
    budgetAmount: snapshot.budget?.amount ?? null,
    breakdown: snapshot.breakdown.map((item) => ({
      category: item.category,
      amount: item.amount,
    })),
    planVsActual: snapshot.planVsActual
      ? {
          estimated: snapshot.planVsActual.estimated,
          actual: snapshot.planVsActual.actual,
        }
      : null,
    unpricedPurchasedItems: snapshot.metadata.unpricedPurchasedItems,
    substitutionOpportunityCount: substitutionStats.count,
    substitutionPotentialSavings: substitutionStats.potentialSavings,
  });

  const llmTips = await enrichRecommendationsWithLLM(ruleTips, snapshot);
  const tips = mergeRecommendations(ruleTips, llmTips);
  const source: "rules" | "hybrid" = llmTips && llmTips.length > 0 ? "hybrid" : "rules";

  const response = {
    tips,
    source,
    generatedAt: new Date().toISOString(),
  };

  console.log("[Budget] recommendations", {
    householdId: household.id,
    period: input.period,
    budgetType: input.budgetType,
    source: response.source,
    tipCount: tips.length,
    durationMs: Date.now() - startedAt,
  });

  return response;
}
