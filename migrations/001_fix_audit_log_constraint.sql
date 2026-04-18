-- 001_fix_audit_log_constraint.sql
-- Removes the restrictive CHECK constraint that blocks non-CRUD audit events
-- (e.g. "soft_delete_account", "recover_account") from being logged.

ALTER TABLE gold.audit_log DROP CONSTRAINT IF EXISTS audit_log_action_check;
ALTER TABLE gold.audit_log ALTER COLUMN action TYPE varchar(100);

-- Also add the deletion_scheduled_at column for soft-delete
ALTER TABLE gold.b2c_customers ADD COLUMN IF NOT EXISTS deletion_scheduled_at TIMESTAMPTZ;
