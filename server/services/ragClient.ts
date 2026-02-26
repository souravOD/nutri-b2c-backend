// server/services/ragClient.ts
// PRD-09: Circuit breaker + SQL fallback client for RAG API
// ─────────────────────────────────────────────────────────

// ── Types ────────────────────────────────────────────────

type CircuitState = "CLOSED" | "OPEN" | "HALF_OPEN";

type FeatureName =
    | "search"
    | "feed"
    | "mealPlan"
    | "grocery"
    | "scanner"
    | "mealLog"
    | "chatbot"
    | "substitution";

interface FeatureConfig {
    flag: string;
    endpoint: string;
    timeout: number;
}

// ── Per-Feature Configuration ────────────────────────────

const FEATURE_CONFIG: Record<FeatureName, FeatureConfig> = {
    search: { flag: "USE_GRAPH_SEARCH", endpoint: "/search/hybrid", timeout: 60_000 },
    feed: { flag: "USE_GRAPH_FEED", endpoint: "/recommend/feed", timeout: 60_000 },
    mealPlan: { flag: "USE_GRAPH_MEAL_PLAN", endpoint: "/recommend/meal-candidates", timeout: 60_000 },
    grocery: { flag: "USE_GRAPH_GROCERY", endpoint: "/recommend/products", timeout: 60_000 },
    scanner: { flag: "USE_GRAPH_SCANNER", endpoint: "/recommend/alternatives", timeout: 60_000 },
    mealLog: { flag: "USE_GRAPH_MEAL_LOG", endpoint: "/analytics/meal-patterns", timeout: 60_000 },
    chatbot: { flag: "USE_GRAPH_CHATBOT", endpoint: "/chat/process", timeout: 60_000 },
    substitution: { flag: "USE_GRAPH_GROCERY", endpoint: "/substitutions/ingredient", timeout: 60_000 },
} as const;
// ⚠️ Testing timeouts above — prod values: search/feed/grocery/scanner/mealLog=3s, mealPlan=5s, chatbot=10s

// ── Circuit Breaker Constants ────────────────────────────

const FAILURE_THRESHOLD = 3;     // consecutive failures before OPEN
const COOLDOWN_MS = 30_000;      // 30s before HALF_OPEN

// ── Circuit Breaker State (in-memory, single process) ────

let circuitState: CircuitState = "CLOSED";
let consecutiveFailures = 0;
let lastFailureAt: number | null = null;

// ── Internal Helpers ─────────────────────────────────────

function isFeatureEnabled(feature: FeatureName): boolean {
    const flagValue = process.env[FEATURE_CONFIG[feature].flag];
    return flagValue === "true" || flagValue === "1";
}

function shouldAllowRequest(): boolean {
    if (circuitState === "CLOSED") return true;

    if (circuitState === "OPEN") {
        // Check cooldown
        if (lastFailureAt && Date.now() - lastFailureAt >= COOLDOWN_MS) {
            circuitState = "HALF_OPEN";
            console.log("[RAG] Circuit → HALF_OPEN (cooldown expired, allowing test request)");
            return true;
        }
        return false;
    }

    // HALF_OPEN: allow exactly one test request
    return true;
}

function recordSuccess(): void {
    if (circuitState !== "CLOSED") {
        console.log("[RAG] Circuit → CLOSED (request succeeded)");
    }
    circuitState = "CLOSED";
    consecutiveFailures = 0;
}

function recordFailure(): void {
    consecutiveFailures++;
    lastFailureAt = Date.now();

    if (consecutiveFailures >= FAILURE_THRESHOLD && circuitState !== "OPEN") {
        circuitState = "OPEN";
        console.log(
            `[RAG] Circuit → OPEN (${consecutiveFailures} consecutive failures, cooldown ${COOLDOWN_MS / 1000}s)`
        );
    }
}

// ── Core HTTP Caller (3-Gate Pattern) ────────────────────

