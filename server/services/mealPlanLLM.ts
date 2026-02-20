import OpenAI from "openai";
import { createHash } from "node:crypto";

// ── Configuration ───────────────────────────────────────────────────────────

const LITELLM_BASE_URL = process.env.LITELLM_BASE_URL || "https://litellm.confer.today/v1";
const LITELLM_API_KEY = process.env.LITELLM_API_KEY || process.env.LITELLM_API_KEY_MINI || "";
const MEAL_PLAN_MODEL = process.env.MEAL_PLAN_LLM_MODEL || process.env.LLM_MODEL || "gpt-5-nano";
const MEAL_PLAN_TIMEOUT = parseInt(process.env.MEAL_PLAN_TIMEOUT_MS || "30000", 10);
const MEAL_SWAP_TIMEOUT = parseInt(process.env.MEAL_PLAN_SWAP_TIMEOUT_MS || "15000", 10);
const LLM_COOLDOWN_MS = parseInt(process.env.MEAL_PLAN_LLM_COOLDOWN_MS || "120000", 10);

let llmBlockedUntil = 0;

const client = new OpenAI({
  apiKey: LITELLM_API_KEY,
  baseURL: LITELLM_BASE_URL,
});

// ── Cache ───────────────────────────────────────────────────────────────────

interface CacheEntry<T> {
  value: T;
  expiresAt: number;
}

const CACHE_TTL_MS = 30 * 60 * 1000; // 30 min for swap suggestions
const CACHE_MAX_SIZE = 50;
const swapCache = new Map<string, CacheEntry<any>>();

function cacheKey(prefix: string, input: string): string {
  return prefix + ":" + createHash("sha256").update(input).digest("hex").slice(0, 16);
}

function cacheGet<T>(key: string): T | undefined {
  const entry = swapCache.get(key);
  if (!entry) return undefined;
  if (Date.now() > entry.expiresAt) {
    swapCache.delete(key);
    return undefined;
  }
  return entry.value as T;
}

function cacheSet<T>(key: string, value: T): void {
  if (swapCache.size >= CACHE_MAX_SIZE) {
    const oldest = swapCache.keys().next().value;
    if (oldest) swapCache.delete(oldest);
  }
  swapCache.set(key, { value, expiresAt: Date.now() + CACHE_TTL_MS });
}

function getErrorStatus(error: any): number | undefined {
  if (typeof error?.status === "number") return error.status;
  if (typeof error?.statusCode === "number") return error.statusCode;
  return undefined;
}

function isRateLimitError(error: any): boolean {
  const status = getErrorStatus(error);
  if (status === 429) return true;
  const message = String(error?.message || "");
  return /rate limit|too many requests/i.test(message);
}

function setProviderCooldown(reason: string): void {
  const until = Date.now() + LLM_COOLDOWN_MS;
  llmBlockedUntil = Math.max(llmBlockedUntil, until);
  console.warn("[MealPlanLLM] Provider cooldown enabled", {
    reason,
    until: new Date(llmBlockedUntil).toISOString(),
  });
}

