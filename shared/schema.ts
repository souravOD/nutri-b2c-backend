import { sql } from "drizzle-orm";
import { pgTable, text, varchar, integer, numeric, boolean, timestamp, jsonb, uuid, index, unique } from "drizzle-orm/pg-core";
import { createInsertSchema, createSelectSchema } from "drizzle-zod";
import { z } from "zod";

// Taxonomy Tables
export const taxAllergens = pgTable("tax_allergens", {
  id: varchar("id").primaryKey(),
  name: text("name").notNull(),
  commonNames: text("common_names").array(),
  isTop9: boolean("is_top_9").default(false),
  createdAt: timestamp("created_at").defaultNow(),
});

export const taxDiets = pgTable("tax_diets", {
  id: varchar("id").primaryKey(),
  name: text("name").notNull(),
  description: text("description"),
  category: varchar("category"), // 'primary', 'lifestyle', 'medical'
  createdAt: timestamp("created_at").defaultNow(),
});

export const taxCuisines = pgTable("tax_cuisines", {
  id: varchar("id").primaryKey(),
  name: text("name").notNull(),
  region: text("region"),
  parentId: varchar("parent_id"),
  createdAt: timestamp("created_at").defaultNow(),
});

export const taxFlags = pgTable("tax_flags", {
  id: varchar("id").primaryKey(),
  name: text("name").notNull(),
  category: varchar("category"), // 'health', 'preference', 'restriction'
  description: text("description"),
  createdAt: timestamp("created_at").defaultNow(),
});

// Core Recipe Tables
export const recipes = pgTable("recipes", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  title: text("title").notNull(),
  description: text("description"),
  imageUrl: text("image_url"),
  sourceUrl: text("source_url"),
  
  // Nutrition (required for search/filtering)
  calories: integer("calories"),
  proteinG: numeric("protein_g", { precision: 8, scale: 2 }),
  carbsG: numeric("carbs_g", { precision: 8, scale: 2 }),
  fatG: numeric("fat_g", { precision: 8, scale: 2 }),
  fiberG: numeric("fiber_g", { precision: 8, scale: 2 }),
  sugarG: numeric("sugar_g", { precision: 8, scale: 2 }),
  sodiumMg: integer("sodium_mg"),
  saturatedFatG: numeric("saturated_fat_g", { precision: 8, scale: 2 }),
  
  // Recipe metadata
  totalTimeMinutes: integer("total_time_minutes"),
  prepTimeMinutes: integer("prep_time_minutes"),
  cookTimeMinutes: integer("cook_time_minutes"),
  servings: integer("servings"),
  difficulty: varchar("difficulty"), // 'easy', 'medium', 'hard'
  mealType: varchar("meal_type"), // 'breakfast', 'lunch', 'dinner', 'snack'
  
  // Taxonomy arrays
  cuisines: text("cuisines").array().default([]),
  dietTags: text("diet_tags").array().default([]),
  allergens: text("allergens").array().default([]),
  flags: text("flags").array().default([]),
  
  // Recipe content
  ingredients: jsonb("ingredients"), // Array of ingredient objects
  instructions: jsonb("instructions"), // Array of instruction steps
  notes: text("notes"),
  
  // Search and categorization
  searchText: text("search_text"), // Trigger-maintained for FTS
  tsv: text("tsv"), // Full-text search vector (tsvector)
  
  // Publishing
  status: varchar("status").default("draft"), // 'draft', 'published', 'archived'
  marketCountry: varchar("market_country").default("US"),
  
  // Tracking
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
  publishedAt: timestamp("published_at"),
  
  // Source tracking
  sourceType: varchar("source_type").default("curated"), // 'curated', 'user_generated'
  sourceUserId: varchar("source_user_id"), // For UGC approval tracking
}, (table) => ({
  cuisinesIdx: index("idx_recipes_cuisines").using("gin", table.cuisines),
  dietTagsIdx: index("idx_recipes_diet_tags").using("gin", table.dietTags),
  allergensIdx: index("idx_recipes_allergens").using("gin", table.allergens),
  statusIdx: index("idx_recipes_status").on(table.status),
  marketIdx: index("idx_recipes_market").on(table.marketCountry),
  updatedAtIdx: index("idx_recipes_updated_at").on(table.updatedAt),
}));

