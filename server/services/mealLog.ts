import { db, executeRaw } from "../config/database.js";
import { eq, and, sql, desc } from "drizzle-orm";
import {
  mealLogs,
  mealLogItems,
  mealLogStreaks,
  mealLogTemplates,
  recipeNutritionProfiles,
  products,
  b2cCustomers,
  b2cCustomerHealthProfiles,
  recipes,
} from "../../shared/goldSchema.js";

// ── Types ───────────────────────────────────────────────────────────────────

export interface AddItemInput {
  date: string;
  mealType: "breakfast" | "lunch" | "dinner" | "snack";
  recipeId?: string;
  productId?: string;
  customName?: string;
  customBrand?: string;
  servings: number;
  servingSize?: string;
  servingSizeG?: number;
  source?: string;
  notes?: string;
  imageUrl?: string;
  nutrition?: {
    calories?: number;
    proteinG?: number;
    carbsG?: number;
    fatG?: number;
    fiberG?: number;
    sugarG?: number;
    sodiumMg?: number;
    saturatedFatG?: number;
  };
}

export interface CookingLogInput {
  recipeId: string;
  servings: number;
  mealType?: "breakfast" | "lunch" | "dinner" | "snack";
  cookingStartedAt: string;
  cookingFinishedAt: string;
}

