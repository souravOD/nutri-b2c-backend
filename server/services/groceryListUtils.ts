export interface PlanIngredientRowLike {
  plan_servings: number | string | null;
  recipe_servings: number | string | null;
  ingredient_id: string;
  ingredient_name: string;
  ingredient_category: string | null;
  recipe_product_id: string | null;
  quantity: number | string | null;
  unit: string | null;
  quantity_normalized_g: number | string | null;
}

export interface ProductCandidateLike {
  id: string;
  price: number | null;
  currency: string | null;
  package_weight_g: number | null;
}

export interface AggregatedBucketLike {
  key: string;
  ingredientId: string;
  itemName: string;
  quantity: number;
  quantityNormalizedG: number | null;
  unit: string | null;
  ingredientCategory: string | null;
  linkedProductIds: Set<string>;
}

export type GroceryListStatusLike = "draft" | "active" | "purchased" | "archived";

function n(value: number | string | null | undefined): number {
  if (value == null) return 0;
  const parsed = typeof value === "string" ? parseFloat(value) : value;
  return Number.isFinite(parsed) ? parsed : 0;
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

export function aggregateIngredients(
  rows: PlanIngredientRowLike[]
): Map<string, AggregatedBucketLike> {
  const buckets = new Map<string, AggregatedBucketLike>();

  for (const row of rows) {
    const ingredientId = row.ingredient_id;
    const recipeServings = n(row.recipe_servings) > 0 ? n(row.recipe_servings) : 1;
    const planServings = n(row.plan_servings) > 0 ? n(row.plan_servings) : 1;
    const servingFactor = planServings / recipeServings;

    const scaledQuantity = n(row.quantity) * servingFactor;
    const scaledNormalizedG = row.quantity_normalized_g == null
      ? null
      : n(row.quantity_normalized_g) * servingFactor;

    const hasNormalized = scaledNormalizedG != null && scaledNormalizedG > 0;
    const unit = hasNormalized ? "g" : (row.unit ?? null);
    const unitKey = hasNormalized ? "g" : (row.unit?.trim().toLowerCase() || "unit");
    const bucketKey = `${ingredientId}::${unitKey}`;

    if (!buckets.has(bucketKey)) {
      buckets.set(bucketKey, {
        key: bucketKey,
        ingredientId,
        itemName: row.ingredient_name,
        quantity: 0,
        quantityNormalizedG: hasNormalized ? 0 : null,
        unit,
        ingredientCategory: row.ingredient_category,
        linkedProductIds: new Set<string>(),
      });
    }

    const bucket = buckets.get(bucketKey)!;

    if (hasNormalized) {
      bucket.quantity += scaledNormalizedG!;
      bucket.quantityNormalizedG = (bucket.quantityNormalizedG ?? 0) + scaledNormalizedG!;
      bucket.unit = "g";
    } else {
      bucket.quantity += scaledQuantity;
    }

    if (row.recipe_product_id) {
      bucket.linkedProductIds.add(row.recipe_product_id);
    }
  }

  return buckets;
}

export function chooseCheapestUsd<T extends ProductCandidateLike>(candidates: T[]): T | null {
  const usable = candidates.filter((c) => c.currency === "USD" && c.price != null);
  if (usable.length === 0) return null;
  usable.sort((a, b) => n(a.price) - n(b.price));
  return usable[0] ?? null;
}

export function estimateBucketPrice(
  bucket: Pick<AggregatedBucketLike, "quantityNormalizedG">,
  candidate: ProductCandidateLike | null
): number | null {
  if (!candidate || candidate.price == null || candidate.currency !== "USD") return null;

  const basePrice = n(candidate.price);
  if (bucket.quantityNormalizedG != null && bucket.quantityNormalizedG > 0 && n(candidate.package_weight_g) > 0) {
    const packs = Math.max(1, Math.ceil(bucket.quantityNormalizedG / n(candidate.package_weight_g)));
    return round2(basePrice * packs);
  }

  return round2(basePrice);
}

export function canTransitionGroceryListStatus(
  current: GroceryListStatusLike | null | undefined,
  target: "active" | "purchased"
): boolean {
  if (!current) return false;
  if (current === "archived") return false;
  if (current === target) return true;
  if (current === "active" && target === "purchased") return true;
  if (current === "purchased" && target === "active") return true;
  if (current === "draft" && target === "active") return true;
  return false;
}
