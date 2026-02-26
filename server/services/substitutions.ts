import { executeRaw } from "../config/database.js";
import { ragIngredientSubstitutions, ragAlternatives } from "./ragClient.js";
import { resolveMemberScope } from "./memberScope.js";

// ── Allergen Helper ─────────────────────────────────────────────────────────

async function getMemberAllergenIds(memberId: string): Promise<string[]> {
    const rows = await executeRaw(
        `SELECT allergen_id FROM gold.b2c_customer_allergens
     WHERE b2c_customer_id = $1 AND is_active = true`,
        [memberId]
    );
    return (rows as any[]).map((r) => r.allergen_id);
}

// ── Ingredient Substitutions ────────────────────────────────────────────────

export async function getIngredientSubstitutions(
    actorB2cCustomerId: string,
    ingredientId: string,
    memberId?: string
) {
    const scope = await resolveMemberScope(actorB2cCustomerId, memberId);
    const allergens = await getMemberAllergenIds(scope.targetMemberId);

    // Try graph-based substitutions
    const graphSubs = await ragIngredientSubstitutions(ingredientId, allergens);
    if (graphSubs) {
        return { substitutions: graphSubs.substitutions, source: "graph" };
    }

    // No SQL fallback for ingredient substitutions
    return { substitutions: [], source: "none" };
}

// ── Product Substitutions ───────────────────────────────────────────────────

export async function getProductSubstitutions(
    actorB2cCustomerId: string,
    productId: string,
    memberId?: string
) {
    const scope = await resolveMemberScope(actorB2cCustomerId, memberId);
    const allergens = await getMemberAllergenIds(scope.targetMemberId);

    // Try graph-based alternatives (reuses PRD-14 ragAlternatives)
    const graphAlts = await ragAlternatives(productId, allergens);
    if (graphAlts) {
        return { substitutions: graphAlts.alternatives, source: "graph" };
    }

    // No SQL fallback
    return { substitutions: [], source: "none" };
}
