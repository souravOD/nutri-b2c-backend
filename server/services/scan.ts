// server/services/scan.ts
// Core service for barcode scanning: product lookup, personalized warnings, scan history
// Zero-schema-change approach: all OFF data normalized into existing gold.products columns

import { db, executeRaw } from "../config/database.js";
import { products, productAllergens, scanHistory } from "../../shared/goldSchema.js";
import { eq, and } from "drizzle-orm";
import { fetchFromOpenFoodFacts } from "./openfoodfacts.js";
import type { NormalizedProduct } from "./openfoodfacts.js";
import type { GoldProduct } from "../../shared/goldSchema.js";

// ─── Types ──────────────────────────────────────────────────────────────────

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

export interface ScanLookupResult {
    product: {
        id: string;
        barcode: string | null;
        name: string;
        brand: string | null;
        imageUrl: string | null;
        allergens: string[];
        nutrition: {
            calories: number | null;
            protein_g: number | null;
            carbs_g: number | null;
            fat_g: number | null;
            fiber_g: number | null;
            sugar_g: number | null;
            sodium_mg: number | null;
            saturatedFat: number | null;
            transFat: number | null;
            cholesterol: number | null;
        };
        servingSize: string | null;
        ingredientText: string | null;
    } | null;
    allergenWarnings: AllergenWarning[];
    healthWarnings: HealthWarning[];
    source: "cache" | "openfoodfacts" | "not_found";
}

// ─── Product Lookup ─────────────────────────────────────────────────────────

/**
 * Look up a product by barcode:
 * 1. Check local cache (gold.products)
 * 2. If not found, fetch from OpenFoodFacts and cache
 * 3. Generate personalized warnings
 */
export async function lookupProductByBarcode(
    barcode: string,
    b2cCustomerId: string,
    memberId?: string
): Promise<ScanLookupResult> {
    // 1. Check cache
    const cached = await db
        .select()
        .from(products)
        .where(eq(products.barcode, barcode))
        .limit(1);

    let product: GoldProduct | null = cached[0] ?? null;
    let source: ScanLookupResult["source"] = "cache";

    // 2. Fetch from external API if not cached
    if (!product) {
        const external = await fetchFromOpenFoodFacts(barcode);
        if (external) {
            product = await cacheProduct(external);
            await cacheProductAllergens(product.id, external);
            source = "openfoodfacts";
        } else {
            return {
                product: null,
                allergenWarnings: [],
                healthWarnings: [],
                source: "not_found",
            };
        }
    }

    // 3. Generate personalized warnings
    const targetMemberId = memberId || b2cCustomerId;
    const [allergenWarnings, healthWarnings, allergenNames] = await Promise.all([
        generateAllergenWarnings(product.id, targetMemberId),
        generateHealthWarnings(product, targetMemberId),
        getProductAllergenNames(product.id),
    ]);

    return {
        product: formatProductResponse(product, allergenNames),
        allergenWarnings,
        healthWarnings,
        source,
    };
}

// ─── Product Caching ────────────────────────────────────────────────────────

/**
 * Cache a product from OpenFoodFacts into gold.products.
 * Maps OFF data into existing columns:
 *   - ingredient_text → description
 *   - tags + raw OFF response → vendor_specific_attrs (jsonb)
 *   - source tracking → source_system
 *   - cache freshness → updated_at
 */
