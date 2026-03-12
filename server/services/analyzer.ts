// server/services/analyzer.ts
// Recipe analyzer service: LLM-powered analysis with personalized warnings

import { db, executeRaw } from "../config/database.js";
import {
  ingredients,
  ingredientSynonyms,
  allergens,
  ingredientAllergens,
  b2cCustomerAllergens,
  b2cCustomerDietaryPreferences,
  b2cCustomerHealthConditions,
  healthConditionNutrientThresholds,
  dietIngredientRules,
  b2cCustomers,
} from "../../shared/goldSchema.js";
import { AppError } from "../middleware/errorHandler.js";
import { eq, and, or, ilike } from "drizzle-orm";
import { analyzeRecipeWithLLM, extractTextFromImage, analyzeImageVisually, type LLMAnalysisResult } from "./llm.js";
import { createUserRecipe } from "./userContent.js";
import * as cheerio from "cheerio";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface AnalyzedIngredient {
  qty?: number;
  unit?: string;
  item: string;
  matched?: boolean;
}

export interface InferredAttributes {
  allergens?: string[];
  diets?: string[];
  cuisines?: string[];
  taste?: string[];
}

export interface NutritionPerServing {
  calories?: number;
  protein?: number;
  protein_g?: number;
  carbs?: number;
  carbs_g?: number;
  fat?: number;
  fat_g?: number;
  fiber?: number;
  fiber_g?: number;
  sugar?: number;
  sugar_g?: number;
  sodium?: number;
  sodium_mg?: number;
  potassium?: number;
  iron?: number;
  calcium?: number;
  vitaminD?: number;
}

export interface AnalyzeResult {
  title?: string;
  summary?: string;
  servings?: number;
  ingredients?: AnalyzedIngredient[];
  steps?: string[];
  inferred?: InferredAttributes;
  nutritionPerServing?: NutritionPerServing;
  suggestions?: string[];
  tags?: string[];
  allergenWarnings?: AllergenWarning[];
  healthWarnings?: HealthWarning[];
}

export interface AllergenWarning {
  allergenName: string;
  severity: string | null;
  memberName: string;
  message: string;
}

export interface HealthWarning {
  conditionName: string;
  nutrient: string;
  value: number;
  message: string;
}

// ─── Text Analysis ────────────────────────────────────────────────────────────

/**
 * Analyze recipe text with LLM and personalize warnings.
 */
export async function analyzeText(
  text: string,
  b2cCustomerId: string,
  memberId?: string
): Promise<AnalyzeResult> {
  const t0 = performance.now();
  try {
    const llmResult = await analyzeRecipeWithLLM(text);
    const tLLM = performance.now();

    const matchedIngredients = await matchIngredients(llmResult.ingredients || []);
    const tMatch = performance.now();

    const targetMemberId = memberId || b2cCustomerId;
    const [allergenWarnings, healthWarnings] = await Promise.all([
      generateAllergenWarnings(matchedIngredients, targetMemberId).catch((err) => {
        console.error("[Analyzer] Allergen warnings failed:", err);
        return [];
      }),
      generateHealthWarnings(llmResult.nutrition_per_serving, targetMemberId).catch((err) => {
        console.error("[Analyzer] Health warnings failed:", err);
        return [];
      }),
    ]);
    const tWarn = performance.now();

    console.log(
      `[Analyzer] Timing: LLM=${(tLLM - t0).toFixed(0)}ms, match=${(tMatch - tLLM).toFixed(0)}ms, warnings=${(tWarn - tMatch).toFixed(0)}ms, total=${(tWarn - t0).toFixed(0)}ms`
    );

    return convertToAnalyzeResult(llmResult, matchedIngredients, allergenWarnings, healthWarnings);
  } catch (error: any) {
    console.error("[Analyzer] analyzeText failed:", error);
    throw error;
  }
}

// ─── URL Analysis ─────────────────────────────────────────────────────────────

/**
 * Scrape URL, extract recipe text, then analyze.
 */
