// server/services/llm.ts
// LLM service for recipe analysis using LiteLLM proxy → OpenAI models

import OpenAI from "openai";
import { createHash } from "node:crypto";

// ─── LLM Result Cache ────────────────────────────────────────────────────────

interface CacheEntry<T> {
  value: T;
  expiresAt: number;
}

const CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour
const CACHE_MAX_SIZE = 200;
const llmCache = new Map<string, CacheEntry<any>>();

function cacheKey(prefix: string, input: string): string {
  return prefix + ":" + createHash("sha256").update(input).digest("hex").slice(0, 16);
}

function cacheGet<T>(key: string): T | undefined {
  const entry = llmCache.get(key);
  if (!entry) return undefined;
  if (Date.now() > entry.expiresAt) {
    llmCache.delete(key);
    return undefined;
  }
  return entry.value as T;
}

function cacheSet<T>(key: string, value: T): void {
  if (llmCache.size >= CACHE_MAX_SIZE) {
    const oldest = llmCache.keys().next().value;
    if (oldest) llmCache.delete(oldest);
  }
  llmCache.set(key, { value, expiresAt: Date.now() + CACHE_TTL_MS });
}

// ─── Configuration ────────────────────────────────────────────────────────────

const LITELLM_BASE_URL = process.env.LITELLM_BASE_URL || "https://litellm.confer.today/v1";

// Model-specific API keys (project-level shared keys)
// Use GPT-5-mini key for text analysis, GPT-5-ALL for vision
const LITELLM_API_KEY = process.env.LITELLM_API_KEY || process.env.LITELLM_API_KEY_MINI || "";
const LITELLM_API_KEY_VISION = process.env.LITELLM_API_KEY_VISION || process.env.LITELLM_API_KEY_ALL || LITELLM_API_KEY;

const LLM_MODEL = process.env.LLM_MODEL || "gpt-5-nano";
const LLM_VISION_MODEL = process.env.LLM_VISION_MODEL || "gpt-5-mini";

// Initialize OpenAI clients (compatible with LiteLLM proxy)
const client = new OpenAI({
  apiKey: LITELLM_API_KEY,
  baseURL: LITELLM_BASE_URL,
});

const visionClient = new OpenAI({
  apiKey: LITELLM_API_KEY_VISION,
  baseURL: LITELLM_BASE_URL,
});

// ─── Types ────────────────────────────────────────────────────────────────────

export interface LLMAnalysisResult {
  title: string;
  servings: number;
  ingredients: Array<{
    qty?: number;
    unit?: string;
    item: string;
    calories_per_unit?: number;
    protein_g?: number;
    carbs_g?: number;
    fat_g?: number;
    sodium_mg?: number;
    sugar_g?: number;
    fiber_g?: number;
  }>;
  steps: string[];
  nutrition_per_serving: {
    calories: number;
    protein_g: number;
    carbs_g: number;
    fat_g: number;
    sodium_mg?: number;
    sugar_g?: number;
    fiber_g?: number;
    potassium_mg?: number;
    iron_mg?: number;
    calcium_mg?: number;
    vitamin_d_mcg?: number;
  };
  allergens: string[];
  diets_compatible: string[];
  diets_incompatible: string[];
  suggestions: string[];
  cuisine?: string;
  difficulty?: "easy" | "medium" | "hard";
  prep_time_minutes?: number;
  cook_time_minutes?: number;
}

// ─── System Prompt ───────────────────────────────────────────────────────────

const RECIPE_ANALYSIS_SYSTEM_PROMPT = `You are a nutrition expert. Extract structured recipe data as JSON.

Required JSON schema:
{"title":"string","servings":int,"ingredients":[{"qty":number|null,"unit":"string|null","item":"string","calories_per_unit":number,"protein_g":number,"carbs_g":number,"fat_g":number,"sodium_mg":number,"sugar_g":number,"fiber_g":number}],"steps":["string"],"nutrition_per_serving":{"calories":int,"protein_g":number,"carbs_g":number,"fat_g":number,"sodium_mg":number,"sugar_g":number,"fiber_g":number,"potassium_mg":number,"iron_mg":number,"calcium_mg":number,"vitamin_d_mcg":number},"allergens":["string"],"diets_compatible":["string"],"diets_incompatible":["string"],"suggestions":["string"],"cuisine":"string","difficulty":"easy|medium|hard","prep_time_minutes":int,"cook_time_minutes":int}

Rules:
- Estimate nutrition per serving from ingredient quantities
- Allergens to check: gluten, dairy, eggs, fish, shellfish, tree nuts, peanuts, soy, sesame
- Diets: vegan, vegetarian, gluten-free, keto, paleo, etc.
- 2-4 healthier substitution suggestions
- Return ONLY valid JSON`;

