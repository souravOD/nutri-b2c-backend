// server/services/appwrite.ts
import { Client, Users, Databases, Query } from "node-appwrite";
import { logger } from "../config/logger.js";
import { executeRaw } from "../config/database.js";

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

// ── Queue helper (Phase 4) ───────────────────────────────────────────────────

async function queueAppwriteCleanup(
  userId: string,
  operation: "delete_user" | "delete_documents" | "disable_user"
) {
  try {
    await executeRaw(
      `INSERT INTO gold.b2c_appwrite_cleanup_queue (appwrite_user_id, operation, next_retry_at)
       VALUES ($1, $2, NOW() + INTERVAL '15 minutes')`,
      [userId, operation]
    );
    logger.warn({ userId, operation }, "[appwrite] queued for retry");
  } catch (queueErr) {
    // If even queuing fails (table doesn't exist yet), just log
    logger.error({ userId, operation, queueErr }, "[appwrite] CRITICAL: failed to queue retry");
  }
}

// ── Document deletion ────────────────────────────────────────────────────────

/** Delete Appwrite DB documents — queues for retry on failure. */
export async function deleteAppwriteDocuments(userId: string) {
  try {
    await deleteAppwriteDocumentsDirect(userId);
  } catch (e: any) {
    const errMsg = e?.message ?? e?.response?.message ?? String(e);
    logger.error({ userId, err: errMsg }, "[appwrite] delete documents failed — queuing retry");
    await queueAppwriteCleanup(userId, "delete_documents");
  }
}

/** Direct document deletion (no queue fallback) — used by the retry worker. */
export async function deleteAppwriteDocumentsDirect(userId: string) {
  const { db: appDb } = admin();

  const tryDirectDelete = async (collectionId: string) => {
    try {
      await appDb.deleteDocument(APPWRITE_DB_ID!, collectionId, userId);
    } catch {
      // If ids don't match, delete by query (best effort).
      const list = await appDb.listDocuments(APPWRITE_DB_ID!, collectionId, [Query.equal("$id", userId)]);
      await Promise.all(list.documents.map((d: any) => appDb.deleteDocument(APPWRITE_DB_ID!, collectionId, d.$id)));
    }
  };

  await Promise.all([
    tryDirectDelete(APPWRITE_PROFILES_COLLECTION_ID!),
    tryDirectDelete(APPWRITE_HEALTH_COLLECTION_ID!),
  ]);
  logger.info(`[appwrite] documents deleted for ${userId}`);
}

// ── User deletion ────────────────────────────────────────────────────────────

/** Delete Appwrite auth user — queues for retry on failure. */
export async function deleteAppwriteUser(userId: string) {
  try {
    await deleteAppwriteUserDirect(userId);
  } catch (e: any) {
    const errCode = e?.code ?? e?.response?.statusCode;
    // 404 = already deleted — not an error
    if (errCode === 404) {
      logger.info(`[appwrite] Auth user already gone: ${userId}`);
      return;
    }
    const errMsg = e?.message ?? e?.response?.message ?? String(e);
    logger.error({ userId, err: errMsg, code: errCode }, "[appwrite] delete user failed — queuing retry");
    await queueAppwriteCleanup(userId, "delete_user");
  }
}

/** Direct user deletion (no queue fallback) — used by the retry worker. */
export async function deleteAppwriteUserDirect(userId: string) {
  const { users } = admin();
  await users.delete(userId);
  logger.info(`[appwrite] Auth user deleted: ${userId}`);
}

// ── User disable/enable (Phase 2: soft-delete) ──────────────────────────────

/** Disable Appwrite auth user (blocks login but preserves data). */
export async function disableAppwriteUser(userId: string) {
  const { users } = admin();
  try {
    await users.updateStatus(userId, false);
    logger.info(`[appwrite] Auth user disabled: ${userId}`);
  } catch (e: any) {
    const errMsg = e?.message ?? e?.response?.message ?? String(e);
    logger.error({ userId, err: errMsg }, "[appwrite] disable user failed — queuing retry");
    await queueAppwriteCleanup(userId, "disable_user");
  }
}

/** Re-enable Appwrite auth user (for account recovery). */
export async function enableAppwriteUser(userId: string) {
  const { users } = admin();
  try {
    await users.updateStatus(userId, true);
    logger.info(`[appwrite] Auth user re-enabled: ${userId}`);
  } catch (e: any) {
    const errMsg = e?.message ?? e?.response?.message ?? String(e);
    logger.error({ userId, err: errMsg }, "[appwrite] enable user failed");
    // Don't queue — the user is trying to recover, we should surface the error
    throw e;
  }
}

// ── Profile sync (unchanged) ─────────────────────────────────────────────────

/**
 * Write profile changes back to Appwrite profiles collection + Auth user.
 * Best-effort — failures are logged but don't break the caller.
 */
export async function updateAppwriteProfile(
  userId: string,
  data: { displayName?: string | null }
) {
  if (!APPWRITE_DB_ID || !APPWRITE_PROFILES_COLLECTION_ID) {
    logger.warn("[appwrite] profile write-back skipped: missing DB_ID or COLLECTION_ID");
    return;
  }
  const { db: appDb, users } = admin();
  const payload: Record<string, any> = {};
  if (data.displayName !== undefined) payload.displayName = data.displayName ?? "";
  if (Object.keys(payload).length === 0) return;
  try {
    await appDb.updateDocument(APPWRITE_DB_ID, APPWRITE_PROFILES_COLLECTION_ID, userId, payload);
    logger.info(`[appwrite] profile doc updated for ${userId}`);
    // Also sync Auth user record name
    if (data.displayName !== undefined) {
      await users.updateName(userId, data.displayName ?? "");
      logger.info(`[appwrite] auth name updated for ${userId}`);
    }
  } catch (e: any) {
    // Appwrite SDK errors are not standard Error objects — extract details
    const errMsg = e?.message ?? e?.response?.message ?? String(e);
    const errCode = e?.code ?? e?.response?.statusCode ?? "unknown";
    const errType = e?.type ?? e?.response?.type ?? "unknown";
    logger.error({
      err: { message: errMsg, code: errCode, type: errType },
      userId,
      payload,
    }, "[appwrite] profile write-back failed");
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
  const { db: appDb } = admin();

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
    await appDb.updateDocument(APPWRITE_DB_ID, APPWRITE_HEALTH_COLLECTION_ID, userId, payload);
  } catch (e) {
    logger.warn("[appwrite] health write-back failed:", e);
  }
}

