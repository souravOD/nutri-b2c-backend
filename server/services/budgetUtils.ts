export type BudgetPeriod = "weekly" | "monthly";
export type BudgetType = "grocery";

export interface BudgetWindow {
  period: BudgetPeriod;
  timezone: string;
  startUtc: Date;
  endUtc: Date;
  startDateLocal: string;
  endDateLocal: string;
}

export interface CategorySpendLike {
  category: string;
  amount: number;
}

export interface PlanVsActualLike {
  estimated: number;
  actual: number;
}

export interface BudgetRecommendation {
  id: string;
  title: string;
  description: string;
  severity: "info" | "warning" | "critical";
  potentialSavings: number | null;
  source: "rules" | "llm";
}

interface Ymd {
  year: number;
  month: number;
  day: number;
}

interface YmdHms extends Ymd {
  hour: number;
  minute: number;
  second: number;
}

export function n(value: number | string | null | undefined): number {
  if (value == null) return 0;
  const parsed = typeof value === "string" ? Number.parseFloat(value) : value;
  return Number.isFinite(parsed) ? parsed : 0;
}

export function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

export function toIsoDate(value: Date): string {
  return value.toISOString().slice(0, 10);
}

export function normalizeTimeZone(timezone: string | null | undefined): string {
  const candidate = (timezone || "").trim();
  if (!candidate) return "UTC";
  try {
    Intl.DateTimeFormat("en-US", { timeZone: candidate }).format(new Date());
    return candidate;
  } catch {
    return "UTC";
  }
}

function getZonedParts(date: Date, timezone: string): YmdHms {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(date);

  const mapped = Object.fromEntries(parts.map((p) => [p.type, p.value]));
  return {
    year: Number(mapped.year),
    month: Number(mapped.month),
    day: Number(mapped.day),
    hour: Number(mapped.hour),
    minute: Number(mapped.minute),
    second: Number(mapped.second),
  };
}

function utcDateFromZonedParts(parts: YmdHms, timezone: string): Date {
  const guessMs = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
  const zonedAtGuess = getZonedParts(new Date(guessMs), timezone);
  const zonedAsUtcMs = Date.UTC(
    zonedAtGuess.year,
    zonedAtGuess.month - 1,
    zonedAtGuess.day,
    zonedAtGuess.hour,
    zonedAtGuess.minute,
    zonedAtGuess.second
  );
  const offsetMs = zonedAsUtcMs - guessMs;
  return new Date(guessMs - offsetMs);
}

function ymdToUtcDate(ymd: Ymd): Date {
  return new Date(Date.UTC(ymd.year, ymd.month - 1, ymd.day, 0, 0, 0));
}

function utcDateToYmd(date: Date): Ymd {
  return {
    year: date.getUTCFullYear(),
    month: date.getUTCMonth() + 1,
    day: date.getUTCDate(),
  };
}

function addDaysYmd(ymd: Ymd, days: number): Ymd {
  const d = ymdToUtcDate(ymd);
  d.setUTCDate(d.getUTCDate() + days);
  return utcDateToYmd(d);
}

function addMonthsYmd(ymd: Ymd, months: number): Ymd {
  const d = ymdToUtcDate(ymd);
  d.setUTCMonth(d.getUTCMonth() + months);
  return utcDateToYmd(d);
}

function startOfWeekMonday(ymd: Ymd): Ymd {
  const d = ymdToUtcDate(ymd);
  const dow = d.getUTCDay();
  const diff = (dow + 6) % 7;
  return addDaysYmd(ymd, -diff);
}

function ymdString(ymd: Ymd): string {
  const m = String(ymd.month).padStart(2, "0");
  const d = String(ymd.day).padStart(2, "0");
  return `${ymd.year}-${m}-${d}`;
}

function getCurrentWindowStarts(period: BudgetPeriod, timezone: string, now: Date): { start: Ymd; end: Ymd } {
  const zoned = getZonedParts(now, timezone);
  const today: Ymd = { year: zoned.year, month: zoned.month, day: zoned.day };

  if (period === "weekly") {
    const start = startOfWeekMonday(today);
    const end = addDaysYmd(start, 7);
    return { start, end };
  }

  const start: Ymd = { year: today.year, month: today.month, day: 1 };
  const end = addMonthsYmd(start, 1);
  return { start, end };
}

export function getCurrentBudgetWindow(
  period: BudgetPeriod,
  timezone: string,
  now: Date = new Date()
): BudgetWindow {
  const tz = normalizeTimeZone(timezone);
  const { start, end } = getCurrentWindowStarts(period, tz, now);

  const startUtc = utcDateFromZonedParts({ ...start, hour: 0, minute: 0, second: 0 }, tz);
  const endUtc = utcDateFromZonedParts({ ...end, hour: 0, minute: 0, second: 0 }, tz);

  return {
    period,
    timezone: tz,
    startUtc,
    endUtc,
    startDateLocal: ymdString(start),
    endDateLocal: ymdString(addDaysYmd(end, -1)),
  };
}