async function cacheProduct(data: NormalizedProduct): Promise<GoldProduct> {
    const vendorAttrs = {
        tags: data.tags,
        allergens: data.allergenTags,
        allergenRawTags: data.allergenRawTags,
        ingredientText: data.ingredientText,
        rawResponse: data.rawData,
        fetchedAt: new Date().toISOString(),
    };

    // Raw SQL upsert required because both unique indexes on `barcode` are PARTIAL
    // (WHERE barcode IS NOT NULL). Drizzle's onConflictDoUpdate generates
    // ON CONFLICT (barcode) without the WHERE clause, so PostgreSQL rejects it.
    const vendorAttrsJson = JSON.stringify(vendorAttrs);
    const rows = await executeRaw(
        `INSERT INTO gold.products
            (barcode, name, brand, description, image_url,
             serving_size, serving_size_g,
             calories, total_fat_g, saturated_fat_g, trans_fat_g,
             cholesterol_mg, sodium_mg, total_carbs_g, dietary_fiber_g,
             total_sugars_g, protein_g,
             source_system, vendor_specific_attrs)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19::jsonb)
         ON CONFLICT (barcode) WHERE barcode IS NOT NULL
         DO UPDATE SET
             name             = EXCLUDED.name,
             brand            = EXCLUDED.brand,
             description      = EXCLUDED.description,
             image_url        = EXCLUDED.image_url,
             calories         = EXCLUDED.calories,
             protein_g        = EXCLUDED.protein_g,
             total_fat_g      = EXCLUDED.total_fat_g,
             saturated_fat_g  = EXCLUDED.saturated_fat_g,
             trans_fat_g      = EXCLUDED.trans_fat_g,
             cholesterol_mg   = EXCLUDED.cholesterol_mg,
             sodium_mg        = EXCLUDED.sodium_mg,
             total_carbs_g    = EXCLUDED.total_carbs_g,
             dietary_fiber_g  = EXCLUDED.dietary_fiber_g,
             total_sugars_g   = EXCLUDED.total_sugars_g,
             source_system    = EXCLUDED.source_system,
             vendor_specific_attrs = EXCLUDED.vendor_specific_attrs,
             updated_at       = now()
         RETURNING *`,
        [
            data.barcode,
            data.name,
            data.brand,
            data.ingredientText,
            data.imageUrl,
            data.servingSize,
            data.servingSizeG ?? null,
            data.calories ?? null,
            data.totalFatG ?? null,
            data.saturatedFatG ?? null,
            data.transFatG ?? null,
            data.cholesterolMg ?? null,
            data.sodiumMg ?? null,
            data.totalCarbsG ?? null,
            data.dietaryFiberG ?? null,
            data.totalSugarsG ?? null,
            data.proteinG ?? null,
            "openfoodfacts",
            vendorAttrsJson,
        ]
    ) as unknown as GoldProduct[];

    return rows[0];
}

/**
 * Cache allergens from OpenFoodFacts into gold.product_allergens.
 * - Matched allergens → insert into product_allergens with FK
 * - Unmatched allergens → stored in vendor_specific_attrs (already done in cacheProduct)
 */
async function cacheProductAllergens(
    productId: string,
    data: NormalizedProduct
): Promise<void> {
    if (data.allergenTags.length === 0) return;

    try {
        // 1. Batch lookup allergen IDs by code or name
        const matchedAllergens = await executeRaw(
            `SELECT id, code, name FROM gold.allergens
       WHERE LOWER(code) = ANY($1) OR LOWER(name) = ANY($1)`,
            [data.allergenTags.map((t) => t.toLowerCase())]
        ) as unknown as { id: string; code: string; name: string }[];

        if (matchedAllergens.length === 0) {
            console.log(
                `[Scan] No allergen matches in DB for tags: ${data.allergenTags.join(", ")}`
            );
            return;
        }

        // 2. Find the original raw tag for each match (for raw_text)
        const tagToRaw = new Map<string, string>();
        for (let i = 0; i < data.allergenTags.length; i++) {
            tagToRaw.set(
                data.allergenTags[i].toLowerCase(),
                data.allergenRawTags[i] || data.allergenTags[i]
            );
        }

        // 3. Delete existing product_allergens for this product (from previous scans)
        await executeRaw(
            `DELETE FROM gold.product_allergens WHERE product_id = $1 AND data_source = 'openfoodfacts'`,
            [productId]
        );

        // 4. Insert matched allergens
        for (const allergen of matchedAllergens) {
            const rawTag =
                tagToRaw.get(allergen.code.toLowerCase()) ||
                tagToRaw.get(allergen.name.toLowerCase()) ||
                allergen.code;

            await db.insert(productAllergens).values({
                productId,
                allergenId: allergen.id,
                statementType: "contains",
                sourceType: "declared",
                dataSource: "openfoodfacts",
                confidenceScore: "0.95",
                rawText: rawTag,
            });
        }

        // Log unmatched for visibility
        const matchedCodes = new Set(
            matchedAllergens.map((a) => a.code.toLowerCase())
        );
        const matchedNames = new Set(
            matchedAllergens.map((a) => a.name.toLowerCase())
        );
        const unmatched = data.allergenTags.filter(
            (t) => !matchedCodes.has(t.toLowerCase()) && !matchedNames.has(t.toLowerCase())
        );
        if (unmatched.length > 0) {
            console.log(
                `[Scan] Unmatched allergens stored in vendor_specific_attrs: ${unmatched.join(", ")}`
            );
        }

        console.log(
            `[Scan] Cached ${matchedAllergens.length} allergens for product ${productId}`
        );
    } catch (error) {
        console.error("[Scan] Failed to cache product allergens:", error);
        // Non-fatal — allergens are also in vendor_specific_attrs as fallback
    }
}