export async function analyzeUrl(
  url: string,
  b2cCustomerId: string,
  memberId?: string
): Promise<AnalyzeResult> {
  try {
    const response = await fetch(url, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
      },
      signal: AbortSignal.timeout(15_000),
    });

    if (!response.ok) {
      throw new Error(`Failed to fetch URL: ${response.status} ${response.statusText}`);
    }

    const html = await response.text();
    const $ = cheerio.load(html);

    // Prefer explicit recipe containers first, then broader semantic regions.
    const chunks = [
      $("article").text(),
      $(".recipe").text(),
      $("[itemtype*='Recipe']").text(),
      $("[class*='recipe']").text(),
      $("main").text(),
      $("body").text(),
    ];

    const title =
      $("meta[property='og:title']").attr("content") ||
      $("meta[name='twitter:title']").attr("content") ||
      $("title").first().text() ||
      "";

    const recipeText = chunks
      .map((v) => (v || "").replace(/\s+/g, " ").trim())
      .find((v) => v.length >= 50);

    if (!recipeText) {
      throw new Error("Could not extract recipe content from URL");
    }

    const combined = `${title}\n\n${recipeText}`.trim();
    return analyzeText(combined, b2cCustomerId, memberId);
  } catch (error: any) {
    console.error("[Analyzer] URL scraping failed:", error?.message || error);
    throw new Error(`Failed to analyze URL: ${error?.message || "Unknown error"}`);
  }
}

// ─── Image Analysis ──────────────────────────────────────────────────────────

/**
 * Check if OCR text looks like actual recipe content (not descriptive text).
 * Requires ingredient-like patterns: quantities, units, cooking verbs.
 */
function looksLikeRecipeText(text: string): boolean {
  const lower = text.toLowerCase();
  // Must have at least 3 of these recipe indicators
  const indicators = [
    /\d+\s*(cup|cups|tbsp|tsp|oz|lb|g|kg|ml|liter|tablespoon|teaspoon|ounce|pound)/i,  // measurements
    /\b(ingredient|ingredients)\b/i,                                                     // "ingredients" header
    /\b(instruction|instructions|directions|steps|method|preparation)\b/i,               // "instructions" header
    /\b(preheat|chop|dice|mince|stir|bake|roast|sauté|saute|simmer|boil|fry|grill|mix|whisk|fold|knead|marinate)\b/i, // cooking verbs
    /\b(salt|pepper|sugar|flour|butter|oil|garlic|onion)\b/i,                            // common ingredients
    /\d+\s*\/\s*\d+/,                                                                    // fractions like 1/2, 3/4
    /\b(serving|serves|yield)\b/i,                                                       // serving info
    /\b(calories|protein|carbs|fat|nutrition)\b/i,                                       // nutrition label text
  ];
  const matchCount = indicators.filter((rx) => rx.test(lower)).length;
  return matchCount >= 3;
}

/**
 * Analyze image: try OCR first with strict validation, fallback to visual food analysis.
 */
export async function analyzeImage(
  imageBuffer: Buffer,
  b2cCustomerId: string,
  memberId?: string
): Promise<AnalyzeResult> {
  const t0 = performance.now();

  // Step 1: Try OCR — only use result if it's actual recipe/label text
  let extractedText = "";
  try {
    extractedText = await extractTextFromImage(imageBuffer);
    const charCount = extractedText.trim().length;
    console.log(`[Analyzer] OCR extracted ${charCount} chars`);

    // Strict validation: ≥200 chars AND looks like real recipe text
    if (charCount >= 200 && looksLikeRecipeText(extractedText)) {
      console.log("[Analyzer] OCR text passed recipe validation — using text pipeline");
      return analyzeText(extractedText, b2cCustomerId, memberId);
    }

    console.log(`[Analyzer] OCR text failed recipe validation (${charCount} chars, recipe=${looksLikeRecipeText(extractedText)}) — using visual analysis`);
  } catch (err: any) {
    console.warn("[Analyzer] OCR failed, using visual analysis:", err?.message);
  }

  // Step 2: Direct visual food analysis (food photo, non-text image, or failed validation)
  console.log("[Analyzer] Starting visual food analysis");
  const llmResult = await analyzeImageVisually(imageBuffer);
  const tVision = performance.now();

  // Run the same post-processing as analyzeText (ingredient matching + warnings)
  const matchedIngredients = await matchIngredients(llmResult.ingredients || []);

  const targetMemberId = memberId || b2cCustomerId;
  const [allergenWarnings, healthWarnings] = await Promise.all([
    generateAllergenWarnings(matchedIngredients, targetMemberId).catch((err) => {
      console.error("[Analyzer] Allergen warnings failed:", err);
      return [];
    }),
    generateHealthWarnings(llmResult.nutrition_per_serving, targetMemberId).catch((err) => {
      console.error("[Analyzer] Health warnings failed:", err);
      return [];
    }),
  ]);

  console.log(`[Analyzer] Visual analysis total: ${(performance.now() - t0).toFixed(0)}ms (vision=${(tVision - t0).toFixed(0)}ms)`);

  return convertToAnalyzeResult(llmResult, matchedIngredients, allergenWarnings, healthWarnings);
}

