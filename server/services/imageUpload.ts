import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL = process.env.SUPABASE_URL!;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const BUCKET_NAME = "recipe-images";

let _supabase: ReturnType<typeof createClient> | null = null;

function getSupabase() {
    if (!_supabase) {
        _supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);
    }
    return _supabase;
}

/**
 * Upload a recipe image to Supabase Storage.
 * Path: recipe-images/{customerId}/{recipeId}/image.webp
 *
 * @returns Public URL of the uploaded image
 */
export async function uploadRecipeImage(
    buffer: Buffer,
    mimeType: string,
    customerId: string,
    recipeId: string,
): Promise<string> {
    const supabase = getSupabase();

    // Determine file extension from MIME type
    const ext = mimeType === "image/png" ? "png" : mimeType === "image/webp" ? "webp" : "jpg";
    const filePath = `${customerId}/${recipeId}/image.${ext}`;

    const { error } = await supabase.storage
        .from(BUCKET_NAME)
        .upload(filePath, buffer, {
            contentType: mimeType,
            upsert: true, // overwrite if exists
        });

    if (error) {
        throw new Error(`Failed to upload recipe image: ${error.message}`);
    }

    const { data } = supabase.storage.from(BUCKET_NAME).getPublicUrl(filePath);

    return data.publicUrl;
}

/**
 * Delete a recipe's image from Supabase Storage.
 */
export async function deleteRecipeImage(
    customerId: string,
    recipeId: string,
): Promise<void> {
    const supabase = getSupabase();

    // Try all possible extensions
    const paths = [
        `${customerId}/${recipeId}/image.jpg`,
        `${customerId}/${recipeId}/image.png`,
        `${customerId}/${recipeId}/image.webp`,
    ];

    const { error } = await supabase.storage.from(BUCKET_NAME).remove(paths);

    if (error) {
        console.warn(`Failed to delete recipe image: ${error.message}`);
        // Don't throw — image deletion is best-effort
    }
}