/**
 * Get allergen names for a product from product_allergens + vendor_specific_attrs fallback.
 */
async function getProductAllergenNames(productId: string): Promise<string[]> {
    try {
        // Try structured product_allergens first
        const structured = await executeRaw(
            `SELECT DISTINCT a.name
       FROM gold.product_allergens pa
       JOIN gold.allergens a ON a.id = pa.allergen_id
       WHERE pa.product_id = $1`,
            [productId]
        ) as unknown as { name: string }[];

        if (structured.length > 0) {
            return structured.map((r) => r.name);
        }

        // Fallback: read from vendor_specific_attrs
        const product = await db
            .select({ vendorSpecificAttrs: products.vendorSpecificAttrs })
            .from(products)
            .where(eq(products.id, productId))
            .limit(1);

        const attrs = product[0]?.vendorSpecificAttrs as Record<string, unknown> | null;
        if (attrs?.allergens && Array.isArray(attrs.allergens)) {
            return attrs.allergens as string[];
        }

        return [];
    } catch (error) {
        console.error("[Scan] Failed to get product allergens:", error);
        return [];
    }
}

/**
 * Format a DB product row into the API response shape.
 */
function formatProductResponse(p: GoldProduct, allergenNames: string[]) {
    return {
        id: p.id,
        barcode: p.barcode,
        name: p.name,
        brand: p.brand,
        imageUrl: p.imageUrl,
        allergens: allergenNames,
        nutrition: {
            calories: p.calories ? Number(p.calories) : null,
            protein_g: p.proteinG ? Number(p.proteinG) : null,
            carbs_g: p.totalCarbsG ? Number(p.totalCarbsG) : null,
            fat_g: p.totalFatG ? Number(p.totalFatG) : null,
            fiber_g: p.dietaryFiberG ? Number(p.dietaryFiberG) : null,
            sugar_g: p.totalSugarsG ? Number(p.totalSugarsG) : null,
            sodium_mg: p.sodiumMg ? Number(p.sodiumMg) : null,
            saturatedFat: p.saturatedFatG ? Number(p.saturatedFatG) : null,
            transFat: p.transFatG ? Number(p.transFatG) : null,
            cholesterol: p.cholesterolMg ? Number(p.cholesterolMg) : null,
        },
        servingSize: p.servingSize,
        ingredientText: p.description, // ingredient text stored in description
    };
}

// ─── Personalized Warnings ──────────────────────────────────────────────────

/**
 * Generate allergen warnings using product_allergens FK JOIN.
 * No more fuzzy string matching — exact FK join between product allergens
 * and member allergens via the shared allergens table.
 */
async function generateAllergenWarnings(
    productId: string,
    memberId: string
): Promise<AllergenWarning[]> {
    try {
        const warnings = await executeRaw(
            `
      SELECT
        a.name AS allergen_name,
        ca.severity,
        c.full_name AS member_name
      FROM gold.product_allergens pa
      JOIN gold.allergens a ON a.id = pa.allergen_id
      JOIN gold.b2c_customer_allergens ca ON ca.allergen_id = pa.allergen_id
      JOIN gold.b2c_customers c ON c.id = ca.b2c_customer_id
      WHERE pa.product_id = $1
        AND ca.b2c_customer_id = $2
        AND ca.is_active = true
      `,
            [productId, memberId]
        ) as unknown as {
            allergen_name: string;
            severity: string | null;
            member_name: string;
        }[];

        return warnings.map((w) => ({
            allergenName: w.allergen_name,
            severity: w.severity,
            memberName: w.member_name,
            message: `⚠️ Contains ${w.allergen_name}${w.severity ? ` (${w.severity} sensitivity)` : ""
                } — unsafe for ${w.member_name}`,
        }));
    } catch (error) {
        console.error("[Scan] Allergen warning generation failed:", error);
        return [];
    }
}

/**
 * Check product nutrition against member's health condition thresholds.
 */
