import assert from "node:assert/strict";
import test from "node:test";
import {
  aggregateIngredients,
  canTransitionGroceryListStatus,
  chooseCheapestUsd,
  estimateBucketPrice,
} from "./groceryListUtils.js";

test("aggregateIngredients aggregates normalized grams across recipes", () => {
  const rows: any[] = [
    {
      meal_plan_item_id: "a",
      plan_servings: 2,
      recipe_id: "r1",
      recipe_servings: 2,
      ingredient_id: "ing-1",
      ingredient_name: "Flour",
      ingredient_category: "Baking",
      recipe_product_id: "prod-1",
      quantity: 100,
      unit: "g",
      quantity_normalized_g: 100,
    },
    {
      meal_plan_item_id: "b",
      plan_servings: 1,
      recipe_id: "r2",
      recipe_servings: 1,
      ingredient_id: "ing-1",
      ingredient_name: "Flour",
      ingredient_category: "Baking",
      recipe_product_id: "prod-2",
      quantity: 50,
      unit: "g",
      quantity_normalized_g: 50,
    },
  ];

  const buckets = aggregateIngredients(rows);
  assert.equal(buckets.size, 1);

  const only = [...buckets.values()][0];
  assert.equal(only.unit, "g");
  assert.equal(Math.round(only.quantity), 150);
  assert.equal(Math.round(only.quantityNormalizedG ?? 0), 150);
  assert.equal(only.linkedProductIds.size, 2);
});

test("aggregateIngredients keeps separate buckets for non-normalized units", () => {
  const rows: any[] = [
    {
      meal_plan_item_id: "a",
      plan_servings: 1,
      recipe_id: "r1",
      recipe_servings: 1,
      ingredient_id: "ing-2",
      ingredient_name: "Milk",
      ingredient_category: "Dairy",
      recipe_product_id: null,
      quantity: 2,
      unit: "cup",
      quantity_normalized_g: null,
    },
    {
      meal_plan_item_id: "b",
      plan_servings: 1,
      recipe_id: "r2",
      recipe_servings: 1,
      ingredient_id: "ing-2",
      ingredient_name: "Milk",
      ingredient_category: "Dairy",
      recipe_product_id: null,
      quantity: 500,
      unit: "ml",
      quantity_normalized_g: null,
    },
  ];

  const buckets = aggregateIngredients(rows);
  assert.equal(buckets.size, 2);
});

test("chooseCheapestUsd returns cheapest USD candidate", () => {
  const chosen = chooseCheapestUsd([
    { id: "1", price: 4.2, currency: "USD" },
    { id: "2", price: 3.1, currency: "USD" },
    { id: "3", price: 1.0, currency: "EUR" },
  ] as any);

  assert.ok(chosen);
  assert.equal(chosen?.id, "2");
});

test("estimateBucketPrice scales by package weight for normalized quantities", () => {
  const bucket: any = {
    quantity: 900,
    quantityNormalizedG: 900,
  };

  const price = estimateBucketPrice(bucket, {
    id: "p1",
    price: 2.5,
    currency: "USD",
    package_weight_g: 400,
  } as any);

  assert.equal(price, 7.5);
});

test("canTransitionGroceryListStatus enforces allowed lifecycle transitions", () => {
  assert.equal(canTransitionGroceryListStatus("active", "purchased"), true);
  assert.equal(canTransitionGroceryListStatus("purchased", "active"), true);
  assert.equal(canTransitionGroceryListStatus("active", "active"), true);
  assert.equal(canTransitionGroceryListStatus("draft", "active"), true);
  assert.equal(canTransitionGroceryListStatus("archived", "active"), false);
  assert.equal(canTransitionGroceryListStatus("archived", "purchased"), false);
  assert.equal(canTransitionGroceryListStatus("draft", "purchased"), false);
});
