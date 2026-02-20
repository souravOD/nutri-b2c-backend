import assert from "node:assert/strict";
import test from "node:test";
import {
  calculateNutrientGaps,
  computeBmr,
  computeTdee,
  dedupeSnapshotRows,
} from "./nutritionDashboardUtils.js";

test("calculateNutrientGaps sorts by percent and converts units", () => {
  const gaps = calculateNutrientGaps([
    {
      key: "sodium",
      label: "Sodium",
      intake: 2,
      intakeUnit: "g",
      target: 2300,
      targetUnit: "mg",
    },
    {
      key: "protein",
      label: "Protein",
      intake: 25,
      intakeUnit: "g",
      target: 50,
      targetUnit: "g",
    },
  ]);

  assert.equal(gaps.length, 2);
  assert.equal(gaps[0]?.key, "protein");
  assert.equal(gaps[0]?.percentOfTarget, 50);
  assert.equal(gaps[1]?.key, "sodium");
  assert.equal(gaps[1]?.percentOfTarget, 86.96);
});

test("computeBmr and computeTdee produce fallback values", () => {
  const bmr = computeBmr(70, 175, 30, "male");
  assert.equal(bmr, 1648.75);

  const tdee = computeTdee(bmr, "moderately_active");
  assert.equal(tdee, 2555.56);
});

test("dedupeSnapshotRows keeps one row per item nutrient key", () => {
  const rows = dedupeSnapshotRows([
    {
      mealLogItemId: "item-1",
      nutrientId: "nutrient-1",
      amount: 10,
      unit: "g",
      source: "derived",
    },
    {
      mealLogItemId: "item-1",
      nutrientId: "nutrient-1",
      amount: 10,
      unit: "g",
      source: "derived",
    },
    {
      mealLogItemId: "item-1",
      nutrientId: "nutrient-2",
      amount: 5,
      unit: "g",
      source: "derived",
    },
  ]);

  assert.equal(rows.length, 2);
});

