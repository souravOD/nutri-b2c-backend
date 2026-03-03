import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as goldSchema from "../../shared/goldSchema.js";
import { env } from "./env.js";

if (!env.DATABASE_URL) {
  throw new Error("DATABASE_URL environment variable is required");
}

// =============================================================================
// DATABASE CONFIGURATION (single pool — no read replica configured)
// =============================================================================

// Primary database connection
export const queryClient = postgres(env.DATABASE_URL, {
  max: 20,
  idle_timeout: 30000,
  connect_timeout: 10000,
  transform: {
    undefined: null,
  },
});

// Drizzle instance
export const db = drizzle(queryClient, { schema: goldSchema });
// Alias for code that references dbRead (reads go to primary)
export const dbRead = db;

// Connection for migrations
export const migrationClient = postgres(env.DATABASE_URL, {
  max: 1,
});

// Set application name for easier debugging (fire-and-forget)
queryClient`SET application_name = 'nutrition-app-api'`.catch(() => { });

// Function to set current user for RLS (session-level)
export async function setCurrentUser(userId: string) {
  try {
    await executeRaw(
      `SELECT set_config('app.current_user_id', $1, false)`,
      [userId]
    );
  } catch (error) {
    // If the GUC isn't defined, continue silently (dev-friendly)
    console.log(`[DB] RLS user context not available: ${error}`);
  }
}

// Function to execute raw SQL (for functions/procedures)
export async function executeRaw(sql: string, params: any[] = []) {
  return queryClient.unsafe(sql, params);
}

// Health check function
export async function checkDatabaseHealth(): Promise<boolean> {
  try {
    await queryClient`SELECT 1`;
    return true;
  } catch (error) {
    console.error("Database health check failed:", error);
    return false;
  }
}

export default db;
