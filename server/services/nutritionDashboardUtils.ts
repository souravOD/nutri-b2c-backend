export interface NutrientGapInput {
  key: string;
  label: string;
  intake: number;
  intakeUnit: string;
  target: number;
  targetUnit: string;
}

export interface NutrientGapResult {
  key: string;
  nutrient: string;
  intake: number;
  target: number;
  unit: string;
  deficit: number;
  percentOfTarget: number;
  status: "ok" | "low" | "high";
}

export interface SnapshotUpsertRow {
  mealLogItemId: string;
  nutrientId: string;
  amount: number;
  unit: string;
  source: string;
}

const ACTIVITY_MULTIPLIERS: Record<string, number> = {
  sedentary: 1.2,
  lightly_active: 1.375,
  moderately_active: 1.55,
  very_active: 1.725,
  extra_active: 1.9,
};

export function n(value: number | string | null | undefined): number {
  if (value == null) return 0;
  const parsed = typeof value === "string" ? Number.parseFloat(value) : value;
  return Number.isFinite(parsed) ? parsed : 0;
}

export function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

export function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

export function convertUnit(value: number, fromUnit: string, toUnit: string): number {
  const from = fromUnit.trim().toLowerCase();
  const to = toUnit.trim().toLowerCase();
  if (from === to) return value;

  const toMg = (amount: number, unit: string): number | null => {
    if (unit === "mg") return amount;
    if (unit === "g") return amount * 1000;
    if (unit === "mcg" || unit === "ug") return amount / 1000;
    return null;
  };
  const fromMg = (amountMg: number, unit: string): number | null => {
    if (unit === "mg") return amountMg;
    if (unit === "g") return amountMg / 1000;
    if (unit === "mcg" || unit === "ug") return amountMg * 1000;
    return null;
  };

  const mg = toMg(value, from);
  if (mg != null) {
    const converted = fromMg(mg, to);
    if (converted != null) return converted;
  }

  return value;
}

export function calculateNutrientGaps(inputs: NutrientGapInput[]): NutrientGapResult[] {
  return inputs
    .filter((item) => item.target > 0)
    .map((item) => {
      const normalizedIntake = convertUnit(item.intake, item.intakeUnit, item.targetUnit);
      const pct = (normalizedIntake / item.target) * 100;
      const deficit = item.target - normalizedIntake;
      const status: NutrientGapResult["status"] =
        normalizedIntake < item.target ? "low" : normalizedIntake > item.target * 1.25 ? "high" : "ok";
      return {
        key: item.key,
        nutrient: item.label,
        intake: round2(normalizedIntake),
        target: round2(item.target),
        unit: item.targetUnit,
        deficit: round2(deficit),
        percentOfTarget: round2(pct),
        status,
      };
    })
    .sort((a, b) => a.percentOfTarget - b.percentOfTarget);
}

export function computeBmr(
  weightKg: number | null | undefined,
  heightCm: number | null | undefined,
  ageYears: number | null | undefined,
  gender: string | null | undefined
): number | null {
  const weight = n(weightKg);
  const height = n(heightCm);
  const age = n(ageYears) || 30;
  if (weight <= 0 || height <= 0) return null;

  const g = (gender || "").toLowerCase();
  const sexOffset = g === "male" ? 5 : g === "female" ? -161 : -78;
  return round2(10 * weight + 6.25 * height - 5 * age + sexOffset);
}

export function computeTdee(
  bmr: number | null | undefined,
  activityLevel: string | null | undefined
): number | null {
  const baseline = n(bmr);
  if (baseline <= 0) return null;
  const multiplier = ACTIVITY_MULTIPLIERS[activityLevel || ""] ?? ACTIVITY_MULTIPLIERS.sedentary;
  return round2(baseline * multiplier);
}

export function computeWeightGoalProgress(
  startWeightKg: number | null | undefined,
  currentWeightKg: number | null | undefined,
  targetWeightKg: number | null | undefined
): number | null {
  const start = n(startWeightKg);
  const current = n(currentWeightKg);
  const target = n(targetWeightKg);
  if (start <= 0 || current <= 0 || target <= 0) return null;
  if (start === target) return null;

  const total = Math.abs(start - target);
  const done = Math.abs(start - current);
  return round2(clamp((done / total) * 100, 0, 100));
}

export function dedupeSnapshotRows(rows: SnapshotUpsertRow[]): SnapshotUpsertRow[] {
  const seen = new Set<string>();
  const deduped: SnapshotUpsertRow[] = [];
  for (const row of rows) {
    const key = `${row.mealLogItemId}:${row.nutrientId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(row);
  }
  return deduped;
}

