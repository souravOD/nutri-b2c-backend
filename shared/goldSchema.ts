import { sql } from "drizzle-orm";
import {
  pgSchema,
  uuid,
  varchar,
  text,
  integer,
  numeric,
  boolean,
  timestamp,
  jsonb,
  date,
} from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod";

const gold = pgSchema("gold");

export const households = gold.table("households", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  householdName: varchar("household_name", { length: 255 }),
  primaryAccountEmail: varchar("primary_account_email", { length: 255 }).notNull(),
  householdType: varchar("household_type", { length: 20 }).default("individual"),
  totalMembers: integer("total_members").default(1),
  locationCountry: varchar("location_country", { length: 100 }),
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
});

export const b2cCustomers = gold.table("b2c_customers", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  householdId: uuid("household_id"),
  email: varchar("email", { length: 255 }),
  fullName: varchar("full_name", { length: 255 }).notNull(),
  firstName: varchar("first_name", { length: 100 }),
  lastName: varchar("last_name", { length: 100 }),
  birthMonth: integer("birth_month"),
  birthYear: integer("birth_year"),
  dateOfBirth: date("date_of_birth"),
  age: integer("age"),
  gender: varchar("gender", { length: 30 }),
  phone: varchar("phone", { length: 50 }),
  householdRole: varchar("household_role", { length: 20 }).default("primary_adult"),
  isProfileOwner: boolean("is_profile_owner").default(false),
  accountStatus: varchar("account_status", { length: 20 }).default("active"),
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
  appwriteUserId: text("appwrite_user_id").unique(),
  silverCustomerId: uuid("silver_customer_id"),
});

export const b2cCustomerHealthProfiles = gold.table("b2c_customer_health_profiles", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  b2cCustomerId: uuid("b2c_customer_id").notNull(),
  heightCm: numeric("height_cm", { precision: 5, scale: 2 }),
  weightKg: numeric("weight_kg", { precision: 5, scale: 2 }),
  bmi: numeric("bmi", { precision: 4, scale: 2 }),
  bmr: numeric("bmr"),
  tdee: numeric("tdee"),
  activityLevel: varchar("activity_level", { length: 20 }),
  healthGoal: varchar("health_goal", { length: 100 }),
  targetWeightKg: numeric("target_weight_kg", { precision: 5, scale: 2 }),
  targetCalories: integer("target_calories"),
  targetProteinG: numeric("target_protein_g", { precision: 6, scale: 2 }),
  targetCarbsG: numeric("target_carbs_g", { precision: 6, scale: 2 }),
  targetFatG: numeric("target_fat_g", { precision: 6, scale: 2 }),
  targetFiberG: numeric("target_fiber_g", { precision: 6, scale: 2 }),
  targetSodiumMg: integer("target_sodium_mg"),
  targetSugarG: numeric("target_sugar_g", { precision: 6, scale: 2 }),
  intolerances: text("intolerances").array().default([]),
  dislikedIngredients: text("disliked_ingredients").array().default([]),
  onboardingComplete: boolean("onboarding_complete").default(false),
  silverHealthProfileId: uuid("silver_health_profile_id"),
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
});

export const b2cCustomerAllergens = gold.table("b2c_customer_allergens", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  b2cCustomerId: uuid("b2c_customer_id").notNull(),
  allergenId: uuid("allergen_id").notNull(),
  severity: varchar("severity", { length: 20 }),
  reactionDescription: text("reaction_description"),
  diagnosisDate: date("diagnosis_date"),
  isActive: boolean("is_active").default(true),
  createdAt: timestamp("created_at").defaultNow(),
});

export const b2cCustomerDietaryPreferences = gold.table("b2c_customer_dietary_preferences", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  b2cCustomerId: uuid("b2c_customer_id").notNull(),
  dietId: uuid("diet_id").notNull(),
  strictness: varchar("strictness", { length: 20 }).default("moderate"),
  startDate: date("start_date"),
  isActive: boolean("is_active").default(true),
  createdAt: timestamp("created_at").defaultNow(),
});

