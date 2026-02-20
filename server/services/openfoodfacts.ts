// server/services/openfoodfacts.ts
// External API client for OpenFoodFacts product lookups

interface OpenFoodFactsNutriments {
    "energy-kcal_100g"?: number;
    fat_100g?: number;
    "saturated-fat_100g"?: number;
    "trans-fat_100g"?: number;
    cholesterol_100g?: number;
    sodium_100g?: number;
    carbohydrates_100g?: number;
    fiber_100g?: number;
    sugars_100g?: number;
    proteins_100g?: number;
}

interface OpenFoodFactsProduct {
    code: string;
    product_name?: string;
    brands?: string;
    image_front_url?: string;
    image_url?: string;
    serving_size?: string;
    serving_quantity?: number;
    nutriments?: OpenFoodFactsNutriments;
    allergens_tags?: string[];
    allergens?: string;
    ingredients_text?: string;
    categories_tags?: string[];
    _keywords?: string[];
}

interface OpenFoodFactsResponse {
    code: string;
    status: number;
    status_verbose: string;
    product?: OpenFoodFactsProduct;
}

export interface NormalizedProduct {
    barcode: string;
    name: string;
    brand: string | null;
    imageUrl: string | null;
    servingSize: string | null;
    servingSizeG: number | null;
    calories: number | null;
    totalFatG: number | null;
    saturatedFatG: number | null;
    transFatG: number | null;
    cholesterolMg: number | null;
    sodiumMg: number | null;
    totalCarbsG: number | null;
    dietaryFiberG: number | null;
    totalSugarsG: number | null;
    proteinG: number | null;
    // Raw allergen data for structured processing
    allergenTags: string[];       // normalized tags e.g. ["gluten", "milk"]
    allergenRawTags: string[];    // original tags e.g. ["en:gluten", "en:milk"]
    ingredientText: string | null;
    tags: string[];
    rawData: Record<string, unknown>; // full OFF product for vendor_specific_attrs
}

const BASE_URL =
    process.env.OPENFOODFACTS_API_URL ||
    "https://world.openfoodfacts.org/api/v2";
const USER_AGENT = "NutriB2C-App/1.0 (contact@nutriapp.com)";
const TIMEOUT_MS = 15000;

/**
 * Normalize allergen tag strings from OpenFoodFacts.
 * Converts "en:gluten" → "gluten", "en:milk" → "milk", etc.
 */
function normalizeAllergenTags(tags?: string[]): string[] {
    if (!tags || tags.length === 0) return [];
    return tags.map((t) => {
        const parts = t.split(":");
        return parts.length > 1 ? parts[1] : t;
    });
}

/**
 * Convert sodium from grams (OFF) to milligrams (our schema).
 */
function sodiumGToMg(sodiumG?: number): number | null {
    if (sodiumG == null) return null;
    return Math.round(sodiumG * 1000);
}

/**
 * Fetch product data from OpenFoodFacts API by barcode.
 * Returns null if product not found or API error.
 */
export async function fetchFromOpenFoodFacts(
    barcode: string
): Promise<NormalizedProduct | null> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);

    try {
        const url = `${BASE_URL}/product/${encodeURIComponent(barcode)}.json`;
        console.log(`[OpenFoodFacts] Fetching: ${url}`);

        const response = await fetch(url, {
            headers: {
                "User-Agent": USER_AGENT,
                Accept: "application/json",
            },
            signal: controller.signal,
        });

        if (!response.ok) {
            console.warn(
                `[OpenFoodFacts] HTTP ${response.status} for barcode ${barcode}`
            );
            return null;
        }

        const data = (await response.json()) as OpenFoodFactsResponse;

        if (data.status !== 1 || !data.product) {
            console.log(
                `[OpenFoodFacts] Product not found for barcode ${barcode}: ${data.status_verbose}`
            );
            return null;
        }

        const p = data.product;
        const n = p.nutriments || {};

        return {
            barcode: p.code || barcode,
            name: p.product_name || `Product ${barcode}`,
            brand: p.brands || null,
            imageUrl: p.image_front_url || p.image_url || null,
            servingSize: p.serving_size || null,
            servingSizeG: p.serving_quantity || null,
            calories: n["energy-kcal_100g"] ?? null,
            totalFatG: n.fat_100g ?? null,
            saturatedFatG: n["saturated-fat_100g"] ?? null,
            transFatG: n["trans-fat_100g"] ?? null,
            cholesterolMg: n.cholesterol_100g != null
                ? Math.round(n.cholesterol_100g * 1000)
                : null,
            sodiumMg: sodiumGToMg(n.sodium_100g),
            totalCarbsG: n.carbohydrates_100g ?? null,
            dietaryFiberG: n.fiber_100g ?? null,
            totalSugarsG: n.sugars_100g ?? null,
            proteinG: n.proteins_100g ?? null,
            allergenTags: normalizeAllergenTags(p.allergens_tags),
            allergenRawTags: p.allergens_tags || [],
            ingredientText: p.ingredients_text || null,
            tags: p._keywords || [],
            rawData: data.product as unknown as Record<string, unknown>,
        };
    } catch (error: unknown) {
        if (error instanceof Error && error.name === "AbortError") {
            console.warn(`[OpenFoodFacts] Timeout for barcode ${barcode}`);
        } else {
            console.error(`[OpenFoodFacts] Error fetching barcode ${barcode}:`, error);
        }
        return null;
    } finally {
        clearTimeout(timeout);
    }
}