// User-Generated Content
export const userRecipes = pgTable("user_recipes", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  ownerUserId: varchar("owner_user_id").notNull(),
  
  // Recipe data (same structure as recipes)
  title: text("title").notNull(),
  description: text("description"),
  imageUrl: text("image_url"),
  
  // Nutrition
  calories: integer("calories"),
  proteinG: numeric("protein_g", { precision: 8, scale: 2 }),
  carbsG: numeric("carbs_g", { precision: 8, scale: 2 }),
  fatG: numeric("fat_g", { precision: 8, scale: 2 }),
  fiberG: numeric("fiber_g", { precision: 8, scale: 2 }),
  sugarG: numeric("sugar_g", { precision: 8, scale: 2 }),
  sodiumMg: integer("sodium_mg"),
  saturatedFatG: numeric("saturated_fat_g", { precision: 8, scale: 2 }),
  
  // Recipe metadata
  totalTimeMinutes: integer("total_time_minutes"),
  prepTimeMinutes: integer("prep_time_minutes"),
  cookTimeMinutes: integer("cook_time_minutes"),
  servings: integer("servings"),
  difficulty: varchar("difficulty"),
  mealType: varchar("meal_type"),
  
  // Taxonomy
  cuisines: text("cuisines").array().default([]),
  dietTags: text("diet_tags").array().default([]),
  allergens: text("allergens").array().default([]),
  flags: text("flags").array().default([]),
  
  // Content
  ingredients: jsonb("ingredients"),
  instructions: jsonb("instructions"),
  notes: text("notes"),
  
  // Sharing and visibility
  visibility: varchar("visibility").default("private"), // 'private', 'shared', 'submitted'
  shareSlug: varchar("share_slug").unique(),
  
  // Review workflow
  submittedAt: timestamp("submitted_at"),
  reviewStatus: varchar("review_status").default("pending"), // 'pending', 'approved', 'rejected'
  reviewedBy: varchar("reviewed_by"),
  reviewedAt: timestamp("reviewed_at"),
  reviewNotes: text("review_notes"),
  approvedRecipeId: uuid("approved_recipe_id").references(() => recipes.id),
  
  // Tracking
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
}, (table) => ({
  ownerIdx: index("idx_user_recipes_owner").on(table.ownerUserId),
  shareSlugIdx: index("idx_user_recipes_share_slug").on(table.shareSlug),
  reviewStatusIdx: index("idx_user_recipes_review_status").on(table.reviewStatus),
  submittedAtIdx: index("idx_user_recipes_submitted_at").on(table.submittedAt),
}));

// User Interactions
export const savedRecipes = pgTable("saved_recipes", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  userId: varchar("user_id").notNull(),
  recipeId: uuid("recipe_id").notNull().references(() => recipes.id, { onDelete: "cascade" }),
  savedAt: timestamp("saved_at").defaultNow(),
}, (table) => ({
  userRecipeUnique: unique().on(table.userId, table.recipeId),
  userIdx: index("idx_saved_recipes_user").on(table.userId),
  savedAtIdx: index("idx_saved_recipes_saved_at").on(table.savedAt),
}));

export const recipeHistory = pgTable("recipe_history", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  userId: varchar("user_id").notNull(),
  recipeId: uuid("recipe_id").notNull().references(() => recipes.id, { onDelete: "cascade" }),
  event: varchar("event").notNull(), // 'viewed', 'cooked', 'shared'
  at: timestamp("at").defaultNow(),
  metadata: jsonb("metadata"), // Additional event data
}, (table) => ({
  userRecipeEventIdx: index("idx_recipe_history_user_recipe_event").on(table.userId, table.recipeId, table.event),
  userEventAtIdx: index("idx_recipe_history_user_event_at").on(table.userId, table.event, table.at),
  recipeEventAtIdx: index("idx_recipe_history_recipe_event_at").on(table.recipeId, table.event, table.at),
}));

// User Profiles
export const userProfiles = pgTable("user_profiles", {
  userId: varchar("user_id").primaryKey(),
  profileDiets: text("profile_diets").array().default([]),
  profileAllergens: text("profile_allergens").array().default([]),
  preferredCuisines: text("preferred_cuisines").array().default([]),
  
  // Macro targets (for personalized feed)
  targetCalories: integer("target_calories"),
  targetProteinG: numeric("target_protein_g", { precision: 8, scale: 2 }),
  targetCarbsG: numeric("target_carbs_g", { precision: 8, scale: 2 }),
  targetFatG: numeric("target_fat_g", { precision: 8, scale: 2 }),
  
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
});

// Moderation System
export const recipeReports = pgTable("recipe_reports", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  reporterUserId: varchar("reporter_user_id").notNull(),
  recipeId: uuid("recipe_id").references(() => recipes.id),
  userRecipeId: uuid("user_recipe_id").references(() => userRecipes.id),
  
  category: varchar("category").notNull(), // 'inappropriate', 'copyright', 'nutrition', 'spam'
  reason: text("reason").notNull(),
  description: text("description"),
  
  status: varchar("status").default("open"), // 'open', 'investigating', 'resolved', 'dismissed'
  priority: varchar("priority").default("medium"), // 'low', 'medium', 'high', 'critical'
  
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
}, (table) => ({
  statusIdx: index("idx_recipe_reports_status").on(table.status),
  priorityIdx: index("idx_recipe_reports_priority").on(table.priority),
  createdAtIdx: index("idx_recipe_reports_created_at").on(table.createdAt),
}));

