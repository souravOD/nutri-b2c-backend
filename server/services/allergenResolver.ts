// server/services/allergenResolver.ts
// 3-tier custom allergen resolution: gold.allergens → gold.allergen_synonyms → LLM
// Part of the Allergen Backfill Pipeline integration (Phase 2)

import OpenAI from "openai";
import { createHash } from "node:crypto";
import { executeRaw } from "../config/database.js";
import { logger } from "../config/logger.js";

// ── Types ────────────────────────────────────────────────────────────────────

export interface AllergenResolutionResult {
  matched: boolean;
  allergenId?: string;
  allergenName?: string;
  reasoning?: string;
  source?: "direct" | "synonym" | "llm";
}

interface LLMAllergenResponse {
  maps_to_existing: boolean;
  allergen_name: string | null;
  confidence: number;
  reasoning: string;
}

// ── LLM Configuration (reuses project-wide LiteLLM proxy) ────────────────────

const LITELLM_BASE_URL = process.env.LITELLM_BASE_URL || "https://litellm.confer.today/v1";
const LITELLM_API_KEY = process.env.LITELLM_API_KEY || process.env.LITELLM_API_KEY_MINI || "";
const LLM_MODEL = process.env.LLM_MODEL || "gpt-5-nano";
const CONFIDENCE_THRESHOLD = 0.8;

const client = new OpenAI({
  apiKey: LITELLM_API_KEY,
  baseURL: LITELLM_BASE_URL,
});

// ── In-Memory Cache (same pattern as llm.ts) ─────────────────────────────────

const CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour
const CACHE_MAX_SIZE = 200;
const resolverCache = new Map<string, { value: AllergenResolutionResult; expiresAt: number }>();

function cacheKey(input: string): string {
  return "allergen:" + createHash("sha256").update(input.toLowerCase().trim()).digest("hex").slice(0, 16);
}

function cacheGet(key: string): AllergenResolutionResult | undefined {
  const entry = resolverCache.get(key);
  if (!entry) return undefined;
  if (Date.now() > entry.expiresAt) {
    resolverCache.delete(key);
    return undefined;
  }
  return entry.value;
}

function cacheSet(key: string, value: AllergenResolutionResult): void {
  if (resolverCache.size >= CACHE_MAX_SIZE) {
    const oldest = resolverCache.keys().next().value;
    if (oldest) resolverCache.delete(oldest);
  }
  resolverCache.set(key, { value, expiresAt: Date.now() + CACHE_TTL_MS });
}

// ── LLM Prompt ───────────────────────────────────────────────────────────────

const SYSTEM_PROMPT = `You are a clinical food allergy specialist. Given a user-submitted food/substance,
determine whether it should be mapped to one of these existing allergen categories:

1. Milk (dairy) — includes whey, casein, lactose, butter, ghee, cheese
2. Egg — includes albumin, mayonnaise, meringue
3. Peanut — includes groundnut
4. Tree nuts — includes almond, walnut, cashew, pistachio, pecan, hazelnut, macadamia, brazil nut, marzipan
5. Soy — includes tofu, miso, edamame, tempeh, soy lecithin, TVP
6. Wheat / gluten cereals — includes spelt, barley, rye, oats, semolina, couscous, gluten
7. Fish (finned) — includes salmon, cod, tuna, anchovy, tilapia, sardine, halibut, fish sauce, surimi
8. Shellfish — crustaceans — includes shrimp, prawn, crab, lobster, crayfish, krill
9. Sesame (seed) — includes tahini, halvah, sesame oil
10. Molluscs — includes clam, mussel, oyster, scallop, squid, octopus, snail/escargot
11. Celery — includes celeriac, celery salt, celery seed
12. Seeds (non-sesame) — includes mustard, sunflower, poppy, flax, chia, pine nut
13. Other legumes — includes lentil, chickpea, pea, lupin, bean
14. Corn (maize) — includes cornstarch, dextrose, HFCS, corn syrup
15. Oral Allergy Syndrome (OAS) — includes raw fruits/vegetables that cross-react with pollen: apple, cherry, peach, pear, plum, kiwi, carrot, celery, tomato, bell pepper, banana, melon, avocado, mango, spinach, lettuce
16. Alpha-gal syndrome — includes beef, pork, lamb, venison, goat, bison, mammalian meat
17. Insect (entomophagy) — includes cricket, mealworm, grasshopper protein
18. Gelatin (bovine/porcine) — includes gummy candies, marshmallows, gelatin capsules
19. Buckwheat (pseudo-cereal) — includes soba noodles
20. Spices & herbs (rare) — includes coriander, cumin, garlic, paprika, cinnamon (only for rare documented allergies)

RULES:
- If the food clearly belongs to one category, map it with high confidence.
- If the food COULD trigger reactions via cross-reactivity (e.g., spinach → OAS via birch pollen), explain this.
- If the food is a brand name, identify the underlying allergen(s).
- If the food is genuinely novel and does not fit any category, set maps_to_existing: false.
- Be conservative: if confidence is below ${CONFIDENCE_THRESHOLD}, treat as novel.

Respond ONLY with valid JSON.`;

// ── Core Resolution Function ─────────────────────────────────────────────────

