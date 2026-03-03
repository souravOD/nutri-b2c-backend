import { Client, Account } from "appwrite";
import { env } from "./env.js";

if (!env.APPWRITE_ENDPOINT || !env.APPWRITE_PROJECT_ID) {
  throw new Error("Appwrite configuration is required");
}

// Client SDK — used for JWT-based user session operations (account.get, etc.)
export const appwriteClient = new Client()
  .setEndpoint(env.APPWRITE_ENDPOINT)
  .setProject(env.APPWRITE_PROJECT_ID);

export const account = new Account(appwriteClient);

/**
 * Verify admin status using profile role.
 *
 * Note: Team-based admin check (ADMINS_TEAM_ID) has been disabled because
 * the Appwrite API key does not have `teams.read` scope, causing 401 errors
 * on every authenticated request. To re-enable:
 *   1. Regenerate the API key with `teams.read` scope in the Appwrite console
 *   2. Re-add the Teams check here using the node-appwrite server SDK
 */
export async function verifyAdminStatus(userId: string, userProfile?: any): Promise<boolean> {
  // Check if user has admin role in profile prefs
  if (userProfile?.role === "admin") {
    return true;
  }

  return false;
}