export const b2cCustomerHealthConditions = gold.table("b2c_customer_health_conditions", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  b2cCustomerId: uuid("b2c_customer_id").notNull(),
  conditionId: uuid("condition_id").notNull(),
  severity: varchar("severity", { length: 20 }),
  diagnosisDate: date("diagnosis_date"),
  notes: text("notes"),
  isActive: boolean("is_active").default(true),
  createdAt: timestamp("created_at").defaultNow(),
});

export const allergens = gold.table("allergens", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  code: varchar("code", { length: 50 }).notNull(),
  name: varchar("name", { length: 255 }).notNull(),
  commonNames: text("common_names").array(),
  category: varchar("category", { length: 100 }),
  isTop9: boolean("is_top_9").default(false),
  createdAt: timestamp("created_at").defaultNow(),
});

export const dietaryPreferences = gold.table("dietary_preferences", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  code: varchar("code", { length: 50 }).notNull(),
  name: varchar("name", { length: 255 }).notNull(),
  category: varchar("category", { length: 100 }),
  description: text("description"),
  isMedical: boolean("is_medical").default(false),
  createdAt: timestamp("created_at").defaultNow(),
});

export const healthConditions = gold.table("health_conditions", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  code: varchar("code", { length: 50 }).notNull(),
  name: varchar("name", { length: 255 }).notNull(),
  category: varchar("category", { length: 100 }),
  description: text("description"),
  createdAt: timestamp("created_at").defaultNow(),
});

export const cuisines = gold.table("cuisines", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  code: varchar("code", { length: 50 }).notNull(),
  name: varchar("name", { length: 255 }).notNull(),
  region: varchar("region", { length: 100 }),
  country: varchar("country", { length: 100 }),
  parentCuisineId: uuid("parent_cuisine_id"),
  createdAt: timestamp("created_at").defaultNow(),
});

export const recipes = gold.table("recipes", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  title: varchar("title", { length: 500 }).notNull(),
  description: text("description"),
  cuisineId: uuid("cuisine_id"),
  mealType: varchar("meal_type", { length: 20 }),
  difficulty: varchar("difficulty", { length: 20 }),
  prepTimeMinutes: integer("prep_time_minutes"),
  cookTimeMinutes: integer("cook_time_minutes"),
  totalTimeMinutes: integer("total_time_minutes"),
  servings: integer("servings").default(1),
  imageUrl: varchar("image_url", { length: 1000 }),
  sourceUrl: varchar("source_url", { length: 1000 }),
  sourceType: varchar("source_type", { length: 20 }),
  instructions: jsonb("instructions"),
  percentCaloriesProtein: numeric("percent_calories_protein", { precision: 5, scale: 2 }),
  percentCaloriesFat: numeric("percent_calories_fat", { precision: 5, scale: 2 }),
  percentCaloriesCarbs: numeric("percent_calories_carbs", { precision: 5, scale: 2 }),
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
  createdByUserId: uuid("created_by_user_id"),
});

export const recipeIngredients = gold.table("recipe_ingredients", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  recipeId: uuid("recipe_id").notNull(),
  ingredientId: uuid("ingredient_id").notNull(),
  productId: uuid("product_id"),
  quantity: numeric("quantity"),
  unit: varchar("unit", { length: 50 }),
  quantityNormalizedG: numeric("quantity_normalized_g", { precision: 10, scale: 4 }),
  ingredientOrder: integer("ingredient_order"),
  preparationNote: text("preparation_note"),
  isOptional: boolean("is_optional").default(false),
  createdAt: timestamp("created_at").defaultNow(),
});

export const ingredients = gold.table("ingredients", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  name: varchar("name", { length: 255 }).notNull(),
  commonNames: text("common_names").array(),
  ingredientType: varchar("ingredient_type", { length: 100 }),
  category: varchar("category", { length: 100 }),
  description: text("description"),
  sourceType: varchar("source_type", { length: 20 }),
  usdaFdcId: varchar("usda_fdc_id", { length: 50 }),
  isAllergen: boolean("is_allergen").default(false),
  isAdditive: boolean("is_additive").default(false),
  regulatoryStatus: varchar("regulatory_status", { length: 100 }),
  calories: numeric("calories", { precision: 7, scale: 2 }),
  totalFatG: numeric("total_fat_g", { precision: 6, scale: 2 }),
  saturatedFatG: numeric("saturated_fat_g", { precision: 6, scale: 2 }),
  transFatG: numeric("trans_fat_g", { precision: 6, scale: 2 }),
  cholesterolMg: numeric("cholesterol_mg", { precision: 6, scale: 2 }),
  sodiumMg: numeric("sodium_mg", { precision: 7, scale: 2 }),
  totalCarbsG: numeric("total_carbs_g", { precision: 6, scale: 2 }),
  dietaryFiberG: numeric("dietary_fiber_g", { precision: 6, scale: 2 }),
  totalSugarsG: numeric("total_sugars_g", { precision: 6, scale: 2 }),
  proteinG: numeric("protein_g", { precision: 6, scale: 2 }),
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
});