async function callRag<T>(
    feature: FeatureName,
    body: Record<string, unknown>
): Promise<T | null> {
    const config = FEATURE_CONFIG[feature];

    // Gate 1: Feature flag
    if (!isFeatureEnabled(feature)) {
        return null;
    }

    // Gate 2: Circuit breaker
    if (!shouldAllowRequest()) {
        console.log(`[RAG] ${feature} → SKIPPED (circuit OPEN)`);
        return null;
    }

    // Gate 3: HTTP call with timeout
    const ragUrl = process.env.RAG_API_URL;
    const ragKey = process.env.RAG_API_KEY;

    if (!ragUrl) {
        console.warn("[RAG] RAG_API_URL not configured — falling back to SQL");
        return null;
    }

    const url = `${ragUrl}${config.endpoint}`;
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), config.timeout);
    const startTime = Date.now();

    try {
        const response = await fetch(url, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                ...(ragKey ? { "X-API-Key": ragKey } : {}),
            },
            body: JSON.stringify(body),
            signal: controller.signal,
        });

        clearTimeout(timeoutId);
        const elapsed = Date.now() - startTime;

        if (!response.ok) {
            console.error(`[RAG] ${feature} → ${response.status} (${elapsed}ms) → SQL fallback`);
            recordFailure();
            return null;
        }

        const data = (await response.json()) as T;
        console.log(`[RAG] ${feature} → 200 (${elapsed}ms)`);
        recordSuccess();
        return data;
    } catch (error: unknown) {
        clearTimeout(timeoutId);
        const elapsed = Date.now() - startTime;

        if (error instanceof Error && error.name === "AbortError") {
            console.error(`[RAG] ${feature} → TIMEOUT (${elapsed}ms) → SQL fallback`);
        } else {
            console.error(`[RAG] ${feature} → ERROR (${elapsed}ms) → SQL fallback`, error);
        }

        recordFailure();
        return null;
    }
}

// ── Public API (7 feature functions) ─────────────────────

// Types for RAG API responses
export interface RagSearchResult {
    results: Array<{
        id: string;
        score: number;
        reasons: string[];
        match_type?: string;
    }>;
    query_interpretation?: string;
}

export interface RagFeedResult {
    results: Array<{
        id: string;
        score: number;
        reasons: string[];
        source?: string;
    }>;
}

export interface RagMealCandidatesResult {
    candidates: Array<{
        recipe_id: string;
        title?: string;
        score: number;
        reasons: string[];
    }>;
}

export interface RagProductsResult {
    products: Array<{
        ingredient_id: string;
        product_id: string;
        product_name?: string;
        brand?: string;
        price?: number;
        match_reason?: string;
    }>;
}

export interface RagAlternativesResult {
    alternatives: Array<{
        product_id: string;
        name?: string;
        brand?: string;
        price?: number;
        reason?: string;
        savings?: number;
        allergen_safe?: boolean;
    }>;
}

export interface RagMealPatternsResult {
    varietyScore: number;
    repeatedMeals: Array<{
        recipeId: string;
        title: string;
        count: number;
        lastEaten: string;
    }>;
    cuisineBreakdown: Array<{
        cuisine: string;
        percentage: number;
    }>;
    nutritionTrends?: {
        daily: Array<{
            date: string;
            calories: number;
            proteinG: number;
            carbsG: number;
            fatG: number;
        }>;
    };
    suggestions: string[];
    source: string;
}

export interface RagChatResult {
    response: string;
    intent: string;
    session_id: string;
    message_count?: number;
    action_required?: boolean;
    confirmation_prompt?: string;
    pending_action?: {
        type: string;
        params: Record<string, unknown>;
    };
    recipes?: Array<{
        id: string;
        title: string;
        score: number;
    }>;
}

// ── Feature Functions ────────────────────────────────────

