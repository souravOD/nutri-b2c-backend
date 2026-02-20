import { db } from "../config/database.js";
import { b2cCustomers } from "../../shared/goldSchema.js";
import { eq } from "drizzle-orm";

export async function getB2cCustomerByAppwriteId(appwriteUserId: string) {
  if (!appwriteUserId) return null;
  const rows = await db
    .select()
    .from(b2cCustomers)
    .where(eq(b2cCustomers.appwriteUserId, appwriteUserId))
    .limit(1);
  return rows[0] ?? null;
}

export async function requireB2cCustomerId(appwriteUserId: string) {
  const row = await getB2cCustomerByAppwriteId(appwriteUserId);
  if (!row?.id) {
    const err = new Error("B2C customer mapping not found. Run profile sync first.");
    (err as any).status = 404;
    throw err;
  }
  return row.id;
}

/**
 * Read the pre-resolved b2cCustomerId from req.user (set by auth middleware).
 * Avoids an extra DB lookup on every request.
 */
export function requireB2cCustomerIdFromReq(req: { user?: { b2cCustomerId?: string } }): string {
  const id = req.user?.b2cCustomerId;
  if (!id) {
    const err = new Error("B2C customer mapping not found. Run profile sync first.");
    (err as any).status = 404;
    throw err;
  }
  return id;
}
