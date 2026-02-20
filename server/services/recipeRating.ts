import { db } from "../config/database.js";
import { eq, and, lte, sql } from "drizzle-orm";
import { recipeRatings } from "../../shared/goldSchema.js";

// ── Types ───────────────────────────────────────────────────────────────────

export interface RateRecipeInput {
  rating: number;
  feedbackText?: string;
  likedAspects?: string[];
  dislikedAspects?: string[];
  wouldMakeAgain?: boolean;
  mealPlanItemId?: string;
}

// ── Rate Recipe (Upsert) ────────────────────────────────────────────────────

export async function rateRecipe(
  b2cCustomerId: string,
  recipeId: string,
  input: RateRecipeInput
) {
  const existing = await db
    .select()
    .from(recipeRatings)
    .where(
      and(
        eq(recipeRatings.recipeId, recipeId),
        eq(recipeRatings.b2cCustomerId, b2cCustomerId)
      )
    )
    .limit(1);

  if (existing[0]) {
    const updated = await db
      .update(recipeRatings)
      .set({
        rating: input.rating,
        feedbackText: input.feedbackText ?? existing[0].feedbackText,
        likedAspects: input.likedAspects ?? existing[0].likedAspects,
        dislikedAspects: input.dislikedAspects ?? existing[0].dislikedAspects,
        wouldMakeAgain: input.wouldMakeAgain ?? existing[0].wouldMakeAgain,
        mealPlanItemId: input.mealPlanItemId ?? existing[0].mealPlanItemId,
      })
      .where(eq(recipeRatings.id, existing[0].id))
      .returning();
    return updated[0];
  }

  const inserted = await db
    .insert(recipeRatings)
    .values({
      recipeId,
      b2cCustomerId,
      rating: input.rating,
      feedbackText: input.feedbackText ?? null,
      likedAspects: input.likedAspects ?? null,
      dislikedAspects: input.dislikedAspects ?? null,
      wouldMakeAgain: input.wouldMakeAgain ?? null,
      mealPlanItemId: input.mealPlanItemId ?? null,
    })
    .returning();

  return inserted[0];
}

// ── Get User's Own Rating ───────────────────────────────────────────────────

export async function getUserRating(b2cCustomerId: string, recipeId: string) {
  const rows = await db
    .select()
    .from(recipeRatings)
    .where(
      and(
        eq(recipeRatings.recipeId, recipeId),
        eq(recipeRatings.b2cCustomerId, b2cCustomerId)
      )
    )
    .limit(1);

  return rows[0] ?? null;
}

// ── Get Low-Rated Recipe IDs (for meal plan exclusion) ──────────────────────

export async function getLowRatedRecipeIds(
  b2cCustomerId: string,
  threshold = 2
): Promise<string[]> {
  const rows = await db
    .select({ recipeId: recipeRatings.recipeId })
    .from(recipeRatings)
    .where(
      and(
        eq(recipeRatings.b2cCustomerId, b2cCustomerId),
        lte(recipeRatings.rating, threshold)
      )
    );

  return rows.map((r) => r.recipeId);
}

// ── Get Recipe Average Rating ───────────────────────────────────────────────

export async function getRecipeAverageRating(recipeId: string) {
  const rows = await db
    .select({
      avgRating: sql<number>`ROUND(AVG(${recipeRatings.rating})::numeric, 1)`,
      count: sql<number>`COUNT(*)::int`,
    })
    .from(recipeRatings)
    .where(eq(recipeRatings.recipeId, recipeId));

  const row = rows[0];
  return {
    averageRating: row?.avgRating ?? null,
    ratingCount: row?.count ?? 0,
  };
}