export function getRecentBudgetWindows(
  period: BudgetPeriod,
  timezone: string,
  points: number,
  now: Date = new Date()
): BudgetWindow[] {
  const tz = normalizeTimeZone(timezone);
  const cappedPoints = Math.max(1, Math.min(points, 52));
  const current = getCurrentBudgetWindow(period, tz, now);
  const currentStartYmd = utcDateToYmd(new Date(`${current.startDateLocal}T00:00:00.000Z`));

  const windows: BudgetWindow[] = [];
  for (let i = cappedPoints - 1; i >= 0; i -= 1) {
    const startYmd = period === "weekly"
      ? addDaysYmd(currentStartYmd, -i * 7)
      : addMonthsYmd(currentStartYmd, -i);
    const endYmd = period === "weekly" ? addDaysYmd(startYmd, 7) : addMonthsYmd(startYmd, 1);

    windows.push({
      period,
      timezone: tz,
      startUtc: utcDateFromZonedParts({ ...startYmd, hour: 0, minute: 0, second: 0 }, tz),
      endUtc: utcDateFromZonedParts({ ...endYmd, hour: 0, minute: 0, second: 0 }, tz),
      startDateLocal: ymdString(startYmd),
      endDateLocal: ymdString(addDaysYmd(endYmd, -1)),
    });
  }

  return windows;
}

export function getUtilizationPct(spent: number, budgetAmount: number | null): number | null {
  if (budgetAmount == null || budgetAmount <= 0) return null;
  return round2((spent / budgetAmount) * 100);
}

export function buildRuleBasedRecommendations(input: {
  period: BudgetPeriod;
  spent: number;
  budgetAmount: number | null;
  breakdown: CategorySpendLike[];
  planVsActual: PlanVsActualLike | null;
  unpricedPurchasedItems: number;
  substitutionOpportunityCount: number;
  substitutionPotentialSavings: number;
}): BudgetRecommendation[] {
  const tips: BudgetRecommendation[] = [];
  const periodLabel = input.period === "weekly" ? "this week" : "this month";

  if (input.budgetAmount != null && input.budgetAmount > 0 && input.spent > input.budgetAmount) {
    const over = round2(input.spent - input.budgetAmount);
    tips.push({
      id: "budget-overrun",
      title: `You are over budget ${periodLabel}`,
      description: `Spending is $${over.toFixed(2)} above target. Prioritize lower-cost substitutions for the remaining purchases.`,
      severity: "critical",
      potentialSavings: over,
      source: "rules",
    });
  }

  const topCategory = [...input.breakdown].sort((a, b) => b.amount - a.amount)[0];
  if (topCategory && input.spent > 0) {
    const share = (topCategory.amount / input.spent) * 100;
    if (share >= 40) {
      tips.push({
        id: "category-concentration",
        title: `High spend concentration in ${topCategory.category}`,
        description: `${round2(share)}% of spend is in ${topCategory.category}. Try cheaper brands or reduce premium SKUs in this category.`,
        severity: "warning",
        potentialSavings: round2(topCategory.amount * 0.1),
        source: "rules",
      });
    }
  }

  if (input.planVsActual && input.planVsActual.estimated > 0) {
    const diff = round2(input.planVsActual.actual - input.planVsActual.estimated);
    const diffPct = (diff / input.planVsActual.estimated) * 100;
    if (diffPct >= 10) {
      tips.push({
        id: "plan-actual-slippage",
        title: "Actual spend is above meal plan estimate",
        description: `Current plan spend is ${round2(diffPct)}% above estimate. Review substitutions and manual add-ons.`,
        severity: "warning",
        potentialSavings: diff > 0 ? diff : null,
        source: "rules",
      });
    }
  }

  if (input.unpricedPurchasedItems > 0) {
    tips.push({
      id: "missing-actual-prices",
      title: "Add missing actual prices",
      description: `${input.unpricedPurchasedItems} purchased item(s) are missing actual price, which reduces budget accuracy.`,
      severity: "info",
      potentialSavings: null,
      source: "rules",
    });
  }

  if (input.substitutionOpportunityCount > 0 && input.substitutionPotentialSavings > 0) {
    tips.push({
      id: "substitution-opportunities",
      title: "Detected lower-cost substitution opportunities",
      description: `${input.substitutionOpportunityCount} item(s) have cheaper mapped alternatives.`,
      severity: "info",
      potentialSavings: round2(input.substitutionPotentialSavings),
      source: "rules",
    });
  }

  if (tips.length === 0) {
    tips.push({
      id: "on-track",
      title: "Budget is on track",
      description: `No major risk signals detected for ${periodLabel}. Keep tracking actual prices for better precision.`,
      severity: "info",
      potentialSavings: null,
      source: "rules",
    });
  }

  return tips;
}

export function mergeRecommendations(
  ruleTips: BudgetRecommendation[],
  llmTips: BudgetRecommendation[] | null | undefined
): BudgetRecommendation[] {
  if (!llmTips || llmTips.length === 0) return ruleTips;

  const seen = new Set<string>();
  const merged: BudgetRecommendation[] = [];
  for (const tip of [...llmTips, ...ruleTips]) {
    const key = `${tip.title.trim().toLowerCase()}::${tip.description.trim().toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(tip);
  }
  return merged.slice(0, 8);
}