interface NutritionSnapshot {
  calories: number;
  proteinG: number;
  carbsG: number;
  fatG: number;
  fiberG: number;
  sugarG: number;
  sodiumMg: number;
  saturatedFatG: number;
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function n(val: string | number | null | undefined): number {
  if (val == null) return 0;
  const parsed = typeof val === "string" ? parseFloat(val) : val;
  return Number.isFinite(parsed) ? parsed : 0;
}

function inferMealType(): "breakfast" | "lunch" | "dinner" | "snack" {
  const hour = new Date().getHours();
  if (hour < 11) return "breakfast";
  if (hour < 15) return "lunch";
  if (hour < 20) return "dinner";
  return "snack";
}

// ── Nutrition Resolution ────────────────────────────────────────────────────

export async function getNutritionForRecipe(
  recipeId: string,
  servings: number
): Promise<NutritionSnapshot> {
  const rows = await db
    .select()
    .from(recipeNutritionProfiles)
    .where(eq(recipeNutritionProfiles.recipeId, recipeId))
    .limit(1);

  const r = rows[0];
  if (!r) return { calories: 0, proteinG: 0, carbsG: 0, fatG: 0, fiberG: 0, sugarG: 0, sodiumMg: 0, saturatedFatG: 0 };

  return {
    calories: Math.round(n(r.calories) * servings),
    proteinG: Math.round(n(r.proteinG) * servings * 100) / 100,
    carbsG: Math.round(n(r.totalCarbsG) * servings * 100) / 100,
    fatG: Math.round(n(r.totalFatG) * servings * 100) / 100,
    fiberG: Math.round(n(r.dietaryFiberG) * servings * 100) / 100,
    sugarG: Math.round(n(r.totalSugarsG) * servings * 100) / 100,
    sodiumMg: Math.round(n(r.sodiumMg) * servings),
    saturatedFatG: Math.round(n(r.saturatedFatG) * servings * 100) / 100,
  };
}

export async function getNutritionForProduct(
  productId: string,
  servings: number
): Promise<NutritionSnapshot> {
  const rows = await db
    .select()
    .from(products)
    .where(eq(products.id, productId))
    .limit(1);

  const p = rows[0];
  if (!p) return { calories: 0, proteinG: 0, carbsG: 0, fatG: 0, fiberG: 0, sugarG: 0, sodiumMg: 0, saturatedFatG: 0 };

  return {
    calories: Math.round(n(p.calories) * servings),
    proteinG: Math.round(n(p.proteinG) * servings * 100) / 100,
    carbsG: Math.round(n(p.totalCarbsG) * servings * 100) / 100,
    fatG: Math.round(n(p.totalFatG) * servings * 100) / 100,
    fiberG: Math.round(n(p.dietaryFiberG) * servings * 100) / 100,
    sugarG: Math.round(n(p.totalSugarsG) * servings * 100) / 100,
    sodiumMg: Math.round(n(p.sodiumMg) * servings),
    saturatedFatG: Math.round(n(p.saturatedFatG) * servings * 100) / 100,
  };
}

// ── Daily Log CRUD ──────────────────────────────────────────────────────────

export async function getOrCreateDailyLog(b2cCustomerId: string, date: string) {
  const existing = await db
    .select()
    .from(mealLogs)
    .where(
      and(
        eq(mealLogs.b2cCustomerId, b2cCustomerId),
        eq(mealLogs.logDate, date)
      )
    )
    .limit(1);

  if (existing[0]) return existing[0];

  const customer = await db
    .select({ householdId: b2cCustomers.householdId })
    .from(b2cCustomers)
    .where(eq(b2cCustomers.id, b2cCustomerId))
    .limit(1);

  const healthProfile = await db
    .select({ targetCalories: b2cCustomerHealthProfiles.targetCalories })
    .from(b2cCustomerHealthProfiles)
    .where(eq(b2cCustomerHealthProfiles.b2cCustomerId, b2cCustomerId))
    .limit(1);

  const inserted = await db
    .insert(mealLogs)
    .values({
      b2cCustomerId,
      householdId: customer[0]?.householdId ?? null,
      logDate: date,
      calorieGoal: healthProfile[0]?.targetCalories ?? null,
    })
    .returning();

  return inserted[0];
}

export async function getDailyLog(b2cCustomerId: string, date: string) {
  // Read-only: never creates a row. Returns log: null when no data exists for this date.
  const existing = await db
    .select()
    .from(mealLogs)
    .where(
      and(
        eq(mealLogs.b2cCustomerId, b2cCustomerId),
        eq(mealLogs.logDate, date)
      )
    )
    .limit(1);

  const log = existing[0] ?? null;

  let hydratedItems: any[] = [];

  if (log) {
    const items = await db
      .select()
      .from(mealLogItems)
      .where(eq(mealLogItems.mealLogId, log.id))
      .orderBy(mealLogItems.loggedAt);

    const recipeIds = items.filter((i) => i.recipeId).map((i) => i.recipeId!);
    const productIds = items.filter((i) => i.productId).map((i) => i.productId!);

    let recipeMap = new Map<string, { title: string; imageUrl: string | null }>();
    if (recipeIds.length > 0) {
      const recipeRows = await executeRaw(
        `SELECT id, title, image_url FROM gold.recipes WHERE id = ANY($1::uuid[])`,
        [recipeIds]
      );
      for (const r of recipeRows as any[]) {
        recipeMap.set(r.id, { title: r.title, imageUrl: r.image_url });
      }
    }

    let productMap = new Map<string, { name: string; brand: string | null; imageUrl: string | null }>();
    if (productIds.length > 0) {
      const productRows = await executeRaw(
        `SELECT id, name, brand, image_url FROM gold.products WHERE id = ANY($1::uuid[])`,
        [productIds]
      );
      for (const p of productRows as any[]) {
        productMap.set(p.id, { name: p.name, brand: p.brand, imageUrl: p.image_url });
      }
    }

    hydratedItems = items.map((item) => {
      const recipe = item.recipeId ? recipeMap.get(item.recipeId) : undefined;
      const product = item.productId ? productMap.get(item.productId) : undefined;
      return {
        ...item,
        recipeName: recipe?.title ?? undefined,
        recipeImage: recipe?.imageUrl ?? undefined,
        productName: product?.name ?? undefined,
        productBrand: product?.brand ?? undefined,
        productImage: product?.imageUrl ?? undefined,
      };
    });
  }

  const healthProfile = await db
    .select()
    .from(b2cCustomerHealthProfiles)
    .where(eq(b2cCustomerHealthProfiles.b2cCustomerId, b2cCustomerId))
    .limit(1);

  const targets = healthProfile[0]
    ? {
        targetCalories: healthProfile[0].targetCalories,
        targetProteinG: healthProfile[0].targetProteinG,
        targetCarbsG: healthProfile[0].targetCarbsG,
        targetFatG: healthProfile[0].targetFatG,
        targetFiberG: healthProfile[0].targetFiberG,
        targetSodiumMg: healthProfile[0].targetSodiumMg,
        targetSugarG: healthProfile[0].targetSugarG,
      }
    : null;

  const streak = await getStreak(b2cCustomerId);

  return { log, items: hydratedItems, targets, streak };
}

// ── Add / Update / Delete Items ─────────────────────────────────────────────

export async function addMealItem(b2cCustomerId: string, input: AddItemInput) {
  const log = await getOrCreateDailyLog(b2cCustomerId, input.date);

  let nutrition: NutritionSnapshot;
  let source = input.source ?? "manual";

  if (input.recipeId) {
    nutrition = await getNutritionForRecipe(input.recipeId, input.servings);
    if (!input.source) source = "recipe";
  } else if (input.productId) {
    nutrition = await getNutritionForProduct(input.productId, input.servings);
    if (!input.source) source = "scan";
  } else if (input.nutrition) {
    const s = input.servings;
    nutrition = {
      calories: Math.round(n(input.nutrition.calories) * s),
      proteinG: Math.round(n(input.nutrition.proteinG) * s * 100) / 100,
      carbsG: Math.round(n(input.nutrition.carbsG) * s * 100) / 100,
      fatG: Math.round(n(input.nutrition.fatG) * s * 100) / 100,
      fiberG: Math.round(n(input.nutrition.fiberG) * s * 100) / 100,
      sugarG: Math.round(n(input.nutrition.sugarG) * s * 100) / 100,
      sodiumMg: Math.round(n(input.nutrition.sodiumMg) * s),
      saturatedFatG: Math.round(n(input.nutrition.saturatedFatG) * s * 100) / 100,
    };
  } else {
    nutrition = { calories: 0, proteinG: 0, carbsG: 0, fatG: 0, fiberG: 0, sugarG: 0, sodiumMg: 0, saturatedFatG: 0 };
  }

  const inserted = await db
    .insert(mealLogItems)
    .values({
      mealLogId: log.id,
      mealType: input.mealType,
      recipeId: input.recipeId ?? null,
      productId: input.productId ?? null,
      customName: input.customName ?? null,
      customBrand: input.customBrand ?? null,
      servings: String(input.servings),
      servingSize: input.servingSize ?? null,
      servingSizeG: input.servingSizeG ? String(input.servingSizeG) : null,
      calories: nutrition.calories,
      proteinG: String(nutrition.proteinG),
      carbsG: String(nutrition.carbsG),
      fatG: String(nutrition.fatG),
      fiberG: String(nutrition.fiberG),
      sugarG: String(nutrition.sugarG),
      sodiumMg: nutrition.sodiumMg,
      saturatedFatG: String(nutrition.saturatedFatG),
      source,
      notes: input.notes ?? null,
      imageUrl: input.imageUrl ?? null,
    })
    .returning();

  const updatedTotals = await recalculateDailyTotals(log.id);
  await updateStreak(b2cCustomerId, input.date);

  return { item: inserted[0], updatedTotals };
}

export async function updateMealItem(
  itemId: string,
  b2cCustomerId: string,
  updates: { servings?: number; mealType?: string; notes?: string }
) {
  const item = await db
    .select()
    .from(mealLogItems)
    .where(eq(mealLogItems.id, itemId))
    .limit(1);

  if (!item[0]) {
    const err = new Error("Meal log item not found");
    (err as any).status = 404;
    throw err;
  }

  const logRow = await db
    .select({ b2cCustomerId: mealLogs.b2cCustomerId })
    .from(mealLogs)
    .where(eq(mealLogs.id, item[0].mealLogId))
    .limit(1);

  if (logRow[0]?.b2cCustomerId !== b2cCustomerId) {
    const err = new Error("Not authorized to update this item");
    (err as any).status = 403;
    throw err;
  }

  const setValues: Record<string, any> = {};
  if (updates.mealType) setValues.mealType = updates.mealType;
  if (updates.notes !== undefined) setValues.notes = updates.notes;

  if (updates.servings != null && updates.servings !== n(item[0].servings)) {
    const oldServings = n(item[0].servings) || 1;
    const ratio = updates.servings / oldServings;
    setValues.servings = String(updates.servings);
    setValues.calories = Math.round(n(item[0].calories) * ratio);
    setValues.proteinG = String(Math.round(n(item[0].proteinG) * ratio * 100) / 100);
    setValues.carbsG = String(Math.round(n(item[0].carbsG) * ratio * 100) / 100);
    setValues.fatG = String(Math.round(n(item[0].fatG) * ratio * 100) / 100);
    setValues.fiberG = String(Math.round(n(item[0].fiberG) * ratio * 100) / 100);
    setValues.sugarG = String(Math.round(n(item[0].sugarG) * ratio * 100) / 100);
    setValues.sodiumMg = Math.round(n(item[0].sodiumMg) * ratio);
    setValues.saturatedFatG = String(Math.round(n(item[0].saturatedFatG) * ratio * 100) / 100);
  }

  if (Object.keys(setValues).length === 0) {
    return { item: item[0], updatedTotals: null };
  }

  const updated = await db
    .update(mealLogItems)
    .set(setValues)
    .where(eq(mealLogItems.id, itemId))
    .returning();

  const updatedTotals = await recalculateDailyTotals(item[0].mealLogId);
  return { item: updated[0], updatedTotals };
}

export async function deleteMealItem(itemId: string, b2cCustomerId: string) {
  const item = await db
    .select()
    .from(mealLogItems)
    .where(eq(mealLogItems.id, itemId))
    .limit(1);

  if (!item[0]) {
    const err = new Error("Meal log item not found");
    (err as any).status = 404;
    throw err;
  }

  const logRow = await db
    .select({ b2cCustomerId: mealLogs.b2cCustomerId })
    .from(mealLogs)
    .where(eq(mealLogs.id, item[0].mealLogId))
    .limit(1);

  if (logRow[0]?.b2cCustomerId !== b2cCustomerId) {
    const err = new Error("Not authorized to delete this item");
    (err as any).status = 403;
    throw err;
  }

  await db.delete(mealLogItems).where(eq(mealLogItems.id, itemId));

  const updatedTotals = await recalculateDailyTotals(item[0].mealLogId);
  return { success: true, updatedTotals };
}

// ── Recalculate Daily Totals ────────────────────────────────────────────────

export async function recalculateDailyTotals(logId: string) {
  const rows = await executeRaw(
    `SELECT
       COALESCE(SUM(calories), 0)::int                            AS total_calories,
       COALESCE(SUM(protein_g::numeric), 0)::numeric(8,2)         AS total_protein_g,
       COALESCE(SUM(carbs_g::numeric), 0)::numeric(8,2)           AS total_carbs_g,
       COALESCE(SUM(fat_g::numeric), 0)::numeric(8,2)             AS total_fat_g,
       COALESCE(SUM(fiber_g::numeric), 0)::numeric(8,2)           AS total_fiber_g,
       COALESCE(SUM(sugar_g::numeric), 0)::numeric(8,2)           AS total_sugar_g,
       COALESCE(SUM(sodium_mg), 0)::int                           AS total_sodium_mg
     FROM gold.meal_log_items
     WHERE meal_log_id = $1`,
    [logId]
  );

  const totals = (rows as any[])[0] ?? {};

  const log = await db
    .select({ calorieGoal: mealLogs.calorieGoal })
    .from(mealLogs)
    .where(eq(mealLogs.id, logId))
    .limit(1);

  const goalMet =
    log[0]?.calorieGoal != null &&
    n(totals.total_calories) > 0 &&
    n(totals.total_calories) <= n(log[0].calorieGoal) * 1.1 &&
    n(totals.total_calories) >= n(log[0].calorieGoal) * 0.8;

  const updated = await db
    .update(mealLogs)
    .set({
      totalCalories: n(totals.total_calories),
      totalProteinG: String(totals.total_protein_g ?? 0),
      totalCarbsG: String(totals.total_carbs_g ?? 0),
      totalFatG: String(totals.total_fat_g ?? 0),
      totalFiberG: String(totals.total_fiber_g ?? 0),
      totalSugarG: String(totals.total_sugar_g ?? 0),
      totalSodiumMg: n(totals.total_sodium_mg),
      goalMet,
    })
    .where(eq(mealLogs.id, logId))
    .returning();

  return updated[0];
}

// ── Water Tracking ──────────────────────────────────────────────────────────

export async function updateWaterIntake(
  b2cCustomerId: string,
  date: string,
  amountMl: number
) {
  const log = await getOrCreateDailyLog(b2cCustomerId, date);

  const newTotal = Math.max(0, (log.waterMl ?? 0) + amountMl);
  const updated = await db
    .update(mealLogs)
    .set({ waterMl: newTotal })
    .where(eq(mealLogs.id, log.id))
    .returning();

  return {
    waterMl: updated[0].waterMl,
    waterGoalMl: updated[0].waterGoalMl,
  };
}

// ── Copy Day ────────────────────────────────────────────────────────────────

export async function copyDay(
  b2cCustomerId: string,
  sourceDate: string,
  targetDate: string
) {
  const sourceLog = await db
    .select()
    .from(mealLogs)
    .where(
      and(
        eq(mealLogs.b2cCustomerId, b2cCustomerId),
        eq(mealLogs.logDate, sourceDate)
      )
    )
    .limit(1);

  if (!sourceLog[0]) {
    const err = new Error("No meal log found for source date");
    (err as any).status = 404;
    throw err;
  }

  const sourceItems = await db
    .select()
    .from(mealLogItems)
    .where(eq(mealLogItems.mealLogId, sourceLog[0].id));

  if (sourceItems.length === 0) {
    return { items: [] };
  }

  const targetLog = await getOrCreateDailyLog(b2cCustomerId, targetDate);

  const newItems = sourceItems.map((item) => ({
    mealLogId: targetLog.id,
    mealType: item.mealType,
    recipeId: item.recipeId,
    productId: item.productId,
    customName: item.customName,
    customBrand: item.customBrand,
    servings: item.servings,
    servingSize: item.servingSize,
    servingSizeG: item.servingSizeG,
    calories: item.calories,
    proteinG: item.proteinG,
    carbsG: item.carbsG,
    fatG: item.fatG,
    fiberG: item.fiberG,
    sugarG: item.sugarG,
    sodiumMg: item.sodiumMg,
    saturatedFatG: item.saturatedFatG,
    source: "copy" as const,
    notes: item.notes,
    imageUrl: item.imageUrl,
  }));

  const inserted = await db.insert(mealLogItems).values(newItems).returning();
  await recalculateDailyTotals(targetLog.id);
  await updateStreak(b2cCustomerId, targetDate);

  return { items: inserted };
}

// ── History / Trends ────────────────────────────────────────────────────────

export async function getHistory(
  b2cCustomerId: string,
  startDate: string,
  endDate: string
) {
  const rows = await executeRaw(
    `SELECT
       log_date                       AS date,
       total_calories,
       total_protein_g,
       total_carbs_g,
       total_fat_g,
       goal_met,
       (SELECT count(*) FROM gold.meal_log_items WHERE meal_log_id = ml.id)::int AS item_count
     FROM gold.meal_logs ml
     WHERE b2c_customer_id = $1
       AND log_date BETWEEN $2 AND $3
     ORDER BY log_date`,
    [b2cCustomerId, startDate, endDate]
  );

  const days = rows as any[];

  const avgRows = await executeRaw(
    `SELECT
       COALESCE(AVG(total_calories), 0)::int        AS avg_calories,
       COALESCE(AVG(total_protein_g::numeric), 0)    AS avg_protein_g,
       COALESCE(AVG(total_carbs_g::numeric), 0)      AS avg_carbs_g,
       COALESCE(AVG(total_fat_g::numeric), 0)        AS avg_fat_g
     FROM gold.meal_logs
     WHERE b2c_customer_id = $1
       AND log_date BETWEEN $2 AND $3
       AND total_calories > 0`,
    [b2cCustomerId, startDate, endDate]
  );

  const averages = (avgRows as any[])[0] ?? {};

  return { days, averages };
}

// ── Streak ──────────────────────────────────────────────────────────────────

export async function getStreak(b2cCustomerId: string) {
  const rows = await db
    .select()
    .from(mealLogStreaks)
    .where(eq(mealLogStreaks.b2cCustomerId, b2cCustomerId))
    .limit(1);

  return rows[0] ?? { currentStreak: 0, longestStreak: 0, totalDaysLogged: 0, lastLoggedDate: null };
}

export async function updateStreak(b2cCustomerId: string, dateStr: string) {
  const existing = await db
    .select()
    .from(mealLogStreaks)
    .where(eq(mealLogStreaks.b2cCustomerId, b2cCustomerId))
    .limit(1);

  const today = new Date(dateStr + "T00:00:00Z");

  if (!existing[0]) {
    await db.insert(mealLogStreaks).values({
      b2cCustomerId,
      currentStreak: 1,
      longestStreak: 1,
      lastLoggedDate: dateStr,
      totalDaysLogged: 1,
    });
    return;
  }

  const streak = existing[0];
  const lastLogged = streak.lastLoggedDate
    ? new Date(streak.lastLoggedDate + "T00:00:00Z")
    : null;

  if (lastLogged && lastLogged.getTime() === today.getTime()) {
    return;
  }

  const yesterday = new Date(today);
  yesterday.setUTCDate(yesterday.getUTCDate() - 1);

  let newCurrent: number;
  if (lastLogged && lastLogged.getTime() === yesterday.getTime()) {
    newCurrent = (streak.currentStreak ?? 0) + 1;
  } else {
    newCurrent = 1;
  }

  const newLongest = Math.max(streak.longestStreak ?? 0, newCurrent);
  const newTotal = (streak.totalDaysLogged ?? 0) + 1;

  await db
    .update(mealLogStreaks)
    .set({
      currentStreak: newCurrent,
      longestStreak: newLongest,
      lastLoggedDate: dateStr,
      totalDaysLogged: newTotal,
    })
    .where(eq(mealLogStreaks.id, streak.id));
}

// ── Cooking Integration ─────────────────────────────────────────────────────

export async function logFromCooking(
  b2cCustomerId: string,
  input: CookingLogInput
) {
  const todayStr = new Date().toISOString().slice(0, 10);
  const mealType = input.mealType ?? inferMealType();

  const nutrition = await getNutritionForRecipe(input.recipeId, input.servings);

  const log = await getOrCreateDailyLog(b2cCustomerId, todayStr);

  const inserted = await db
    .insert(mealLogItems)
    .values({
      mealLogId: log.id,
      mealType,
      recipeId: input.recipeId,
      servings: String(input.servings),
      calories: nutrition.calories,
      proteinG: String(nutrition.proteinG),
      carbsG: String(nutrition.carbsG),
      fatG: String(nutrition.fatG),
      fiberG: String(nutrition.fiberG),
      sugarG: String(nutrition.sugarG),
      sodiumMg: nutrition.sodiumMg,
      saturatedFatG: String(nutrition.saturatedFatG),
      cookedViaApp: true,
      cookingStartedAt: new Date(input.cookingStartedAt),
      cookingFinishedAt: new Date(input.cookingFinishedAt),
      source: "cooking_mode",
    })
    .returning();

  await recalculateDailyTotals(log.id);
  await updateStreak(b2cCustomerId, todayStr);

  return { item: inserted[0] };
}

// ── Templates ───────────────────────────────────────────────────────────────

export async function getTemplates(b2cCustomerId: string) {
  return db
    .select()
    .from(mealLogTemplates)
    .where(eq(mealLogTemplates.b2cCustomerId, b2cCustomerId))
    .orderBy(desc(mealLogTemplates.useCount));
}

export async function createTemplate(
  b2cCustomerId: string,
  data: { name: string; mealType?: string; items: any[] }
) {
  const inserted = await db
    .insert(mealLogTemplates)
    .values({
      b2cCustomerId,
      templateName: data.name,
      mealType: data.mealType ?? null,
      items: data.items,
    })
    .returning();

  return inserted[0];
}