function assertProviderAvailable(operation: string): void {
  if (Date.now() < llmBlockedUntil) {
    const seconds = Math.max(1, Math.ceil((llmBlockedUntil - Date.now()) / 1000));
    const err = new Error(`AI ${operation} temporarily unavailable. Retrying after cooldown (${seconds}s).`);
    (err as any).status = 503;
    throw err;
  }
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout | null = null;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => {
          const err = new Error(`Timeout while waiting for ${label}`);
          (err as any).status = 504;
          reject(err);
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function wrapProviderError(prefix: string, error: any): Error {
  const wrapped = new Error(`${prefix}: ${error?.message || "Unknown error"}`);
  const status = getErrorStatus(error);
  if (status && status >= 400 && status < 600) {
    (wrapped as any).status = status;
  }
  if (isRateLimitError(error)) {
    setProviderCooldown(String(error?.message || "Rate limited"));
    if (!(wrapped as any).status) (wrapped as any).status = 429;
  }
  return wrapped;
}

// ── Types ───────────────────────────────────────────────────────────────────

export interface MemberContext {
  name: string;
  age: number | null;
  allergens: string[];
  diets: string[];
  conditions: string[];
  calorieTarget: number | null;
  proteinTargetG: number | null;
  carbsTargetG: number | null;
  fatTargetG: number | null;
}

export interface RecipeOption {
  id: string;
  title: string;
  mealType: string | null;
  cuisine: string | null;
  calories: number;
  proteinG: number;
  carbsG: number;
  fatG: number;
  cookTimeMinutes: number | null;
  allergens: string[];
  diets: string[];
}

export interface PlanGenerationContext {
  members: MemberContext[];
  recipes: RecipeOption[];
  startDate: string;
  endDate: string;
  mealsPerDay: string[];
  budgetAmount?: number;
  budgetCurrency?: string;
  excludeRecipeIds: string[];
  maxCookTime?: number;
  preferredCuisines?: string[];
}

export interface LLMPlanMeal {
  date: string;
  mealType: string;
  recipeId: string;
  servings: number;
  estimatedCost: number | null;
  reasoning: string;
}

export interface LLMPlanResponse {
  meals: LLMPlanMeal[];
  totalEstimatedCost: number | null;
  planSummary: string;
}

export interface SwapContext {
  currentRecipeId: string;
  currentRecipeTitle: string;
  mealDate: string;
  mealType: string;
  members: MemberContext[];
  alternatives: RecipeOption[];
  swapReason?: string;
}

export interface LLMSwapResponse {
  recipeId: string;
  servings: number;
  estimatedCost: number | null;
  reasoning: string;
}

// ── System Prompts ──────────────────────────────────────────────────────────

const PLAN_SYSTEM_PROMPT = `You are an expert meal planner and nutritionist. Generate a structured weekly meal plan as JSON.

STRICT RULES:
1. Only use recipe IDs from the provided list — never invent recipes
2. ZERO allergen violations — if ANY family member is allergic to something, exclude ALL recipes containing that allergen
3. Stay within the budget constraint if provided
4. Meet each member's calorie/macro targets within ±10%
5. No repeat recipes within the same week (unless fewer recipes than meal slots)
6. Balance variety across cuisines and meal types
7. Respect cooking time constraints
8. For each meal, estimate the grocery cost in the given currency

Return ONLY valid JSON with this exact schema:
{
  "meals": [
    {
      "date": "YYYY-MM-DD",
      "mealType": "breakfast|lunch|dinner|snack",
      "recipeId": "uuid",
      "servings": number,
      "estimatedCost": number_or_null,
      "reasoning": "brief explanation"
    }
  ],
  "totalEstimatedCost": number_or_null,
  "planSummary": "brief overall plan summary"
}`;

const SWAP_SYSTEM_PROMPT = `You are an expert meal planner. Suggest a replacement meal from the alternatives provided.

RULES:
1. Only pick from the provided alternatives list
2. Respect all allergen constraints
3. Try to maintain similar nutrition profile to the replaced meal
4. Consider the reason for the swap if provided
5. Pick something different from the current recipe

Return ONLY valid JSON:
{
  "recipeId": "uuid",
  "servings": number,
  "estimatedCost": number_or_null,
  "reasoning": "why this is a good swap"
}`;

// ── Plan Generation ─────────────────────────────────────────────────────────

export async function generateMealPlanWithLLM(
  context: PlanGenerationContext
): Promise<LLMPlanResponse> {
  if (!LITELLM_API_KEY) {
    throw new Error("LITELLM_API_KEY is not configured");
  }
  assertProviderAvailable("meal plan generation");

  const membersSummary = context.members.map((m) => ({
    name: m.name,
    age: m.age,
    allergens: m.allergens,
    diets: m.diets,
    conditions: m.conditions,
    calorieTarget: m.calorieTarget,
    proteinTargetG: m.proteinTargetG,
    carbsTargetG: m.carbsTargetG,
    fatTargetG: m.fatTargetG,
  }));

  const maxRecipes = parseInt(process.env.MEAL_PLAN_MAX_RECIPES || "150", 10);
  const recipeSummary = context.recipes.slice(0, maxRecipes).map((r) => ({
    id: r.id,
    title: r.title,
    mealType: r.mealType,
    cuisine: r.cuisine,
    calories: r.calories,
    proteinG: r.proteinG,
    carbsG: r.carbsG,
    fatG: r.fatG,
    cookTime: r.cookTimeMinutes,
    allergens: r.allergens,
    diets: r.diets,
  }));

  const userPrompt = `Generate a meal plan with these constraints:

FAMILY MEMBERS:
${JSON.stringify(membersSummary, null, 2)}

DATE RANGE: ${context.startDate} to ${context.endDate}
MEALS PER DAY: ${context.mealsPerDay.join(", ")}
${context.budgetAmount ? `BUDGET: ${context.budgetAmount} ${context.budgetCurrency || "USD"} for the entire plan` : "NO BUDGET CONSTRAINT"}
${context.maxCookTime ? `MAX COOK TIME: ${context.maxCookTime} minutes per meal` : ""}
${context.preferredCuisines?.length ? `PREFERRED CUISINES: ${context.preferredCuisines.join(", ")}` : ""}
${context.excludeRecipeIds.length ? `EXCLUDED RECIPE IDS (do NOT use these): ${context.excludeRecipeIds.join(", ")}` : ""}

AVAILABLE RECIPES (pick ONLY from these):
${JSON.stringify(recipeSummary, null, 2)}`;

  console.log("[MealPlanLLM] Generating plan:", {
    members: context.members.length,
    recipes: recipeSummary.length,
    dateRange: `${context.startDate} → ${context.endDate}`,
    mealsPerDay: context.mealsPerDay,
    model: MEAL_PLAN_MODEL,
  });

  const startTime = Date.now();

  try {
    const response = await withTimeout(
      client.chat.completions.create({
        model: MEAL_PLAN_MODEL,
        messages: [
          { role: "system", content: PLAN_SYSTEM_PROMPT },
          { role: "user", content: userPrompt },
        ],
        response_format: { type: "json_object" },
        temperature: 0.3,
        timeout: MEAL_PLAN_TIMEOUT,
      }),
      MEAL_PLAN_TIMEOUT + 2000,
      "meal plan generation"
    );

    const elapsed = Date.now() - startTime;
    console.log("[MealPlanLLM] Response received:", {
      elapsed: `${elapsed}ms`,
      model: response.model,
      finishReason: response.choices[0]?.finish_reason,
    });

    const content = response.choices[0]?.message?.content;
    if (!content) {
      throw new Error("Empty response from LLM");
    }

    let parsed: LLMPlanResponse;
    try {
      parsed = JSON.parse(content) as LLMPlanResponse;
    } catch (parseError: any) {
      console.error("[MealPlanLLM] JSON parse error:", parseError, "Content:", content.substring(0, 500));
      throw new Error(`Failed to parse LLM meal plan response: ${parseError?.message}`);
    }

    if (!parsed.meals || !Array.isArray(parsed.meals) || parsed.meals.length === 0) {
      throw new Error("LLM returned empty meals array");
    }

    for (const meal of parsed.meals) {
      if (!meal.recipeId || !meal.date || !meal.mealType) {
        throw new Error(`Invalid meal entry: missing required fields`);
      }
      if (!meal.servings || meal.servings < 1) {
        meal.servings = 1;
      }
    }

    if (!parsed.planSummary) {
      parsed.planSummary = `${parsed.meals.length}-meal plan generated`;
    }

    return parsed;
  } catch (error: any) {
    console.error("[MealPlanLLM] Generation failed:", error?.message || error);
    throw wrapProviderError("Meal plan generation failed", error);
  }
}

// ── Swap Suggestion ─────────────────────────────────────────────────────────

export async function suggestSwapWithLLM(
  context: SwapContext
): Promise<LLMSwapResponse> {
  if (!LITELLM_API_KEY) {
    throw new Error("LITELLM_API_KEY is not configured");
  }
  assertProviderAvailable("meal swap");

  const key = cacheKey("swap", JSON.stringify({
    currentRecipeId: context.currentRecipeId,
    mealType: context.mealType,
    alternatives: context.alternatives.map((a) => a.id).sort(),
    reason: context.swapReason,
  }));

  const cached = cacheGet<LLMSwapResponse>(key);
  if (cached) {
    console.log("[MealPlanLLM] Swap cache HIT");
    return cached;
  }

  const userPrompt = `Suggest a replacement for this meal:

CURRENT MEAL: "${context.currentRecipeTitle}" (ID: ${context.currentRecipeId})
DATE: ${context.mealDate}
MEAL TYPE: ${context.mealType}
${context.swapReason ? `REASON FOR SWAP: ${context.swapReason}` : ""}

FAMILY MEMBERS' CONSTRAINTS:
${JSON.stringify(context.members, null, 2)}

AVAILABLE ALTERNATIVES (pick from these):
${JSON.stringify(context.alternatives.map((a) => ({
  id: a.id,
  title: a.title,
  calories: a.calories,
  proteinG: a.proteinG,
  carbsG: a.carbsG,
  fatG: a.fatG,
  cookTime: a.cookTimeMinutes,
  allergens: a.allergens,
})), null, 2)}`;

  try {
    const response = await withTimeout(
      client.chat.completions.create({
        model: MEAL_PLAN_MODEL,
        messages: [
          { role: "system", content: SWAP_SYSTEM_PROMPT },
          { role: "user", content: userPrompt },
        ],
        response_format: { type: "json_object" },
        temperature: 0.3,
        timeout: MEAL_SWAP_TIMEOUT,
      }),
      MEAL_SWAP_TIMEOUT + 2000,
      "meal swap suggestion"
    );

    const content = response.choices[0]?.message?.content;
    if (!content) throw new Error("Empty response from LLM for swap");

    const parsed = JSON.parse(content) as LLMSwapResponse;
    if (!parsed.recipeId) throw new Error("LLM swap response missing recipeId");
    if (!parsed.servings || parsed.servings < 1) parsed.servings = 1;
    if (!parsed.reasoning) parsed.reasoning = "Alternative suggestion";

    cacheSet(key, parsed);
    return parsed;
  } catch (error: any) {
    console.error("[MealPlanLLM] Swap suggestion failed:", error?.message);
    throw wrapProviderError("Meal swap suggestion failed", error);
  }
}

export function getLLMModelName(): string {
  return MEAL_PLAN_MODEL;
}

export function getLLMGenerationTimeMs(startTime: number): number {
  return Date.now() - startTime;
}