export const recipeReportResolutions = pgTable("recipe_report_resolutions", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  reportId: uuid("report_id").notNull().references(() => recipeReports.id),
  resolvedBy: varchar("resolved_by").notNull(),
  action: varchar("action").notNull(), // 'dismiss', 'remove_content', 'warn_user', 'ban_user'
  reason: text("reason").notNull(),
  notes: text("notes"),
  
  createdAt: timestamp("created_at").defaultNow(),
}, (table) => ({
  reportIdx: index("idx_report_resolutions_report").on(table.reportId),
  resolvedByIdx: index("idx_report_resolutions_resolved_by").on(table.resolvedBy),
}));

// Admin and Security
export const auditLog = pgTable("audit_log", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  at: timestamp("at").defaultNow(),
  actorUserId: varchar("actor_user_id").notNull(),
  action: varchar("action").notNull(),
  targetTable: varchar("target_table").notNull(),
  targetId: varchar("target_id").notNull(),
  diff: jsonb("diff"), // { before: {...}, after: {...} }
  reason: text("reason"),
  ip: varchar("ip"),
  ua: text("ua"), // User agent
}, (table) => ({
  atIdx: index("idx_audit_log_at").on(table.at),
  actorIdx: index("idx_audit_log_actor").on(table.actorUserId),
  actionIdx: index("idx_audit_log_action").on(table.action),
  targetIdx: index("idx_audit_log_target").on(table.targetTable, table.targetId),
}));

export const idempotencyKeys = pgTable("idempotency_keys", {
  key: varchar("key").primaryKey(),
  method: varchar("method").notNull(),
  path: text("path").notNull(),
  requestHash: varchar("request_hash").notNull(),
  responseStatus: integer("response_status"),
  responseBody: jsonb("response_body"),
  createdAt: timestamp("created_at").defaultNow(),
  processedAt: timestamp("processed_at"),
}, (table) => ({
  createdAtIdx: index("idx_idempotency_created_at").on(table.createdAt),
}));

// Insert/Select schemas
export const insertRecipeSchema = createInsertSchema(recipes).omit({
  id: true,
  searchText: true,
  tsv: true,
  createdAt: true,
  updatedAt: true,
  publishedAt: true,
});

export const insertUserRecipeSchema = createInsertSchema(userRecipes).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
  submittedAt: true,
  reviewedAt: true,
  approvedRecipeId: true,
});

export const insertSavedRecipeSchema = createInsertSchema(savedRecipes).omit({
  id: true,
  savedAt: true,
});

export const insertRecipeHistorySchema = createInsertSchema(recipeHistory).omit({
  id: true,
  at: true,
});

export const insertUserProfileSchema = createInsertSchema(userProfiles).omit({
  createdAt: true,
  updatedAt: true,
});

export const insertRecipeReportSchema = createInsertSchema(recipeReports).omit({
  id: true,
  status: true,
  priority: true,
  createdAt: true,
  updatedAt: true,
});

// Types
export type Recipe = typeof recipes.$inferSelect;
export type InsertRecipe = z.infer<typeof insertRecipeSchema>;
export type UserRecipe = typeof userRecipes.$inferSelect;
export type InsertUserRecipe = z.infer<typeof insertUserRecipeSchema>;
export type SavedRecipe = typeof savedRecipes.$inferSelect;
export type InsertSavedRecipe = z.infer<typeof insertSavedRecipeSchema>;
export type RecipeHistory = typeof recipeHistory.$inferSelect;
export type InsertRecipeHistory = z.infer<typeof insertRecipeHistorySchema>;
export type UserProfile = typeof userProfiles.$inferSelect;
export type InsertUserProfile = z.infer<typeof insertUserProfileSchema>;
export type RecipeReport = typeof recipeReports.$inferSelect;
export type InsertRecipeReport = z.infer<typeof insertRecipeReportSchema>;
export type AuditLog = typeof auditLog.$inferSelect;

// Legacy user table (keeping for compatibility)
export const users = pgTable("users", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  username: text("username").notNull().unique(),
  password: text("password").notNull(),
});

export const insertUserSchema = createInsertSchema(users).pick({
  username: true,
  password: true,
});

export type InsertUser = z.infer<typeof insertUserSchema>;
export type User = typeof users.$inferSelect;
