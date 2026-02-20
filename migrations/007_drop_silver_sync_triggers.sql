-- 007_drop_silver_sync_triggers.sql
-- Drop all Silver↔Gold sync triggers and their ops-schema functions.
-- The backend now writes directly to Gold tables; these triggers are no longer needed.

-- ============================================================================
-- 1. Drop Silver → Gold sync triggers (documented in data/silver.sql)
-- ============================================================================
DROP TRIGGER IF EXISTS tr_sync_b2c_customers_to_gold ON silver.b2c_customers;
DROP TRIGGER IF EXISTS tr_sync_b2c_health_profiles_to_gold ON silver.b2c_customer_health_profiles;

-- ============================================================================
-- 2. Drop Silver derive triggers (no code writes to Silver anymore)
-- ============================================================================
DROP TRIGGER IF EXISTS tr_derive_b2c_customers ON silver.b2c_customers;
DROP TRIGGER IF EXISTS tr_derive_b2c_health_profiles ON silver.b2c_customer_health_profiles;

-- ============================================================================
-- 3. Drop Gold → Silver sync triggers (may exist in live DB but not in dumps)
--    Using common naming conventions for any reverse-direction triggers.
-- ============================================================================
DROP TRIGGER IF EXISTS tr_sync_b2c_customers_to_silver ON gold.b2c_customers;
DROP TRIGGER IF EXISTS tr_sync_gold_b2c_customers_to_silver ON gold.b2c_customers;
DROP TRIGGER IF EXISTS tr_sync_b2c_health_profiles_to_silver ON gold.b2c_customer_health_profiles;
DROP TRIGGER IF EXISTS tr_sync_gold_b2c_health_profiles_to_silver ON gold.b2c_customer_health_profiles;

-- ============================================================================
-- 4. Drop ops-schema sync functions (CASCADE handles any remaining refs)
-- ============================================================================
DROP FUNCTION IF EXISTS ops.trg_sync_silver_b2c_customers_to_gold() CASCADE;
DROP FUNCTION IF EXISTS ops.trg_sync_silver_b2c_health_profiles_to_gold() CASCADE;
DROP FUNCTION IF EXISTS ops.trg_sync_gold_b2c_customers_to_silver() CASCADE;
DROP FUNCTION IF EXISTS ops.trg_sync_gold_b2c_health_profiles_to_silver() CASCADE;

-- ============================================================================
-- 5. Drop Silver derive functions (no longer used)
-- ============================================================================
DROP FUNCTION IF EXISTS silver.trg_b2c_customers_derive() CASCADE;
DROP FUNCTION IF EXISTS silver.trg_b2c_health_profiles_derive() CASCADE;

-- ============================================================================
-- NOTE: The following Gold-internal triggers are intentionally KEPT:
--   trigger_b2c_compute_bmi          → gold.compute_b2c_bmi()
--   trigger_update_b2c_customers_updated_at → gold.update_updated_at_column()
-- ============================================================================