export async function ragSearch(params: {
    query?: string;
    filters?: Record<string, unknown>;
    customer_id?: string;
}): Promise<RagSearchResult | null> {
    return callRag<RagSearchResult>("search", params);
}

export async function ragFeed(
    customerId: string,
    preferences: {
        dietIds?: string[];
        allergenIds?: string[];
        conditionIds?: string[];
        dislikes?: string[];
    }
): Promise<RagFeedResult | null> {
    return callRag<RagFeedResult>("feed", {
        customer_id: customerId,
        preferences,
    });
}

export async function ragMealCandidates(params: {
    customer_id: string;
    members: Array<{
        id: string;
        allergen_ids: string[];
        diet_ids: string[];
        health_profile?: Record<string, unknown>;
    }>;
    meal_history: string[];
    date_range: { start: string; end: string };
    meals_per_day: string[];
    limit?: number;
}): Promise<RagMealCandidatesResult | null> {
    return callRag<RagMealCandidatesResult>("mealPlan", params);
}

export async function ragProducts(
    ingredientIds: string[],
    customerAllergens: string[]
): Promise<RagProductsResult | null> {
    return callRag<RagProductsResult>("grocery", {
        ingredient_ids: ingredientIds,
        customer_allergens: customerAllergens,
    });
}

export async function ragAlternatives(
    productId: string,
    customerAllergens: string[]
): Promise<RagAlternativesResult | null> {
    return callRag<RagAlternativesResult>("scanner", {
        product_id: productId,
        customer_allergens: customerAllergens,
    });
}

export async function ragMealPatterns(
    customerId: string,
    days: number = 14
): Promise<RagMealPatternsResult | null> {
    return callRag<RagMealPatternsResult>("mealLog", {
        customer_id: customerId,
        days,
    });
}

export async function ragChat(
    message: string,
    customerId: string,
    sessionId?: string | null
): Promise<RagChatResult | null> {
    return callRag<RagChatResult>("chatbot", {
        message,
        customer_id: customerId,
        session_id: sessionId ?? null,
    });
}

export interface RagIngredientSubstitutionsResult {
    substitutions: Array<{
        ingredient_id: string;
        name: string;
        reason: string;
        category?: string;
        nutritionComparison?: {
            original: { calories_per_100g: number; protein_g: number };
            substitute: { calories_per_100g: number; protein_g: number };
        };
        allergenSafe: boolean;
        confidence: number;
    }>;
}

export async function ragIngredientSubstitutions(
    ingredientId: string,
    customerAllergens: string[]
): Promise<RagIngredientSubstitutionsResult | null> {
    return callRag<RagIngredientSubstitutionsResult>("substitution", {
        ingredient_id: ingredientId,
        customer_allergens: customerAllergens,
    });
}

// ── Admin Diagnostics ────────────────────────────────────

export function getCircuitStatus() {
    const now = Date.now();
    const cooldownRemaining =
        circuitState === "OPEN" && lastFailureAt
            ? Math.max(0, COOLDOWN_MS - (now - lastFailureAt))
            : 0;

    return {
        state: circuitState,
        consecutiveFailures,
        lastFailureAt: lastFailureAt ? new Date(lastFailureAt).toISOString() : null,
        cooldownRemainingMs: cooldownRemaining,
        config: {
            failureThreshold: FAILURE_THRESHOLD,
            cooldownMs: COOLDOWN_MS,
        },
        featureFlags: {
            search: isFeatureEnabled("search"),
            feed: isFeatureEnabled("feed"),
            mealPlan: isFeatureEnabled("mealPlan"),
            grocery: isFeatureEnabled("grocery"),
            scanner: isFeatureEnabled("scanner"),
            mealLog: isFeatureEnabled("mealLog"),
            chatbot: isFeatureEnabled("chatbot"),
            substitution: isFeatureEnabled("substitution"),
        },
        ragApiUrl: process.env.RAG_API_URL ?? "(not configured)",
    };
}