export const ingredientAllergens = gold.table("ingredient_allergens", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  ingredientId: uuid("ingredient_id").notNull(),
  allergenId: uuid("allergen_id").notNull(),
  thresholdPpm: numeric("threshold_ppm", { precision: 10, scale: 2 }),
  crossReactivity: boolean("cross_reactivity").default(false),
  createdAt: timestamp("created_at").defaultNow(),
});

export const ingredientSynonyms = gold.table("ingredient_synonyms", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  synonym: varchar("synonym", { length: 255 }).notNull(),
  canonicalIngredientId: uuid("canonical_ingredient_id").notNull(),
  language: varchar("language", { length: 10 }).default("en"),
  confidenceScore: numeric("confidence_score", { precision: 3, scale: 2 }),
  createdAt: timestamp("created_at").defaultNow(),
});

export const dietIngredientRules = gold.table("diet_ingredient_rules", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  dietId: uuid("diet_id").notNull(),
  ingredientId: uuid("ingredient_id").notNull(),
  ruleType: varchar("rule_type", { length: 20 }),
  condition: text("condition"),
  createdAt: timestamp("created_at").defaultNow(),
});

export const healthConditionIngredientRestrictions = gold.table(
  "health_condition_ingredient_restrictions",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    conditionId: uuid("condition_id").notNull(),
    ingredientId: uuid("ingredient_id").notNull(),
    restrictionType: varchar("restriction_type", { length: 20 }),
    maxDailyAmountG: numeric("max_daily_amount_g"),
    reasoning: text("reasoning"),
    guidelineSource: varchar("guideline_source", { length: 255 }),
    createdAt: timestamp("created_at").defaultNow(),
  }
);

export const healthConditionNutrientThresholds = gold.table(
  "health_condition_nutrient_thresholds",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    conditionId: uuid("condition_id").notNull(),
    nutrientName: varchar("nutrient_name", { length: 100 }).notNull(),
    minDailyMg: numeric("min_daily_mg", { precision: 10, scale: 2 }),
    maxDailyMg: numeric("max_daily_mg", { precision: 10, scale: 2 }),
    targetDailyMg: numeric("target_daily_mg", { precision: 10, scale: 2 }),
    severityModifier: varchar("severity_modifier", { length: 50 }),
    guidelineSource: varchar("guideline_source", { length: 255 }),
    createdAt: timestamp("created_at").defaultNow(),
    nutrientId: uuid("nutrient_id"),
  }
);

export const nutritionDefinitions = gold.table("nutrition_definitions", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  nutrientName: varchar("nutrient_name", { length: 255 }).notNull(),
  nutrientCode: varchar("nutrient_code", { length: 100 }),
  usdaNutrientId: integer("usda_nutrient_id"),
  unitName: varchar("unit_name", { length: 50 }),
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
});

export const nutritionFacts = gold.table("nutrition_facts", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  entityType: varchar("entity_type", { length: 20 }).notNull(),
  entityId: uuid("entity_id").notNull(),
  nutrientId: uuid("nutrient_id").notNull(),
  amount: numeric("amount", { precision: 12, scale: 4 }).notNull(),
  unit: varchar("unit", { length: 20 }).notNull(),
  perAmount: varchar("per_amount", { length: 50 }).default("100g"),
  perAmountGrams: numeric("per_amount_grams", { precision: 10, scale: 2 }),
  percentDailyValue: numeric("percent_daily_value", { precision: 5, scale: 2 }),
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
});

