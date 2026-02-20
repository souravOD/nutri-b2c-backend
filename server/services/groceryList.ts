import { and, desc, eq, ne } from "drizzle-orm";
import { db, executeRaw } from "../config/database.js";
import {
  mealPlans,
  shoppingListItems,
  shoppingLists,
} from "../../shared/goldSchema.js";
import { getOrCreateHousehold } from "./household.js";
import { canTransitionGroceryListStatus } from "./groceryListUtils.js";

export interface GenerateGroceryListInput {
  mealPlanId?: string;
}

export interface UpdateGroceryListItemInput {
  isPurchased?: boolean;
  actualPrice?: number;
  substitutedProductId?: string;
}

export interface AddCustomGroceryItemInput {
  itemName: string;
  quantity: number;
  unit?: string;
  category?: string;
  estimatedPrice?: number;
}

interface PlanIngredientRow {
  meal_plan_item_id: string;
  plan_servings: number | string | null;
  recipe_id: string;
  recipe_servings: number | string | null;
  ingredient_id: string;
  ingredient_name: string;
  ingredient_category: string | null;
  recipe_product_id: string | null;
  quantity: number | string | null;
  unit: string | null;
  quantity_normalized_g: number | string | null;
}

interface ProductCandidate {
  id: string;
  name: string;
  brand: string | null;
  price: number | null;
  currency: string | null;
  package_weight_g: number | null;
  category_name: string | null;
  image_url: string | null;
}

interface AggregatedBucket {
  key: string;
  ingredientId: string;
  itemName: string;
  quantity: number;
  quantityNormalizedG: number | null;
  unit: string | null;
  ingredientCategory: string | null;
  linkedProductIds: Set<string>;
}

interface GroceryListItemDetail {
  id: string;
  shoppingListId: string;
  productId: string | null;
  ingredientId: string | null;
  itemName: string;
  quantity: string | number;
  unit: string | null;
  category: string | null;
  estimatedPrice: string | number | null;
  actualPrice: string | number | null;
  isPurchased: boolean | null;
  substitutedProductId: string | null;
  notes: string | null;
  createdAt: Date | null;
  updatedAt: Date | null;
  currentProductId: string | null;
  currentProductName: string | null;
  currentProductBrand: string | null;
}