// ─── Barcode Analysis ────────────────────────────────────────────────────────

/**
 * Look up product by barcode, format as recipe text, then LLM-analyze.
 * Reuses the scan service for barcode → product lookup (OpenFoodFacts + cache).
 */
export async function analyzeBarcode(
  barcode: string,
  b2cCustomerId: string,
  memberId?: string
): Promise<AnalyzeResult> {
  const { lookupProductByBarcode } = await import("./scan.js");
  const lookup = await lookupProductByBarcode(barcode, b2cCustomerId, memberId);

  if (!lookup.product) {
    throw new AppError(
      404,
      "Product Not Found",
      `No product information found for barcode ${barcode}. The product may not be in the OpenFoodFacts database. Try entering the recipe details manually instead.`
    );
  }

  const p = lookup.product;
  const n = p.nutrition;

  const recipeText = [
    `Product: ${p.name}`,
    p.brand ? `Brand: ${p.brand}` : "",
    p.allergens?.length ? `Allergens: ${p.allergens.join(", ")}` : "",
    n ? [
      "Nutrition per serving:",
      n.calories != null ? `  Calories: ${n.calories}` : "",
      n.protein_g != null ? `  Protein: ${n.protein_g}g` : "",
      n.carbs_g != null ? `  Carbs: ${n.carbs_g}g` : "",
      n.fat_g != null ? `  Fat: ${n.fat_g}g` : "",
      n.fiber_g != null ? `  Fiber: ${n.fiber_g}g` : "",
      n.sugar_g != null ? `  Sugar: ${n.sugar_g}g` : "",
      n.sodium_mg != null ? `  Sodium: ${n.sodium_mg}mg` : "",
    ].filter(Boolean).join("\n") : "",
    (p as any).description ? `Ingredients: ${(p as any).description}` : "",
  ].filter(Boolean).join("\n");

  return analyzeText(recipeText, b2cCustomerId, memberId);
}

// ─── Ingredient Matching ──────────────────────────────────────────────────────

/**
 * Batch-match all LLM-parsed ingredients against DB in a single query.
 * Uses exact name → synonym → partial (ILIKE) priority via COALESCE.
 */
async function matchIngredients(
  llmIngredients: LLMAnalysisResult["ingredients"]
): Promise<AnalyzedIngredient[]> {
  if (!llmIngredients || !Array.isArray(llmIngredients) || llmIngredients.length === 0) {
    return [];
  }

  const valid = llmIngredients.filter((ing) => ing?.item);
  if (valid.length === 0) return [];

  const names = valid.map((ing) => ing.item.toLowerCase().trim());

  const rows = await executeRaw(
    `
    WITH input_names AS (
      SELECT unnest($1::text[]) AS name
    ),
    exact AS (
      SELECT LOWER(i.name) AS matched_name
      FROM gold.ingredients i
      WHERE LOWER(i.name) = ANY($1::text[])
    ),
    synonym AS (
      SELECT LOWER(s.synonym) AS matched_name
      FROM gold.ingredient_synonyms s
      JOIN gold.ingredients i ON i.id = s.canonical_ingredient_id
      WHERE LOWER(s.synonym) = ANY($1::text[])
    ),
    partial AS (
      SELECT LOWER(n.name) AS matched_name
      FROM input_names n
      WHERE EXISTS (
        SELECT 1 FROM gold.ingredients i
        WHERE LOWER(i.name) LIKE '%' || n.name || '%'
      )
    ),
    all_matches AS (
      SELECT matched_name FROM exact
      UNION SELECT matched_name FROM synonym
      UNION SELECT matched_name FROM partial
    )
    SELECT matched_name FROM all_matches
    `,
    [names]
  ) as unknown as { matched_name: string }[];

  const matchedSet = new Set(rows.map((r) => r.matched_name));

  return valid.map((ing) => ({
    qty: ing.qty,
    unit: ing.unit,
    item: ing.item,
    matched: matchedSet.has(ing.item.toLowerCase().trim()),
  }));
}

// ─── Personalized Warnings ────────────────────────────────────────────────────

/**
 * Generate allergen warnings for recipe ingredients.
 */