export const customerProductInteractions = gold.table("customer_product_interactions", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  b2cCustomerId: uuid("b2c_customer_id"),
  b2bCustomerId: uuid("b2b_customer_id"),
  householdId: uuid("household_id"),
  productId: uuid("product_id"),
  interactionType: varchar("interaction_type", { length: 20 }),
  rating: integer("rating"),
  quantity: integer("quantity"),
  pricePaid: numeric("price_paid", { precision: 10, scale: 2 }),
  interactionTimestamp: timestamp("interaction_timestamp").defaultNow(),
  sessionId: varchar("session_id", { length: 255 }),
  deviceType: varchar("device_type", { length: 50 }),
  metadata: jsonb("metadata"),
  createdAt: timestamp("created_at").defaultNow(),
  recipeId: uuid("recipe_id"),
  entityType: varchar("entity_type", { length: 20 }).default("recipe").notNull(),
});

// ── Products (maps existing gold.products — zero schema changes) ────────────
export const products = gold.table("products", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  // -- Product identity --
  vendorId: uuid("vendor_id"),
  externalId: varchar("external_id", { length: 255 }),
  globalProductId: uuid("global_product_id"),
  name: varchar("name", { length: 500 }).notNull(),
  brand: varchar("brand", { length: 255 }),
  description: text("description"),
  categoryId: uuid("category_id"),
  barcode: varchar("barcode", { length: 50 }),
  gtinType: varchar("gtin_type", { length: 20 }),
  // -- Pricing --
  price: numeric("price", { precision: 10, scale: 2 }),
  currency: varchar("currency", { length: 3 }).default("USD"),
  // -- Packaging --
  packageWeight: varchar("package_weight", { length: 50 }),
  packageWeightG: numeric("package_weight_g", { precision: 10, scale: 2 }),
  servingSize: varchar("serving_size", { length: 100 }),
  servingSizeG: numeric("serving_size_g", { precision: 10, scale: 2 }),
  servingsPerContainer: numeric("servings_per_container", { precision: 5, scale: 2 }),
  // -- Media / Links --
  imageUrl: varchar("image_url", { length: 1000 }),
  productUrl: varchar("product_url", { length: 1000 }),
  // -- Sourcing --
  manufacturer: varchar("manufacturer", { length: 255 }),
  countryOfOrigin: varchar("country_of_origin", { length: 100 }),
  status: varchar("status", { length: 20 }).default("active"),
  vendorSpecificAttrs: jsonb("vendor_specific_attrs"),
  // -- Nutrition (per 100g / per serving) --
  calories: numeric("calories", { precision: 7, scale: 2 }),
  caloriesFromFat: numeric("calories_from_fat", { precision: 7, scale: 2 }),
  totalFatG: numeric("total_fat_g", { precision: 6, scale: 2 }),
  saturatedFatG: numeric("saturated_fat_g", { precision: 6, scale: 2 }),
  transFatG: numeric("trans_fat_g", { precision: 6, scale: 2 }),
  polyunsaturatedFatG: numeric("polyunsaturated_fat_g", { precision: 6, scale: 2 }),
  monounsaturatedFatG: numeric("monounsaturated_fat_g", { precision: 6, scale: 2 }),
  cholesterolMg: numeric("cholesterol_mg", { precision: 6, scale: 2 }),
  sodiumMg: numeric("sodium_mg", { precision: 7, scale: 2 }),
  totalCarbsG: numeric("total_carbs_g", { precision: 6, scale: 2 }),
  dietaryFiberG: numeric("dietary_fiber_g", { precision: 6, scale: 2 }),
  totalSugarsG: numeric("total_sugars_g", { precision: 6, scale: 2 }),
  addedSugarsG: numeric("added_sugars_g", { precision: 6, scale: 2 }),
  sugarAlcoholsG: numeric("sugar_alcohols_g", { precision: 6, scale: 2 }),
  proteinG: numeric("protein_g", { precision: 6, scale: 2 }),
  // -- Vitamins / Minerals --
  vitaminAMcg: numeric("vitamin_a_mcg", { precision: 6, scale: 2 }),
  vitaminCMg: numeric("vitamin_c_mg", { precision: 6, scale: 2 }),
  vitaminDMcg: numeric("vitamin_d_mcg", { precision: 6, scale: 2 }),
  calciumMg: numeric("calcium_mg", { precision: 6, scale: 2 }),
  ironMg: numeric("iron_mg", { precision: 6, scale: 2 }),
  potassiumMg: numeric("potassium_mg", { precision: 6, scale: 2 }),
  // -- Metadata --
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
  sourceSystem: varchar("source_system", { length: 100 }),
  mpn: varchar("mpn", { length: 100 }),
  pluCode: varchar("plu_code", { length: 5 }),
  notes: text("notes"),
});

