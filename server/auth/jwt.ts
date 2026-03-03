import { account } from "../config/appwrite.js";
import { verifyAdminStatus } from "../config/appwrite.js";

export interface UserContext {
  userId: string;
  isAdmin: boolean;
  profile?: any;
  email?: string | null;
  name?: string | null;
  // Extended by auth middleware:
  effectiveUserId?: string;
  b2cCustomerId?: string;
  isImpersonating?: boolean;
}

export async function verifyAppwriteJWT(jwt: string): Promise<UserContext> {
  if (!jwt) {
    throw new Error("X-Appwrite-JWT header required");
  }

  try {
    // Set the JWT session for this client
    const client = account.client.setJWT(jwt);
    const decoded = await account.get();

    // Verify admin status
    const isAdmin = await verifyAdminStatus(decoded.$id, decoded.prefs);

    return {
      userId: decoded.$id,
      isAdmin,
      profile: decoded.prefs,
      email: decoded.email ?? null,
      name: decoded.name ?? null,
    };
  } catch (error) {
    console.error("JWT verification failed:", error);
    throw new Error("Invalid or expired JWT token");
  }
}

export function extractJWTFromHeaders(headers: Record<string, string | string[] | undefined>): string | null {
  const jwt = headers['x-appwrite-jwt'];
  if (typeof jwt === 'string') {
    return jwt;
  }
  return null;
}