// ─── Recipe Analysis ──────────────────────────────────────────────────────────

/**
 * Analyze recipe text using LLM and return structured analysis.
 */
export async function analyzeRecipeWithLLM(text: string): Promise<LLMAnalysisResult> {
  if (!LITELLM_API_KEY) {
    throw new Error("LITELLM_API_KEY is not configured. Please set LITELLM_API_KEY in your .env file.");
  }

  const key = cacheKey("recipe", text.toLowerCase().trim());
  const cached = cacheGet<LLMAnalysisResult>(key);
  if (cached) {
    console.log("[LLM] Cache HIT:", { textLength: text.length, title: cached.title });
    return cached;
  }

  console.log("[LLM] Cache MISS — calling LLM:", { textLength: text.length, model: LLM_MODEL, baseURL: LITELLM_BASE_URL });

  try {
    const response = await client.chat.completions.create({
      model: LLM_MODEL,
      messages: [
        {
          role: "system",
          content: RECIPE_ANALYSIS_SYSTEM_PROMPT,
        },
        {
          role: "user",
          content: `Analyze this recipe:\n\n${text}`,
        },
      ],
      response_format: { type: "json_object" },
      temperature: 0.1,
      reasoning_effort: "low" as any,
      stream: false,
    }, { timeout: 60000 });

    console.log("[LLM] Received response:", { 
      hasContent: !!response.choices[0]?.message?.content,
      finishReason: response.choices[0]?.finish_reason,
      model: response.model 
    });

    const content = response.choices[0]?.message?.content;
    if (!content) {
      throw new Error("Empty response from LLM");
    }

    // Parse JSON response
    let parsed: LLMAnalysisResult;
    try {
      parsed = JSON.parse(content) as LLMAnalysisResult;
    } catch (parseError: any) {
      console.error("[LLM] JSON parse error:", parseError, "Content:", content.substring(0, 500));
      throw new Error(`Failed to parse LLM response as JSON: ${parseError?.message}`);
    }

    // Validate required fields (make some optional with defaults)
    if (!parsed.title) {
      console.warn("[LLM] Missing title in response, using default");
      parsed.title = "Untitled Recipe";
    }
    if (!parsed.ingredients || !Array.isArray(parsed.ingredients)) {
      console.warn("[LLM] Missing or invalid ingredients in response");
      parsed.ingredients = [];
    }
    if (!parsed.nutrition_per_serving) {
      console.warn("[LLM] Missing nutrition_per_serving in response");
      parsed.nutrition_per_serving = {
        calories: 0,
        protein_g: 0,
        carbs_g: 0,
        fat_g: 0,
      };
    }
    if (!parsed.servings) {
      parsed.servings = 1;
    }
    if (!parsed.steps) {
      parsed.steps = [];
    }
    if (!parsed.allergens) {
      parsed.allergens = [];
    }
    if (!parsed.diets_compatible) {
      parsed.diets_compatible = [];
    }
    if (!parsed.diets_incompatible) {
      parsed.diets_incompatible = [];
    }
    if (!parsed.suggestions) {
      parsed.suggestions = [];
    }

    cacheSet(key, parsed);
    return parsed;
  } catch (error: any) {
    console.error("[LLM] Recipe analysis failed:", error?.message || error);
    throw new Error(`LLM analysis failed: ${error?.message || "Unknown error"}`);
  }
}

// ─── Image OCR (Vision API) ────────────────────────────────────────────────────

/**
 * Extract text from image using Vision API (Phase 2).
 */
export async function extractTextFromImage(imageBuffer: Buffer): Promise<string> {
  if (!LITELLM_API_KEY_VISION) {
    throw new Error("LITELLM_API_KEY_VISION is not configured");
  }

  try {
    // Convert buffer to base64
    const base64Image = imageBuffer.toString("base64");

    const response = await visionClient.chat.completions.create({
      model: LLM_VISION_MODEL,
      messages: [
        {
          role: "user",
          content: [
            {
              type: "text",
              text: "Extract all text from this image. If it's a recipe, extract the full recipe text including title, ingredients, and instructions. If it's a nutrition label, extract all nutrition information. Return the text exactly as it appears, preserving formatting where possible.",
            },
            {
              type: "image_url",
              image_url: {
                url: `data:image/jpeg;base64,${base64Image}`,
              },
            },
          ],
        },
      ],
      temperature: 0.1,
      stream: false,
    }, { timeout: 60000 }); // 60 seconds timeout for vision

    const content = response.choices[0]?.message?.content;
    if (!content) {
      throw new Error("Empty response from Vision API");
    }

    return content;
  } catch (error: any) {
    console.error("[LLM] Image OCR failed:", error?.message || error);
    throw new Error(`Image OCR failed: ${error?.message || "Unknown error"}`);
  }
}
