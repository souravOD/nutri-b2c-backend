// server/services/appwrite.ts
import { Client, Users, Databases, Query } from "node-appwrite";

const {
  APPWRITE_ENDPOINT,
  APPWRITE_PROJECT_ID,
  APPWRITE_API_KEY,
  APPWRITE_DB_ID,
  APPWRITE_PROFILES_COLLECTION_ID,
  APPWRITE_HEALTH_COLLECTION_ID,
} = process.env;

function admin() {
  const client = new Client()
    .setEndpoint(APPWRITE_ENDPOINT!)
    .setProject(APPWRITE_PROJECT_ID!)
    .setKey(APPWRITE_API_KEY!);
  return {
    users: new Users(client),
    db: new Databases(client),
  };
}

/** Delete Appwrite DB documents keyed by the user's id (or fallback: query by $id). */
export async function deleteAppwriteDocuments(userId: string) {
  const { db } = admin();

  // Most projects use $id === userId for both docs; try direct delete first, then fallback to query.
  const tryDirectDelete = async (collectionId: string) => {
    try {
      await db.deleteDocument(APPWRITE_DB_ID!, collectionId, userId);
    } catch {
      // If ids don’t match, delete by query (best effort).
      const list = await db.listDocuments(APPWRITE_DB_ID!, collectionId, [Query.equal("$id", userId)]);
      await Promise.all(list.documents.map((d: any) => db.deleteDocument(APPWRITE_DB_ID!, collectionId, d.$id)));
    }
  };

  await Promise.all([
    tryDirectDelete(APPWRITE_PROFILES_COLLECTION_ID!),
    tryDirectDelete(APPWRITE_HEALTH_COLLECTION_ID!),
  ]);
}

/** Delete Appwrite auth user (admin) */
export async function deleteAppwriteUser(userId: string) {
  const { users } = admin();
  try {
    await users.delete(userId);
  } catch {
    // Ignore if already gone
  }
}

/**
 * Write profile changes back to Appwrite profiles collection.
 * Best-effort — failures are logged but don't break the caller.
 */
export async function updateAppwriteProfile(
  userId: string,
  data: { displayName?: string | null; email?: string | null }
) {
  if (!APPWRITE_DB_ID || !APPWRITE_PROFILES_COLLECTION_ID) return;
  const { db } = admin();
  const payload: Record<string, any> = {};
  if (data.displayName !== undefined) payload.displayName = data.displayName ?? "";
  if (data.email !== undefined) payload.email = data.email ?? "";
  if (Object.keys(payload).length === 0) return;
  try {
    await db.updateDocument(APPWRITE_DB_ID, APPWRITE_PROFILES_COLLECTION_ID, userId, payload);
  } catch (e) {
    console.warn("[appwrite] profile write-back failed:", e);
  }
}

/**
 * Write health changes back to Appwrite health_profiles collection.
 * Best-effort — failures are logged but don't break the caller.
 */
export async function updateAppwriteHealth(
  userId: string,
  data: Record<string, any>
) {
  if (!APPWRITE_DB_ID || !APPWRITE_HEALTH_COLLECTION_ID) return;
  const { db } = admin();

  // Only send fields that the Appwrite schema supports
  const allowed = [
    "dateOfBirth", "sex", "activityLevel", "goal", "height", "weight",
    "diets", "allergens", "intolerances", "dislikedIngredients",
    "major_conditions", "diet_codes", "diet_ids", "allergen_codes",
    "allergen_ids", "condition_codes", "condition_ids", "onboardingComplete",
  ];
  const payload: Record<string, any> = {};
  for (const key of allowed) {
    if (data[key] !== undefined) payload[key] = data[key];
  }
  if (Object.keys(payload).length === 0) return;

  try {
    await db.updateDocument(APPWRITE_DB_ID, APPWRITE_HEALTH_COLLECTION_ID, userId, payload);
  } catch (e) {
    console.warn("[appwrite] health write-back failed:", e);
  }
}
