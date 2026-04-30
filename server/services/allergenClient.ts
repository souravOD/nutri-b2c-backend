// server/services/allergenClient.ts
// Fire-and-forget HTTP client for the Allergen Backfill Pipeline
// Mirrors ragClient.ts pattern but simpler (no circuit breaker needed — async, non-critical path)

import { logger } from "../config/logger.js";

// ── Configuration ────────────────────────────────────────────────────────────

const ALLERGEN_API_URL = process.env.ALLERGEN_API_URL || "";
const ALLERGEN_API_KEY = process.env.ALLERGEN_API_KEY || "";
const USE_ALLERGEN_PIPELINE = process.env.USE_ALLERGEN_PIPELINE === "true";
const TIMEOUT_MS = 15_000; // Pipeline may invoke LLM for ingredient matching

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * Fire-and-forget call to the Allergen Backfill Pipeline.
 *
 * Pre-condition (B2C has already done):
 *   Step 1 — gold.allergens INSERT (silver_id = NULL)
 *   Step 4 — gold.b2c_customer_allergens INSERT (link user to allergen)
 *
 * The pipeline will:
 *   Step 5 — INSERT silver.allergens
 *   Step 6 — INSERT silver.allergens_info (stub)
 *   Step 7 — INSERT silver.ingredient_allergens (4-step matching)
 *   Step 8 — UPDATE gold.allergens SET silver_id
 *   Step 2 — INSERT gold.allergens_info (stub)
 *   Step 3 — INSERT gold.ingredient_allergens (via data_lineage)
 *
 * On failure: silently logged. User's allergen is already saved in gold.
 * The pipeline can be retried later — all operations are idempotent.
 */
export async function allergenBackfill(
  goldAllergenId: string,
  allergenName: string,
  submittedBy: string
): Promise<void> {
  // Gate: feature flag
  if (!USE_ALLERGEN_PIPELINE) {
    logger.debug("[allergenClient] Pipeline disabled (USE_ALLERGEN_PIPELINE != true)");
    return;
  }

  if (!ALLERGEN_API_URL) {
    logger.warn("[allergenClient] ALLERGEN_API_URL not configured, skipping backfill");
    return;
  }

  const url = `${ALLERGEN_API_URL}/allergens/backfill`;
  const payload = {
    gold_allergen_id: goldAllergenId,
    allergen_name: allergenName,
    submitted_by: submittedBy,
  };

  logger.info(
    `[allergenClient] Firing backfill → ${url} | allergen="${allergenName}" goldId=${goldAllergenId}`
  );

  // Fire-and-forget: don't await in the caller's hot path
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);

    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-API-Key": ALLERGEN_API_KEY,
      },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });

    clearTimeout(timeout);

    if (!response.ok) {
      const body = await response.text().catch(() => "<unreadable>");
      logger.error(
        `[allergenClient] Pipeline returned ${response.status}: ${body}`
      );
    } else {
      const result = await response.json().catch(() => ({}));
      logger.info(
        `[allergenClient] Pipeline success: ${JSON.stringify(result)}`
      );
    }
  } catch (err: any) {
    if (err.name === "AbortError") {
      logger.error(`[allergenClient] Pipeline timed out after ${TIMEOUT_MS}ms`);
    } else {
      logger.error(`[allergenClient] Pipeline call failed:`, err);
    }
    // Non-critical: user's allergen is already saved in gold.allergens
  }
}