function n(value: number | string | null | undefined): number {
  if (value == null) return 0;
  const parsed = typeof value === "string" ? parseFloat(value) : value;
  return Number.isFinite(parsed) ? parsed : 0;
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

function activeOwnershipError(entity: string): Error {
  const err = new Error(`${entity} not found`);
  (err as any).status = 404;
  return err;
}

async function resolvePlanForGeneration(householdId: string, mealPlanId?: string) {
  const conditions = [eq(mealPlans.householdId, householdId)];

  if (mealPlanId) {
    conditions.push(eq(mealPlans.id, mealPlanId));
  } else {
    conditions.push(eq(mealPlans.status, "active"));
  }

  const rows = await db
    .select()
    .from(mealPlans)
    .where(and(...conditions))
    .orderBy(desc(mealPlans.createdAt))
    .limit(1);

  if (!rows[0]) {
    if (mealPlanId) {
      const err = new Error("Meal plan not found for your household");
      (err as any).status = 404;
      throw err;
    }
    const err = new Error("No active meal plan found for your household");
    (err as any).status = 404;
    throw err;
  }

  return rows[0];
}

async function fetchPlanIngredientRows(mealPlanId: string): Promise<PlanIngredientRow[]> {
  const rows = (await executeRaw(
    `
    SELECT
      mpi.id AS meal_plan_item_id,
      mpi.servings AS plan_servings,
      mpi.recipe_id,
      r.servings AS recipe_servings,
      ri.ingredient_id,
      i.name AS ingredient_name,
      i.category AS ingredient_category,
      ri.product_id AS recipe_product_id,
      ri.quantity,
      ri.unit,
      ri.quantity_normalized_g
    FROM gold.meal_plan_items mpi
    JOIN gold.recipes r ON r.id = mpi.recipe_id
    JOIN gold.recipe_ingredients ri ON ri.recipe_id = mpi.recipe_id
    JOIN gold.ingredients i ON i.id = ri.ingredient_id
    WHERE mpi.meal_plan_id = $1
      AND COALESCE(mpi.status, 'planned') <> 'skipped'
    `,
    [mealPlanId]
  )) as unknown as PlanIngredientRow[];

  return rows;
}

function aggregateIngredients(rows: PlanIngredientRow[]): Map<string, AggregatedBucket> {
  const buckets = new Map<string, AggregatedBucket>();

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

async function fetchProductCandidatesByIds(productIds: string[]): Promise<Map<string, ProductCandidate>> {
  if (productIds.length === 0) return new Map();

  const rows = (await executeRaw(
    `
    SELECT
      p.id,
      p.name,
      p.brand,
      p.price,
      p.currency,
      p.package_weight_g,
      p.image_url,
      pc.name AS category_name
    FROM gold.products p
    LEFT JOIN gold.product_categories pc ON pc.id = p.category_id
    WHERE p.id = ANY($1::uuid[])
      AND p.status = 'active'
    `,
    [productIds]
  )) as any[];

  const map = new Map<string, ProductCandidate>();
  for (const row of rows) {
    map.set(row.id, {
      id: row.id,
      name: row.name,
      brand: row.brand,
      price: row.price == null ? null : n(row.price),
      currency: row.currency,
      package_weight_g: row.package_weight_g == null ? null : n(row.package_weight_g),
      category_name: row.category_name,
      image_url: row.image_url,
    });
  }

  return map;
}

async function fetchIngredientMappedCandidates(ingredientIds: string[]): Promise<Map<string, ProductCandidate[]>> {
  if (ingredientIds.length === 0) return new Map();

  const rows = (await executeRaw(
    `
    SELECT
      pi.ingredient_id,
      p.id,
      p.name,
      p.brand,
      p.price,
      p.currency,
      p.package_weight_g,
      p.image_url,
      pc.name AS category_name
    FROM gold.product_ingredients pi
    JOIN gold.products p ON p.id = pi.product_id
    LEFT JOIN gold.product_categories pc ON pc.id = p.category_id
    WHERE pi.ingredient_id = ANY($1::uuid[])
      AND p.status = 'active'
    `,
    [ingredientIds]
  )) as any[];

  const map = new Map<string, ProductCandidate[]>();
  for (const row of rows) {
    const ingredientId = row.ingredient_id;
    if (!map.has(ingredientId)) map.set(ingredientId, []);
    map.get(ingredientId)!.push({
      id: row.id,
      name: row.name,
      brand: row.brand,
      price: row.price == null ? null : n(row.price),
      currency: row.currency,
      package_weight_g: row.package_weight_g == null ? null : n(row.package_weight_g),
      category_name: row.category_name,
      image_url: row.image_url,
    });
  }

  return map;
}

function chooseCheapestUsd(candidates: ProductCandidate[]): ProductCandidate | null {
  const usable = candidates.filter((c) => c.currency === "USD" && c.price != null);
  if (usable.length === 0) return null;
  usable.sort((a, b) => n(a.price) - n(b.price));
  return usable[0] ?? null;
}

function estimateBucketPrice(bucket: AggregatedBucket, candidate: ProductCandidate | null): number | null {
  if (!candidate || candidate.price == null || candidate.currency !== "USD") return null;

  const basePrice = n(candidate.price);
  if (bucket.quantityNormalizedG != null && bucket.quantityNormalizedG > 0 && n(candidate.package_weight_g) > 0) {
    const packs = Math.max(1, Math.ceil(bucket.quantityNormalizedG / n(candidate.package_weight_g)));
    return round2(basePrice * packs);
  }

  return round2(basePrice);
}

async function recalculateEstimatedTotal(listId: string) {
  const rows = (await executeRaw(
    `
    SELECT COALESCE(SUM(estimated_price), 0)::numeric(10,2) AS total
    FROM gold.shopping_list_items
    WHERE shopping_list_id = $1
    `,
    [listId]
  )) as unknown as { total: number | string | null }[];

  const total = round2(n(rows[0]?.total));

  await db
    .update(shoppingLists)
    .set({ totalEstimatedCost: String(total) })
    .where(eq(shoppingLists.id, listId));

  return total;
}

async function requireListForHousehold(listId: string, householdId: string) {
  const rows = await db
    .select()
    .from(shoppingLists)
    .where(and(eq(shoppingLists.id, listId), eq(shoppingLists.householdId, householdId)))
    .limit(1);

  if (!rows[0]) throw activeOwnershipError("Shopping list");
  return rows[0];
}

async function requireItemForList(itemId: string, listId: string) {
  const rows = await db
    .select()
    .from(shoppingListItems)
    .where(and(eq(shoppingListItems.id, itemId), eq(shoppingListItems.shoppingListId, listId)))
    .limit(1);

  if (!rows[0]) throw activeOwnershipError("Shopping list item");
  return rows[0];
}

async function listItemsWithSummary(listId: string) {
  const items = await db
    .select()
    .from(shoppingListItems)
    .where(eq(shoppingListItems.shoppingListId, listId))
    .orderBy(shoppingListItems.category, shoppingListItems.itemName);

  const currentProductIds = Array.from(
    new Set(
      items
        .map((item) => item.substitutedProductId ?? item.productId)
        .filter((id): id is string => Boolean(id))
    )
  );

  const productRows = currentProductIds.length
    ? ((await executeRaw(
      `
      SELECT id, name, brand
      FROM gold.products
      WHERE id = ANY($1::uuid[])
      `,
      [currentProductIds]
    )) as unknown as { id: string; name: string | null; brand: string | null }[])
    : [];

  const productMap = new Map(productRows.map((row) => [row.id, row]));

  const detailedItems: GroceryListItemDetail[] = items.map((item) => {
    const currentProductId = item.substitutedProductId ?? item.productId ?? null;
    const product = currentProductId ? productMap.get(currentProductId) : null;
    return {
      ...item,
      currentProductId,
      currentProductName: product?.name ?? null,
      currentProductBrand: product?.brand ?? null,
    };
  });

  const totalItems = detailedItems.length;
  const purchasedItems = detailedItems.filter((item) => item.isPurchased).length;
  const estimatedTotal = round2(detailedItems.reduce((sum, item) => sum + n(item.estimatedPrice), 0));
  const purchasedActualTotal = round2(
    detailedItems.filter((item) => item.isPurchased).reduce((sum, item) => sum + n(item.actualPrice), 0)
  );

  return {
    items: detailedItems,
    summary: {
      totalItems,
      purchasedItems,
      estimatedTotal,
      purchasedActualTotal,
    },
  };
}

export async function generateGroceryList(
  b2cCustomerId: string,
  input: GenerateGroceryListInput
) {
  const startedAt = Date.now();
  const household = await getOrCreateHousehold(b2cCustomerId);
  const plan = await resolvePlanForGeneration(household.id, input.mealPlanId);

  const ingredientRows = await fetchPlanIngredientRows(plan.id);
  if (ingredientRows.length === 0) {
    const err = new Error("Selected meal plan has no ingredients to generate a grocery list");
    (err as any).status = 422;
    throw err;
  }

  const buckets = aggregateIngredients(ingredientRows);
  const bucketValues = Array.from(buckets.values()).filter((bucket) => bucket.quantity > 0);

  const preferredProductIds = Array.from(
    new Set(bucketValues.flatMap((b) => Array.from(b.linkedProductIds)))
  );
  const ingredientIds = Array.from(new Set(bucketValues.map((b) => b.ingredientId)));

  const [preferredMap, ingredientMap] = await Promise.all([
    fetchProductCandidatesByIds(preferredProductIds),
    fetchIngredientMappedCandidates(ingredientIds),
  ]);

  let pricedItems = 0;
  let skippedByCurrency = 0;

  const generatedItems = bucketValues.map((bucket) => {
    const linkedCandidates = Array.from(bucket.linkedProductIds)
      .map((id) => preferredMap.get(id))
      .filter((v): v is ProductCandidate => Boolean(v));

    const ingredientCandidates = ingredientMap.get(bucket.ingredientId) ?? [];

    const selected = chooseCheapestUsd(linkedCandidates) || chooseCheapestUsd(ingredientCandidates);

    if (!selected) {
      const hasNonUsd = [...linkedCandidates, ...ingredientCandidates].some((c) => c.currency !== "USD");
      if (hasNonUsd) skippedByCurrency += 1;
    }

    const estimatedPrice = estimateBucketPrice(bucket, selected);
    if (estimatedPrice != null) pricedItems += 1;

    return {
      productId: selected?.id ?? null,
      ingredientId: bucket.ingredientId,
      itemName: bucket.itemName,
      quantity: String(round2(bucket.quantity)),
      unit: bucket.unit,
      category: selected?.category_name ?? bucket.ingredientCategory ?? "Other",
      estimatedPrice: estimatedPrice != null ? String(estimatedPrice) : null,
      actualPrice: null,
      isPurchased: false,
      substitutedProductId: null,
      notes: null,
    };
  });

  if (generatedItems.length === 0) {
    const err = new Error("Selected meal plan has no purchasable ingredients");
    (err as any).status = 422;
    throw err;
  }

  const result = await db.transaction(async (tx) => {
    await tx
      .update(shoppingLists)
      .set({ status: "archived" })
      .where(
        and(
          eq(shoppingLists.householdId, household.id),
          eq(shoppingLists.mealPlanId, plan.id),
          eq(shoppingLists.status, "active")
        )
      );

    const listRows = await tx
      .insert(shoppingLists)
      .values({
        householdId: household.id,
        mealPlanId: plan.id,
        listName: `Grocery List ${plan.startDate} to ${plan.endDate}`,
        status: "active",
        totalEstimatedCost: "0",
      })
      .returning();

    const list = listRows[0];

    const itemRows = await tx
      .insert(shoppingListItems)
      .values(
        generatedItems.map((item) => ({
          shoppingListId: list.id,
          ...item,
        }))
      )
      .returning();

    const estimatedTotal = round2(itemRows.reduce((sum, item) => sum + n(item.estimatedPrice), 0));

    const updatedListRows = await tx
      .update(shoppingLists)
      .set({ totalEstimatedCost: String(estimatedTotal) })
      .where(eq(shoppingLists.id, list.id))
      .returning();

    return {
      list: updatedListRows[0] ?? list,
      items: itemRows,
      estimatedTotal,
    };
  });

  const elapsedMs = Date.now() - startedAt;
  console.log("[GroceryList] generate", {
    householdId: household.id,
    mealPlanId: plan.id,
    generatedItems: result.items.length,
    pricedItems,
    skippedByCurrency,
    elapsedMs,
  });

  return result;
}

export async function listGroceryLists(
  b2cCustomerId: string,
  status?: "draft" | "active" | "purchased" | "archived",
  limit = 20,
  offset = 0
) {
  const household = await getOrCreateHousehold(b2cCustomerId);

  const conditions = [eq(shoppingLists.householdId, household.id)];
  if (status) conditions.push(eq(shoppingLists.status, status));

  const lists = await db
    .select()
    .from(shoppingLists)
    .where(and(...conditions))
    .orderBy(desc(shoppingLists.createdAt))
    .limit(limit)
    .offset(offset);

  return { lists };
}

export async function getGroceryListDetail(b2cCustomerId: string, listId: string) {
  const household = await getOrCreateHousehold(b2cCustomerId);
  const list = await requireListForHousehold(listId, household.id);
  const { items, summary } = await listItemsWithSummary(listId);

  return {
    list,
    items,
    estimatedTotal: round2(n(list.totalEstimatedCost)),
    summary,
  };
}

export async function updateGroceryListStatus(
  b2cCustomerId: string,
  listId: string,
  status: "active" | "purchased"
) {
  const household = await getOrCreateHousehold(b2cCustomerId);
  const list = await requireListForHousehold(listId, household.id);

  if (!canTransitionGroceryListStatus(
    (list.status ?? null) as "draft" | "active" | "purchased" | "archived" | null,
    status
  )) {
    const err = new Error(`Cannot change list status from ${list.status} to ${status}`);
    (err as any).status = 409;
    throw err;
  }

  if (status === "purchased") {
    const rows = await db
      .update(shoppingLists)
      .set({ status: "purchased" })
      .where(eq(shoppingLists.id, list.id))
      .returning();
    return { list: rows[0] ?? list };
  }

  const updated = await db.transaction(async (tx) => {
    if (list.mealPlanId) {
      await tx
        .update(shoppingLists)
        .set({ status: "archived" })
        .where(
          and(
            eq(shoppingLists.householdId, household.id),
            eq(shoppingLists.mealPlanId, list.mealPlanId),
            eq(shoppingLists.status, "active"),
            ne(shoppingLists.id, list.id)
          )
        );
    }

    const rows = await tx
      .update(shoppingLists)
      .set({ status: "active" })
      .where(eq(shoppingLists.id, list.id))
      .returning();

    return rows[0] ?? list;
  });

  return { list: updated };
}

export async function updateGroceryListItem(
  b2cCustomerId: string,
  listId: string,
  itemId: string,
  input: UpdateGroceryListItemInput
) {
  const household = await getOrCreateHousehold(b2cCustomerId);
  await requireListForHousehold(listId, household.id);
  await requireItemForList(itemId, listId);

  const setValues: Record<string, any> = {};
  if (input.isPurchased !== undefined) setValues.isPurchased = input.isPurchased;
  if (input.actualPrice !== undefined) setValues.actualPrice = input.actualPrice >= 0 ? String(input.actualPrice) : null;

  if (input.substitutedProductId) {
    const rows = (await executeRaw(
      `
      SELECT p.id, p.price, p.currency, pc.name AS category_name
      FROM gold.products p
      LEFT JOIN gold.product_categories pc ON pc.id = p.category_id
      WHERE p.id = $1
      LIMIT 1
      `,
      [input.substitutedProductId]
    )) as any[];

    if (!rows[0]) {
      const err = new Error("Substitute product not found");
      (err as any).status = 404;
      throw err;
    }

    setValues.substitutedProductId = input.substitutedProductId;
    if (rows[0].currency === "USD" && rows[0].price != null) {
      setValues.estimatedPrice = String(round2(n(rows[0].price)));
    }
    if (rows[0].category_name) {
      setValues.category = rows[0].category_name;
    }
  }

  if (Object.keys(setValues).length === 0) {
    const err = new Error("At least one update field is required");
    (err as any).status = 400;
    throw err;
  }

  const updatedRows = await db
    .update(shoppingListItems)
    .set(setValues)
    .where(and(eq(shoppingListItems.id, itemId), eq(shoppingListItems.shoppingListId, listId)))
    .returning();

  const estimatedTotal = await recalculateEstimatedTotal(listId);
  const { summary } = await listItemsWithSummary(listId);

  return {
    item: updatedRows[0],
    estimatedTotal,
    summary,
  };
}

export async function addGroceryListItem(
  b2cCustomerId: string,
  listId: string,
  input: AddCustomGroceryItemInput
) {
  const household = await getOrCreateHousehold(b2cCustomerId);
  await requireListForHousehold(listId, household.id);

  const rows = await db
    .insert(shoppingListItems)
    .values({
      shoppingListId: listId,
      itemName: input.itemName,
      quantity: String(round2(input.quantity)),
      unit: input.unit ?? null,
      category: input.category ?? "Other",
      estimatedPrice: input.estimatedPrice != null ? String(round2(input.estimatedPrice)) : null,
      isPurchased: false,
    })
    .returning();

  const estimatedTotal = await recalculateEstimatedTotal(listId);
  const { summary } = await listItemsWithSummary(listId);

  return {
    item: rows[0],
    estimatedTotal,
    summary,
  };
}

export async function deleteGroceryListItem(
  b2cCustomerId: string,
  listId: string,
  itemId: string
) {
  const household = await getOrCreateHousehold(b2cCustomerId);
  await requireListForHousehold(listId, household.id);
  await requireItemForList(itemId, listId);

  await db
    .delete(shoppingListItems)
    .where(and(eq(shoppingListItems.id, itemId), eq(shoppingListItems.shoppingListId, listId)));

  const estimatedTotal = await recalculateEstimatedTotal(listId);
  const { summary } = await listItemsWithSummary(listId);

  return { success: true, estimatedTotal, summary };
}

export interface GrocerySubstitutionCandidate {
  productId: string;
  name: string;
  brand: string | null;
  price: number | null;
  currency: string | null;
  category: string | null;
  imageUrl: string | null;
  substitutionReason: string | null;
  confidenceScore: number | null;
  savingsVsCurrent: number | null;
}

export async function getGroceryItemSubstitutions(
  b2cCustomerId: string,
  listId: string,
  itemId: string
) {
  const household = await getOrCreateHousehold(b2cCustomerId);
  await requireListForHousehold(listId, household.id);
  const item = await requireItemForList(itemId, listId);

  const currentProductId = item.substitutedProductId ?? item.productId;
  const currentPriceRows = currentProductId
    ? ((await executeRaw(`SELECT price, currency FROM gold.products WHERE id = $1 LIMIT 1`, [currentProductId])) as any[])
    : [];
  const currentPrice = currentPriceRows[0]?.currency === "USD" ? n(currentPriceRows[0]?.price) : null;

  let rows: any[] = [];

  if (item.productId) {
    rows = (await executeRaw(
      `
      SELECT
        sp.id AS product_id,
        sp.name,
        sp.brand,
        sp.price,
        sp.currency,
        sp.image_url,
        pc.name AS category,
        ps.substitution_reason,
        ps.confidence_score
      FROM gold.product_substitutions ps
      JOIN gold.products sp ON sp.id = ps.substitute_product_id
      LEFT JOIN gold.product_categories pc ON pc.id = sp.category_id
      WHERE ps.original_product_id = $1
        AND sp.status = 'active'
      ORDER BY
        CASE WHEN sp.currency = 'USD' THEN 0 ELSE 1 END,
        sp.price ASC NULLS LAST,
        ps.confidence_score DESC NULLS LAST
      LIMIT 20
      `,
      [item.productId]
    )) as any[];
  }

  if (rows.length === 0 && item.ingredientId) {
    rows = (await executeRaw(
      `
      SELECT
        p.id AS product_id,
        p.name,
        p.brand,
        p.price,
        p.currency,
        p.image_url,
        pc.name AS category,
        'same_ingredient'::varchar AS substitution_reason,
        NULL::numeric AS confidence_score
      FROM gold.product_ingredients pi
      JOIN gold.products p ON p.id = pi.product_id
      LEFT JOIN gold.product_categories pc ON pc.id = p.category_id
      WHERE pi.ingredient_id = $1
        AND p.status = 'active'
        AND ($2::uuid IS NULL OR p.id <> $2::uuid)
      ORDER BY
        CASE WHEN p.currency = 'USD' THEN 0 ELSE 1 END,
        p.price ASC NULLS LAST
      LIMIT 20
      `,
      [item.ingredientId, currentProductId ?? null]
    )) as any[];
  }

  const substitutions: GrocerySubstitutionCandidate[] = rows.map((row) => {
    const price = row.price == null ? null : round2(n(row.price));
    const isUsd = row.currency === "USD";
    const savings = isUsd && currentPrice != null && price != null
      ? round2(currentPrice - price)
      : null;

    return {
      productId: row.product_id,
      name: row.name,
      brand: row.brand,
      price,
      currency: row.currency,
      category: row.category,
      imageUrl: row.image_url,
      substitutionReason: row.substitution_reason,
      confidenceScore: row.confidence_score == null ? null : n(row.confidence_score),
      savingsVsCurrent: savings,
    };
  });

  return { substitutions };
}

