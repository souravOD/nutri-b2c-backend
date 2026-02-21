import { db, executeRaw } from "../config/database.js";
import { recipes, auditLog } from "../../shared/goldSchema.js";
import { eq, desc } from "drizzle-orm";
import type { InsertRecipe } from "../../shared/goldSchema.js";
import { auditLogEntry } from "../middleware/audit.js";

export async function createCuratedRecipe(adminUserId: string, recipeData: InsertRecipe, reason?: string) {
  const recipe = await db
    .insert(recipes)
    .values({
      ...recipeData,
      sourceType: recipeData.sourceType ?? "curated",
      createdByUserId: recipeData.createdByUserId ?? null,
      createdAt: new Date(),
      updatedAt: new Date(),
    })
    .returning();

  await auditLogEntry(
    adminUserId,
    "CREATE_CURATED_RECIPE",
    "recipes",
    recipe[0].id,
    null,
    recipe[0],
    reason
  );

  return recipe[0];
}

export async function updateCuratedRecipe(
  adminUserId: string,
  recipeId: string,
  updates: Partial<InsertRecipe>,
  reason?: string
) {
  const before = await db.select().from(recipes).where(eq(recipes.id, recipeId)).limit(1);

  if (before.length === 0) {
    throw new Error("Recipe not found");
  }

  const updated = await db
    .update(recipes)
    .set({
      ...updates,
      updatedAt: new Date(),
    })
    .where(eq(recipes.id, recipeId))
    .returning();

  await auditLogEntry(
    adminUserId,
    "UPDATE_CURATED_RECIPE",
    "recipes",
    recipeId,
    before[0],
    updated[0],
    reason
  );

  return updated[0];
}

export async function deleteCuratedRecipe(adminUserId: string, recipeId: string, reason: string) {
  const before = await db.select().from(recipes).where(eq(recipes.id, recipeId)).limit(1);

  if (before.length === 0) {
    throw new Error("Recipe not found");
  }

  await db.delete(recipes).where(eq(recipes.id, recipeId));

  await auditLogEntry(
    adminUserId,
    "DELETE_CURATED_RECIPE",
    "recipes",
    recipeId,
    before[0],
    null,
    reason
  );

  return { success: true };
}

export async function getReports(_status?: string, _limit: number = 50, _offset: number = 0) {
  return [];
}

export async function resolveReport(
  _adminUserId: string,
  _reportId: string,
  _action: string,
  _reason: string,
  _notes?: string
) {
  throw new Error("Recipe reports are not supported in the gold schema.");
}

export async function getAuditLog(limit: number = 100, offset: number = 0, actorUserId?: string) {
  if (actorUserId) {
    return db
      .select()
      .from(auditLog)
      .where(eq(auditLog.changedBy, actorUserId))
      .orderBy(desc(auditLog.changedAt))
      .limit(limit)
      .offset(offset);
  }

  return db
    .select()
    .from(auditLog)
    .orderBy(desc(auditLog.changedAt))
    .limit(limit)
    .offset(offset);
}

export async function auditImpersonation(
  adminUserId: string,
  targetUserId: string,
  url: string,
  ip?: string,
  userAgent?: string
) {
  await auditLogEntry(
    adminUserId,
    "USER_IMPERSONATION",
    "users",
    targetUserId,
    null,
    { url, ip, userAgent },
    "Admin impersonation for support/debugging"
  );
}

export async function refreshMaterializedViews(): Promise<{ success: boolean; duration: number }> {
  throw new Error("Materialized views are not configured for the gold schema.");
}

export async function getDashboardStats() {
  try {
    const [totalRecipesRows, activeUsersRows] = await Promise.all([
      executeRaw("select count(*)::int as count from gold.recipes"),
      executeRaw(
        "select count(distinct b2c_customer_id)::int as count from gold.customer_product_interactions where interaction_timestamp > now() - interval '30 days' and b2c_customer_id is not null"
      ),
    ]);

    return {
      totalRecipes: totalRecipesRows[0]?.count ?? 0,
      activeUsers: activeUsersRows[0]?.count ?? 0,
      searchQps: 0,
      pendingReview: 0,
    };
  } catch (error) {
    console.error("Dashboard stats error:", error);
    throw new Error("Failed to get dashboard stats");
  }
}