async function generateAllergenWarnings(
  matchedIngredients: AnalyzedIngredient[],
  memberId: string
): Promise<AllergenWarning[]> {
  try {
    // Get ingredient names that matched
    const ingredientNames = matchedIngredients
      .filter((ing) => ing.matched)
      .map((ing) => ing.item.toLowerCase());

    if (ingredientNames.length === 0) return [];

    // Find allergens for these ingredients
    // Use ANY with proper array casting (matching codebase pattern)
    if (ingredientNames.length === 0) return [];

    const allergenMatches = await executeRaw(
      `
      SELECT DISTINCT
        a.name AS allergen_name,
        ca.severity,
        c.full_name AS member_name
      FROM gold.ingredients i
      JOIN gold.ingredient_allergens ia ON ia.ingredient_id = i.id
      JOIN gold.allergens a ON a.id = ia.allergen_id
      JOIN gold.b2c_customer_allergens ca ON ca.allergen_id = a.id
      JOIN gold.b2c_customers c ON c.id = ca.b2c_customer_id
      WHERE LOWER(i.name) = ANY($1::text[])
        AND ca.b2c_customer_id = $2
        AND ca.is_active = true
      `,
      [ingredientNames, memberId]
    ) as unknown as {
      allergen_name: string;
      severity: string | null;
      member_name: string;
    }[];

    return allergenMatches.map((w) => ({
      allergenName: w.allergen_name,
      severity: w.severity,
      memberName: w.member_name,
      message: `⚠️ Contains ${w.allergen_name}${w.severity ? ` (${w.severity} sensitivity)` : ""} — unsafe for ${w.member_name}`,
    }));
  } catch (error) {
    console.error("[Analyzer] Allergen warning generation failed:", error);
    return [];
  }
}

/**
 * Generate health warnings based on recipe nutrition and member's conditions.
 * Single batch query instead of N+1 per condition.
 */
async function generateHealthWarnings(
  nutrition: LLMAnalysisResult["nutrition_per_serving"],
  memberId: string
): Promise<HealthWarning[]> {
  try {
    const rows = await executeRaw(
      `
      SELECT hc.name AS condition_name,
             t.nutrient_name,
             t.max_daily_mg
      FROM gold.b2c_customer_health_conditions chc
      JOIN gold.health_conditions hc ON hc.id = chc.condition_id
      JOIN gold.health_condition_nutrient_thresholds t ON t.condition_id = hc.id
      WHERE chc.b2c_customer_id = $1
        AND chc.is_active = true
        AND t.max_daily_mg IS NOT NULL
      `,
      [memberId]
    ) as unknown as {
      condition_name: string;
      nutrient_name: string;
      max_daily_mg: number;
    }[];

    if (rows.length === 0) return [];

    const warnings: HealthWarning[] = [];
    const dailyServings = 3;

    for (const row of rows) {
      const nutrientName = row.nutrient_name.toLowerCase();
      let value: number | null = null;

      if (nutrientName.includes("sodium")) {
        value = nutrition.sodium_mg || null;
      } else if (nutrientName.includes("sugar")) {
        value = nutrition.sugar_g ? nutrition.sugar_g * 1000 : null;
      } else if (nutrientName.includes("saturated") || nutrientName.includes("cholesterol")) {
        continue;
      }

      if (value === null) continue;

      if (value * dailyServings > row.max_daily_mg) {
        warnings.push({
          conditionName: row.condition_name,
          nutrient: row.nutrient_name,
          value,
          message: `⚠️ High ${row.nutrient_name} (${value}${nutrientName.includes("sodium") ? "mg" : "g"}/serving) — monitor intake for ${row.condition_name}`,
        });
      }
    }

    return warnings;
  } catch (error) {
    console.error("[Analyzer] Health warning generation failed:", error);
    return [];
  }
}

// ─── Result Conversion ────────────────────────────────────────────────────────

/**
 * Convert LLM result to AnalyzeResult format.
 */
function convertToAnalyzeResult(
  llmResult: LLMAnalysisResult,
  matchedIngredients: AnalyzedIngredient[],
  allergenWarnings: AllergenWarning[],
  healthWarnings: HealthWarning[]
): AnalyzeResult {
  const nutrition = llmResult.nutrition_per_serving || {};

  return {
    title: llmResult.title,
    servings: llmResult.servings || 1,
    ingredients: matchedIngredients,
    steps: llmResult.steps || [],
    inferred: {
      allergens: llmResult.allergens || [],
      diets: [
        ...(llmResult.diets_compatible || []),
        ...(llmResult.diets_incompatible || []).map((d) => `not_${d}`),
      ],
      cuisines: llmResult.cuisine ? [llmResult.cuisine] : [],
      taste: [],
    },
    nutritionPerServing: {
      calories: nutrition.calories || 0,
      protein_g: nutrition.protein_g || 0,
      carbs_g: nutrition.carbs_g || 0,
      fat_g: nutrition.fat_g || 0,
      fiber_g: nutrition.fiber_g,
      sugar_g: nutrition.sugar_g,
      sodium_mg: nutrition.sodium_mg,
      potassium: nutrition.potassium_mg,
      iron: nutrition.iron_mg,
      calcium: nutrition.calcium_mg,
      vitaminD: nutrition.vitamin_d_mcg,
    },
    suggestions: llmResult.suggestions || [],
    tags: [],
    allergenWarnings: allergenWarnings.length > 0 ? allergenWarnings : undefined,
    healthWarnings: healthWarnings.length > 0 ? healthWarnings : undefined,
    summary: generateSummary(llmResult),
  };
}