async function generateHealthWarnings(
    product: GoldProduct,
    memberId: string
): Promise<HealthWarning[]> {
    try {
        const memberConditions = await executeRaw(
            `
      SELECT hc.name, hc.code
      FROM gold.b2c_customer_health_conditions chc
      JOIN gold.health_conditions hc ON hc.id = chc.condition_id
      WHERE chc.b2c_customer_id = $1 AND chc.is_active = true
      `,
            [memberId]
        );

        if (!memberConditions.length) return [];

        const warnings: HealthWarning[] = [];
        const sodium = product.sodiumMg ? Number(product.sodiumMg) : null;
        const sugar = product.totalSugarsG ? Number(product.totalSugarsG) : null;
        const satFat = product.saturatedFatG
            ? Number(product.saturatedFatG)
            : null;
        const cholesterol = product.cholesterolMg
            ? Number(product.cholesterolMg)
            : null;

        for (const mc of memberConditions) {
            const cond = mc as unknown as { name: string; code: string };
            const code = cond.code.toLowerCase();

            // Hypertension: warn on high sodium (>600mg per 100g)
            if (
                (code.includes("hypertension") ||
                    code.includes("high_blood_pressure")) &&
                sodium != null &&
                sodium > 600
            ) {
                warnings.push({
                    conditionName: cond.name,
                    nutrient: "sodium",
                    value: sodium,
                    message: `⚠️ High sodium (${sodium}mg/100g) — not recommended for ${cond.name}`,
                });
            }

            // Diabetes: warn on high sugar (>15g per 100g)
            if (
                (code.includes("diabetes") || code.includes("prediabetes")) &&
                sugar != null &&
                sugar > 15
            ) {
                warnings.push({
                    conditionName: cond.name,
                    nutrient: "sugar",
                    value: sugar,
                    message: `⚠️ High sugar (${sugar}g/100g) — monitor intake for ${cond.name}`,
                });
            }

            // Heart disease: warn on high saturated fat (>5g per 100g)
            if (
                (code.includes("heart") || code.includes("cardiovascular")) &&
                satFat != null &&
                satFat > 5
            ) {
                warnings.push({
                    conditionName: cond.name,
                    nutrient: "saturated fat",
                    value: satFat,
                    message: `⚠️ High saturated fat (${satFat}g/100g) — limit for ${cond.name}`,
                });
            }

            // High cholesterol: warn on cholesterol (>60mg per 100g)
            if (
                code.includes("cholesterol") &&
                cholesterol != null &&
                cholesterol > 60
            ) {
                warnings.push({
                    conditionName: cond.name,
                    nutrient: "cholesterol",
                    value: cholesterol,
                    message: `⚠️ Contains ${cholesterol}mg cholesterol/100g — limit for ${cond.name}`,
                });
            }
        }

        return warnings;
    } catch (error) {
        console.error("[Scan] Health warning generation failed:", error);
        return [];
    }
}

// ─── Scan History ───────────────────────────────────────────────────────────

/**
 * Save a scan event to history.
 */
export async function saveScanHistory(params: {
    b2cCustomerId: string;
    householdId?: string;
    productId?: string;
    barcode: string;
    barcodeFormat?: string;
    scanSource?: string;
}): Promise<string> {
    const inserted = await db
        .insert(scanHistory)
        .values({
            b2cCustomerId: params.b2cCustomerId,
            householdId: params.householdId ?? null,
            productId: params.productId ?? null,
            barcode: params.barcode,
            barcodeFormat: params.barcodeFormat ?? null,
            scanSource: params.scanSource ?? "camera",
        })
        .returning({ id: scanHistory.id });

    return inserted[0].id;
}

/**
 * Get paginated scan history for a user.
 */
export async function getScanHistory(
    b2cCustomerId: string,
    limit: number = 20,
    offset: number = 0
) {
    const items = await executeRaw(
        `
    SELECT
      sh.id,
      sh.barcode,
      sh.barcode_format,
      sh.scan_source,
      sh.scanned_at,
      p.name as product_name,
      p.brand as product_brand,
      p.image_url as product_image,
      p.id as product_id
    FROM gold.scan_history sh
    LEFT JOIN gold.products p ON p.id = sh.product_id
    WHERE sh.b2c_customer_id = $1
    ORDER BY sh.scanned_at DESC
    LIMIT $2 OFFSET $3
    `,
        [b2cCustomerId, limit, offset]
    );

    const countResult = await executeRaw(
        `SELECT count(*)::int as total FROM gold.scan_history WHERE b2c_customer_id = $1`,
        [b2cCustomerId]
    );

    return {
        items: items.map((row: any) => ({
            id: row.id,
            barcode: row.barcode,
            barcodeFormat: row.barcode_format,
            scanSource: row.scan_source,
            scannedAt: row.scanned_at,
            product: row.product_name
                ? {
                    id: row.product_id,
                    name: row.product_name,
                    brand: row.product_brand,
                    imageUrl: row.product_image,
                }
                : null,
        })),
        total: countResult[0]?.total ?? 0,
    };
}