// ── Product Allergens (maps existing gold.product_allergens) ────────────────
export const productAllergens = gold.table("product_allergens", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  productId: uuid("product_id").notNull(),
  allergenId: uuid("allergen_id").notNull(),
  statementType: varchar("statement_type", { length: 20 }).default("contains").notNull(),
  sourceType: varchar("source_type", { length: 20 }).default("declared").notNull(),
  dataSource: varchar("data_source", { length: 100 }),
  confidenceScore: numeric("confidence_score", { precision: 3, scale: 2 }),
  rawText: text("raw_text"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

// ── Scan History ────────────────────────────────────────────────────────────
export const scanHistory = gold.table("scan_history", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  b2cCustomerId: uuid("b2c_customer_id").notNull(),
  householdId: uuid("household_id"),
  productId: uuid("product_id"),
  barcode: varchar("barcode", { length: 50 }).notNull(),
  barcodeFormat: varchar("barcode_format", { length: 20 }),
  scanSource: varchar("scan_source", { length: 20 }).default("camera"),
  scannedAt: timestamp("scanned_at").defaultNow(),
  metadata: jsonb("metadata"),
});

export const auditLog = gold.table("audit_log", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  tableName: varchar("table_name", { length: 100 }).notNull(),
  recordId: uuid("record_id").notNull(),
  action: varchar("action", { length: 20 }),
  oldValues: jsonb("old_values"),
  newValues: jsonb("new_values"),
  changedBy: uuid("changed_by"),
  changedAt: timestamp("changed_at").defaultNow(),
  ipAddress: varchar("ip_address", { length: 50 }),
  userAgent: text("user_agent"),
});

// ── Recipe Nutrition Profiles (maps existing gold.recipe_nutrition_profiles) ──
export const recipeNutritionProfiles = gold.table("recipe_nutrition_profiles", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  recipeId: uuid("recipe_id").notNull(),
  perBasis: varchar("per_basis", { length: 20 }).default("per_serving"),
  servingSizeG: numeric("serving_size_g", { precision: 10, scale: 2 }),
  servings: numeric("servings", { precision: 10, scale: 2 }),
  calories: numeric("calories", { precision: 7, scale: 2 }),
  caloriesFromFat: numeric("calories_from_fat", { precision: 7, scale: 2 }),
  totalFatG: numeric("total_fat_g", { precision: 6, scale: 2 }),
  saturatedFatG: numeric("saturated_fat_g", { precision: 6, scale: 2 }),
  transFatG: numeric("trans_fat_g", { precision: 6, scale: 2 }),
  polyunsaturatedFatG: numeric("polyunsaturated_fat_g", { precision: 6, scale: 2 }),
  monounsaturatedFatG: numeric("monounsaturated_fat_g", { precision: 6, scale: 2 }),
  cholesterolMg: numeric("cholesterol_mg", { precision: 6, scale: 2 }),
  sodiumMg: numeric("sodium_mg", { precision: 7, scale: 2 }),
  totalCarbsG: numeric("total_carbs_g", { precision: 6, scale: 2 }),
  dietaryFiberG: numeric("dietary_fiber_g", { precision: 6, scale: 2 }),
  totalSugarsG: numeric("total_sugars_g", { precision: 6, scale: 2 }),
  addedSugarsG: numeric("added_sugars_g", { precision: 6, scale: 2 }),
  sugarAlcoholsG: numeric("sugar_alcohols_g", { precision: 6, scale: 2 }),
  proteinG: numeric("protein_g", { precision: 6, scale: 2 }),
  vitaminAMcg: numeric("vitamin_a_mcg", { precision: 6, scale: 2 }),
  vitaminCMg: numeric("vitamin_c_mg", { precision: 6, scale: 2 }),
  vitaminDMcg: numeric("vitamin_d_mcg", { precision: 6, scale: 2 }),
  calciumMg: numeric("calcium_mg", { precision: 6, scale: 2 }),
  ironMg: numeric("iron_mg", { precision: 6, scale: 2 }),
  potassiumMg: numeric("potassium_mg", { precision: 6, scale: 2 }),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
  dataSource: varchar("data_source", { length: 100 }),
});