function generateSummary(result: LLMAnalysisResult): string {
  const parts = [
    result.title ? `"${result.title}"` : "Recipe",
    result.servings ? `serves ${result.servings}` : "",
    result.ingredients?.length ? `${result.ingredients.length} ingredients` : "",
  ].filter(Boolean);

  const diets = (result.diets_compatible || []).map((d) => d.replace(/_/g, " ")).join(", ");
  return `${parts.join(" • ")}. ${diets ? `Fits: ${diets}.` : ""}`;
}

// ─── Save Recipe ──────────────────────────────────────────────────────────────

/**
 * Save analyzed recipe to user's collection.
 */
export async function saveAnalyzedRecipe(
  result: AnalyzeResult,
  b2cCustomerId: string
): Promise<{ id: string }> {
  // ── Nutrition values ─────────────────────────────────────────────────────
  const cal = result.nutritionPerServing?.calories || 0;
  const prot = result.nutritionPerServing?.protein_g || 0;
  const fat = result.nutritionPerServing?.fat_g || 0;
  const carbs = result.nutritionPerServing?.carbs_g || 0;

  // Compute percent_calories_* using 4-9-4 rule (protein=4cal/g, fat=9cal/g, carbs=4cal/g)
  const pctProtein = cal > 0 ? Math.round(((prot * 4) / cal) * 100 * 100) / 100 : null;
  const pctFat = cal > 0 ? Math.round(((fat * 9) / cal) * 100 * 100) / 100 : null;
  const pctCarbs = cal > 0 ? Math.round(((carbs * 4) / cal) * 100 * 100) / 100 : null;

  // ── Estimate cook/prep time from step count (~15 min/step) ─────────────
  const stepCount = result.steps?.length || 0;
  const estimatedTotal = stepCount > 0 ? stepCount * 15 : null;
  const estimatedPrep = estimatedTotal ? Math.round(estimatedTotal * 0.3) : null;
  const estimatedCook = estimatedTotal ? Math.round(estimatedTotal * 0.7) : null;

  // ── Fetch user's first name for personalized title ─────────────────────
  const [user] = await db
    .select({ firstName: b2cCustomers.firstName })
    .from(b2cCustomers)
    .where(eq(b2cCustomers.id, b2cCustomerId))
    .limit(1);
  const firstName = user?.firstName ?? null;

  // Build personalized title: "Sourav's Rotisserie Chicken"
  const rawTitle = result.title || "Untitled Recipe";
  const personalizedTitle = firstName ? `${firstName}'s ${rawTitle}` : rawTitle;

  // Convert AnalyzeResult to userContent format
  const recipeData = {
    title: personalizedTitle,
    description: result.summary || "",
    servings: result.servings || 1,
    prepTimeMinutes: estimatedPrep ?? undefined,
    cookTimeMinutes: estimatedCook ?? undefined,
    totalTimeMinutes: estimatedTotal ?? undefined,
    difficulty: undefined as string | undefined,   // Analyzer doesn't determine difficulty
    percent_calories_protein: pctProtein,
    percent_calories_fat: pctFat,
    percent_calories_carbs: pctCarbs,
    ingredients: result.ingredients?.map((ing) => ({
      qty: ing.qty,
      unit: ing.unit,
      name: ing.item,
    })) || [],
    instructions: result.steps || [],
    nutrition: {
      calories: result.nutritionPerServing?.calories || null,
      protein_g: result.nutritionPerServing?.protein_g || null,
      carbs_g: result.nutritionPerServing?.carbs_g || null,
      fat_g: result.nutritionPerServing?.fat_g || null,
      fiber_g: result.nutritionPerServing?.fiber_g || null,
      sugar_g: result.nutritionPerServing?.sugar_g || null,
      sodium_mg: result.nutritionPerServing?.sodium_mg || null,
      saturated_fat_g: null,
    },
  };

  const savedRecipe = await createUserRecipe(b2cCustomerId, recipeData);
  return { id: savedRecipe.id };
}