/**
 * Resolves a user-submitted allergen string through 3 tiers:
 * 1. Direct match against gold.allergens (name/code)
 * 2. Synonym lookup in gold.allergen_synonyms
 * 3. LLM classification via structured prompt
 *
 * On successful LLM match, auto-inserts into allergen_synonyms for future lookups.
 */
export async function resolveCustomAllergen(userInput: string): Promise<AllergenResolutionResult> {
  const input = userInput.trim();
  if (!input) return { matched: false };

  // Check cache first
  const key = cacheKey(input);
  const cached = cacheGet(key);
  if (cached) {
    logger.debug(`[allergenResolver] Cache hit for "${input}"`);
    return cached;
  }

  // ── Tier 1: Direct match against gold.allergens ────────────────────────────
  try {
    const directRows = await executeRaw(
      `SELECT id, name FROM gold.allergens
       WHERE lower(name) = lower($1) OR lower(code) = lower($1)
       LIMIT 1`,
      [input]
    );
    if (directRows.length > 0) {
      const result: AllergenResolutionResult = {
        matched: true,
        allergenId: (directRows[0] as any).id,
        allergenName: (directRows[0] as any).name,
        reasoning: `Direct match in allergen list`,
        source: "direct",
      };
      cacheSet(key, result);
      logger.info(`[allergenResolver] Tier 1 direct match: "${input}" → ${result.allergenName}`);
      return result;
    }
  } catch (err) {
    logger.error(`[allergenResolver] Tier 1 query failed:`, err);
  }

  // ── Tier 2: Synonym lookup in gold.allergen_synonyms ───────────────────────
  try {
    const synonymRows = await executeRaw(
      `SELECT a.id, a.name
       FROM gold.allergen_synonyms s
       JOIN gold.allergens a ON a.id = s.canonical_allergen_id
       WHERE lower(s.synonym) = lower($1)
       LIMIT 1`,
      [input]
    );
    if (synonymRows.length > 0) {
      const result: AllergenResolutionResult = {
        matched: true,
        allergenId: (synonymRows[0] as any).id,
        allergenName: (synonymRows[0] as any).name,
        reasoning: `"${input}" is a known synonym for ${(synonymRows[0] as any).name}`,
        source: "synonym",
      };
      cacheSet(key, result);
      logger.info(`[allergenResolver] Tier 2 synonym match: "${input}" → ${result.allergenName}`);
      return result;
    }
  } catch (err) {
    logger.error(`[allergenResolver] Tier 2 query failed:`, err);
  }

  // ── Tier 3: LLM classification ────────────────────────────────────────────
  try {
    logger.info(`[allergenResolver] Tier 3 LLM classification for: "${input}"`);

    const completion = await client.chat.completions.create({
      model: LLM_MODEL,
      temperature: 0.1,
      max_tokens: 300,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        {
          role: "user",
          content: `User submitted allergen: "${input}"\n\nRespond with JSON: { "maps_to_existing": boolean, "allergen_name": string | null, "confidence": number (0-1), "reasoning": string }`,
        },
      ],
    });

    const content = completion.choices?.[0]?.message?.content;
    if (!content) {
      logger.warn(`[allergenResolver] LLM returned empty response for "${input}"`);
      return { matched: false };
    }

    const llmResult: LLMAllergenResponse = JSON.parse(content);
    logger.info(
      `[allergenResolver] LLM result: maps=${llmResult.maps_to_existing}, ` +
      `allergen="${llmResult.allergen_name}", confidence=${llmResult.confidence}`
    );

    if (llmResult.maps_to_existing && llmResult.allergen_name && llmResult.confidence >= CONFIDENCE_THRESHOLD) {
      // Resolve the LLM-suggested allergen name to an ID
      const matchRows = await executeRaw(
        `SELECT id, name FROM gold.allergens
         WHERE lower(name) ILIKE '%' || lower($1) || '%'
         LIMIT 1`,
        [llmResult.allergen_name]
      );

      if (matchRows.length > 0) {
        const result: AllergenResolutionResult = {
          matched: true,
          allergenId: (matchRows[0] as any).id,
          allergenName: (matchRows[0] as any).name,
          reasoning: llmResult.reasoning,
          source: "llm",
        };

        // Learning cache: auto-insert synonym for future instant lookups
        try {
          await executeRaw(
            `INSERT INTO gold.allergen_synonyms (synonym, canonical_allergen_id)
             VALUES ($1, $2::uuid)
             ON CONFLICT (synonym) DO NOTHING`,
            [input.toLowerCase(), (matchRows[0] as any).id]
          );
          logger.info(`[allergenResolver] Saved LLM-learned synonym: "${input}" → ${result.allergenName}`);
        } catch (synErr) {
          // Non-critical — synonym already exists or constraint violation
          logger.warn(`[allergenResolver] Failed to save LLM synonym:`, synErr);
        }

        cacheSet(key, result);
        return result;
      }
    }

    // LLM says no match or low confidence — truly novel allergen
    const noMatch: AllergenResolutionResult = {
      matched: false,
      reasoning: llmResult.reasoning || `No existing allergen category matches "${input}"`,
    };
    cacheSet(key, noMatch);
    return noMatch;
  } catch (err) {
    logger.error(`[allergenResolver] Tier 3 LLM failed:`, err);
    // Fail open: if LLM is down, treat as novel (user's allergen still gets saved)
    return { matched: false, reasoning: "LLM classification unavailable" };
  }
}