// ── Meal Logging (PRD-03) ───────────────────────────────────────────────────

export const mealLogs = gold.table("meal_logs", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  b2cCustomerId: uuid("b2c_customer_id").notNull(),
  householdId: uuid("household_id"),
  logDate: date("log_date").notNull(),
  totalCalories: integer("total_calories").default(0),
  totalProteinG: numeric("total_protein_g", { precision: 8, scale: 2 }).default("0"),
  totalCarbsG: numeric("total_carbs_g", { precision: 8, scale: 2 }).default("0"),
  totalFatG: numeric("total_fat_g", { precision: 8, scale: 2 }).default("0"),
  totalFiberG: numeric("total_fiber_g", { precision: 8, scale: 2 }).default("0"),
  totalSugarG: numeric("total_sugar_g", { precision: 8, scale: 2 }).default("0"),
  totalSodiumMg: integer("total_sodium_mg").default(0),
  waterMl: integer("water_ml").default(0),
  waterGoalMl: integer("water_goal_ml").default(2500),
  calorieGoal: integer("calorie_goal"),
  goalMet: boolean("goal_met").default(false),
  streakCount: integer("streak_count").default(0),
  notes: text("notes"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

export const mealLogItems = gold.table("meal_log_items", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  mealLogId: uuid("meal_log_id").notNull(),
  mealType: varchar("meal_type", { length: 20 }).notNull(),
  recipeId: uuid("recipe_id"),
  productId: uuid("product_id"),
  customName: varchar("custom_name", { length: 500 }),
  customBrand: varchar("custom_brand", { length: 255 }),
  servings: numeric("servings", { precision: 6, scale: 2 }).default("1").notNull(),
  servingSize: varchar("serving_size", { length: 100 }),
  servingSizeG: numeric("serving_size_g", { precision: 10, scale: 2 }),
  calories: integer("calories"),
  proteinG: numeric("protein_g", { precision: 8, scale: 2 }),
  carbsG: numeric("carbs_g", { precision: 8, scale: 2 }),
  fatG: numeric("fat_g", { precision: 8, scale: 2 }),
  fiberG: numeric("fiber_g", { precision: 8, scale: 2 }),
  sugarG: numeric("sugar_g", { precision: 8, scale: 2 }),
  sodiumMg: integer("sodium_mg"),
  saturatedFatG: numeric("saturated_fat_g", { precision: 6, scale: 2 }),
  cookedViaApp: boolean("cooked_via_app").default(false),
  cookingStartedAt: timestamp("cooking_started_at"),
  cookingFinishedAt: timestamp("cooking_finished_at"),
  mealPlanItemId: uuid("meal_plan_item_id"),
  loggedAt: timestamp("logged_at").defaultNow().notNull(),
  source: varchar("source", { length: 20 }).default("manual"),
  notes: text("notes"),
  imageUrl: varchar("image_url", { length: 1000 }),
});

export const mealLogStreaks = gold.table("meal_log_streaks", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  b2cCustomerId: uuid("b2c_customer_id").notNull(),
  currentStreak: integer("current_streak").default(0),
  longestStreak: integer("longest_streak").default(0),
  lastLoggedDate: date("last_logged_date"),
  totalDaysLogged: integer("total_days_logged").default(0),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

export const mealLogTemplates = gold.table("meal_log_templates", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  b2cCustomerId: uuid("b2c_customer_id").notNull(),
  templateName: varchar("template_name", { length: 255 }).notNull(),
  mealType: varchar("meal_type", { length: 20 }),
  items: jsonb("items").notNull(),
  useCount: integer("use_count").default(0),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

// ── Meal Plans (PRD-04) ──────────────────────────────────────────────────────

export const mealPlans = gold.table("meal_plans", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  householdId: uuid("household_id"),
  b2cCustomerId: uuid("b2c_customer_id"),
  b2bCustomerId: uuid("b2b_customer_id"),
  planName: varchar("plan_name", { length: 255 }),
  startDate: date("start_date").notNull(),
  endDate: date("end_date").notNull(),
  totalEstimatedCost: numeric("total_estimated_cost", { precision: 10, scale: 2 }),
  totalCalories: integer("total_calories"),
  status: varchar("status", { length: 20 }).default("draft"),
  mealsPerDay: text("meals_per_day").array().default(["breakfast", "lunch", "dinner"]),
  generationParams: jsonb("generation_params"),
  aiModel: varchar("ai_model", { length: 100 }),
  budgetAmount: numeric("budget_amount", { precision: 10, scale: 2 }),
  budgetCurrency: varchar("budget_currency", { length: 3 }).default("USD"),
  memberIds: uuid("member_ids").array(),
  generationTimeMs: integer("generation_time_ms"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

export const mealPlanItems = gold.table("meal_plan_items", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  mealPlanId: uuid("meal_plan_id").notNull(),
  recipeId: uuid("recipe_id").notNull(),
  mealDate: date("meal_date").notNull(),
  mealType: varchar("meal_type", { length: 20 }),
  servings: integer("servings").default(1),
  forMemberIds: uuid("for_member_ids").array(),
  estimatedCost: numeric("estimated_cost", { precision: 10, scale: 2 }),
  caloriesPerServing: integer("calories_per_serving"),
  status: varchar("status", { length: 20 }).default("planned"),
  rating: integer("rating"),
  notes: text("notes"),
  originalRecipeId: uuid("original_recipe_id"),
  swapReason: text("swap_reason"),
  swapCount: integer("swap_count").default(0),
  nutritionSnapshot: jsonb("nutrition_snapshot"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const recipeRatings = gold.table("recipe_ratings", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  recipeId: uuid("recipe_id").notNull(),
  b2cCustomerId: uuid("b2c_customer_id"),
  householdId: uuid("household_id"),
  rating: integer("rating").notNull(),
  feedbackText: text("feedback_text"),
  mealPlanItemId: uuid("meal_plan_item_id"),
  likedAspects: text("liked_aspects").array(),
  dislikedAspects: text("disliked_aspects").array(),
  wouldMakeAgain: boolean("would_make_again"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const householdBudgets = gold.table("household_budgets", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  householdId: uuid("household_id").notNull(),
  budgetType: varchar("budget_type", { length: 20 }).default("grocery"),
  amount: numeric("amount", { precision: 10, scale: 2 }).notNull(),
  currency: varchar("currency", { length: 3 }).default("USD"),
  period: varchar("period", { length: 20 }),
  startDate: date("start_date"),
  endDate: date("end_date"),
  isActive: boolean("is_active").default(true),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

// ── Zod Schemas ─────────────────────────────────────────────────────────────

export const insertRecipeSchema = createInsertSchema(recipes).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

export const insertB2cCustomerSchema = createInsertSchema(b2cCustomers).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

// ── Type Exports ────────────────────────────────────────────────────────────

export type B2cCustomer = typeof b2cCustomers.$inferSelect;
export type B2cHealthProfile = typeof b2cCustomerHealthProfiles.$inferSelect;
export type Recipe = typeof recipes.$inferSelect;
export type InsertRecipe = z.infer<typeof insertRecipeSchema>;
export type CustomerProductInteraction = typeof customerProductInteractions.$inferSelect;
export type GoldProduct = typeof products.$inferSelect;
export type ProductAllergen = typeof productAllergens.$inferSelect;
export type ScanHistoryRecord = typeof scanHistory.$inferSelect;
export type RecipeNutritionProfile = typeof recipeNutritionProfiles.$inferSelect;
export type MealLog = typeof mealLogs.$inferSelect;
export type MealLogItem = typeof mealLogItems.$inferSelect;
export type MealLogStreak = typeof mealLogStreaks.$inferSelect;
export type MealLogTemplate = typeof mealLogTemplates.$inferSelect;
export type MealPlan = typeof mealPlans.$inferSelect;
export type MealPlanItem = typeof mealPlanItems.$inferSelect;
export type RecipeRating = typeof recipeRatings.$inferSelect;
export type HouseholdBudget = typeof householdBudgets.$inferSelect;

