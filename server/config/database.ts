import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as baseSchema from "../../shared/schema.js";
import * as goldSchema from "../../shared/goldSchema.js";
import { env } from "./env.js";

if (!env.DATABASE_URL) {
  throw new Error("DATABASE_URL environment variable is required");
}

// =============================================================================
// ENTERPRISE DATABASE CONFIGURATION
// =============================================================================

// Primary database connection (writes)
export const queryClient = postgres(env.DATABASE_URL, {
  max: 20,
  idle_timeout: 30000,
  connect_timeout: 10000,
  transform: {
    undefined: null,
  },
});

// Read replica connection (optional - falls back to primary if not configured)
const replicaUrl = process.env.DATABASE_REPLICA_URL || env.DATABASE_URL;
export const replicaClient = postgres(replicaUrl, {
  max: 30,
  idle_timeout: 30000,
  connect_timeout: 10000,
  transform: {
    undefined: null,
  },
});

const schema = { ...baseSchema, ...goldSchema };

// Drizzle instances
export const db = drizzle(queryClient, { schema });
export const dbRead = drizzle(replicaClient, { schema });

// Connection for migrations
export const migrationClient = postgres(env.DATABASE_URL, {
  max: 1,
});

// Set application name for easier debugging
queryClient`SET application_name = 'nutrition-app-api'`;

// Function to set current user for RLS
export async function setCurrentUser(userId: string) {
  // Prefer set_config to avoid "SET LOCAL" warnings when not in transaction
  try {
    await executeRaw(
      `SELECT set_config('app.current_user_id', $1, true)`,
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

// Route queries to appropriate database
export function getDbConnection(operation: 'read' | 'write', path?: string): typeof db {
  // Heavy read operations go to replica
  const replicaRoutes = ['/api/v1/search', '/api/v1/analytics', '/api/v1/reports', '/api/v1/matches'];
  
  if (operation === 'read' && replicaRoutes.some(route => path?.startsWith(route))) {
    return dbRead;
  }
  
  return db; // Primary for writes and non-heavy reads
}

// Check replica lag
export async function checkReplicationLag(): Promise<number> {
  try {
    const result = await replicaClient`
      SELECT CASE 
        WHEN pg_is_in_recovery() THEN 
          EXTRACT(EPOCH FROM (now() - pg_last_xact_replay_timestamp()))
        ELSE 0 
      END as lag_seconds
    `;
    return Number(result[0]?.lag_seconds) || 0;
  } catch (error) {
    console.warn('Replica lag check failed:', error);
    return 0;
  }
}

// Enterprise partition management
export async function createVendorPartitions(vendorId: string): Promise<void> {
  const vendorUuid = vendorId.replace(/-/g, '');
  
  try {
    // Create products partitions (16 hash sub-partitions)
    await executeRaw(`
      CREATE TABLE IF NOT EXISTS products_vendor_${vendorUuid} 
      PARTITION OF products 
      FOR VALUES IN ('${vendorId}') 
      PARTITION BY HASH (id)
    `);
    
    for (let i = 0; i < 16; i++) {
      await executeRaw(`
        CREATE TABLE IF NOT EXISTS products_vendor_${vendorUuid}_${i} 
        PARTITION OF products_vendor_${vendorUuid} 
        FOR VALUES WITH (modulus 16, remainder ${i})
      `);
    }
    
    // Create customers partitions (32 hash sub-partitions)
    await executeRaw(`
      CREATE TABLE IF NOT EXISTS customers_vendor_${vendorUuid} 
      PARTITION OF customers 
      FOR VALUES IN ('${vendorId}') 
      PARTITION BY HASH (id)
    `);
    
    for (let i = 0; i < 32; i++) {
      await executeRaw(`
        CREATE TABLE IF NOT EXISTS customers_vendor_${vendorUuid}_${i} 
        PARTITION OF customers_vendor_${vendorUuid} 
        FOR VALUES WITH (modulus 32, remainder ${i})
      `);
    }
    
    console.log(`Created partitions for vendor ${vendorId}`);
  } catch (error) {
    console.error(`Failed to create partitions for vendor ${vendorId}:`, error);
    throw error;
  }
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

// Enterprise audit logging
export async function auditHealthDataAccess(
  vendorId: string,
  actorUserId: string,
  action: string,
  entityId: string,
  before?: any,
  after?: any,
  justification?: string,
  req?: any
): Promise<void> {
  try {
    await db.insert(schema.enterpriseAuditLog).values({
      vendorId,
      actorUserId,
      actorRole: req?.user?.role || 'unknown',
      actorEmail: req?.user?.email || 'unknown',
      action,
      entity: 'customer_health_profile',
      entityId,
      before: before ? JSON.stringify(before) : null,
      after: after ? JSON.stringify(after) : null,
      businessJustification: justification,
      ip: req?.ip,
      userAgent: req?.headers?.['user-agent'],
      apiEndpoint: req?.originalUrl,
      requestId: req?.headers?.['x-request-id'],
      hipaaCategory: 'technical',
      riskLevel: action.includes('DELETE') ? 'high' : 'medium',
    });
  } catch (error) {
    console.error('Audit logging failed:', error);
    // Don't throw - audit failures shouldn't break the main operation
  }
}

export default db;
