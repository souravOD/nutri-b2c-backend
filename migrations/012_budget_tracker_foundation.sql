-- Migration 012: Budget tracker foundation for PRD-06
-- Adds household timezone support, purchased_at semantics, and budget hardening.

BEGIN;

-- 1) Household timezone for calendar boundary calculations.
ALTER TABLE gold.households
  ADD COLUMN IF NOT EXISTS timezone varchar(64) NOT NULL DEFAULT 'UTC';

ALTER TABLE gold.households
  DROP CONSTRAINT IF EXISTS households_timezone_nonempty_check;

ALTER TABLE gold.households
  ADD CONSTRAINT households_timezone_nonempty_check
    CHECK (length(trim(timezone)) > 0);

UPDATE gold.households
SET timezone = 'UTC'
WHERE timezone IS NULL OR length(trim(timezone)) = 0;

-- 2) Track exact purchase timestamp for spend attribution.
ALTER TABLE gold.shopping_list_items
  ADD COLUMN IF NOT EXISTS purchased_at timestamp without time zone;

UPDATE gold.shopping_list_items
SET purchased_at = COALESCE(updated_at, created_at)
WHERE is_purchased = true
  AND purchased_at IS NULL;

CREATE OR REPLACE FUNCTION gold.sync_shopping_list_item_purchase_state()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.is_purchased IS TRUE AND NEW.purchased_at IS NULL THEN
      NEW.purchased_at = NOW();
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.is_purchased IS TRUE AND COALESCE(OLD.is_purchased, FALSE) IS FALSE THEN
    NEW.purchased_at = COALESCE(NEW.purchased_at, NOW());
  ELSIF NEW.is_purchased IS FALSE AND COALESCE(OLD.is_purchased, FALSE) IS TRUE THEN
    NEW.purchased_at = NULL;
  ELSIF NEW.is_purchased IS TRUE AND NEW.purchased_at IS NULL THEN
    NEW.purchased_at = NOW();
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trigger_sync_shopping_list_item_purchase_state ON gold.shopping_list_items;
CREATE TRIGGER trigger_sync_shopping_list_item_purchase_state
  BEFORE INSERT OR UPDATE ON gold.shopping_list_items
  FOR EACH ROW EXECUTE FUNCTION gold.sync_shopping_list_item_purchase_state();

CREATE INDEX IF NOT EXISTS idx_shopping_list_items_purchased_at_spend
  ON gold.shopping_list_items (purchased_at, shopping_list_id)
  WHERE is_purchased = true AND actual_price IS NOT NULL;

-- 3) Budget table hardening for active-budget semantics and update auditability.
ALTER TABLE gold.household_budgets
  ADD COLUMN IF NOT EXISTS updated_at timestamp without time zone DEFAULT now() NOT NULL;

UPDATE gold.household_budgets
SET updated_at = created_at
WHERE updated_at IS NULL;

DROP TRIGGER IF EXISTS trigger_update_household_budgets_updated_at ON gold.household_budgets;
CREATE TRIGGER trigger_update_household_budgets_updated_at
  BEFORE UPDATE ON gold.household_budgets
  FOR EACH ROW EXECUTE FUNCTION gold.update_updated_at_column();

ALTER TABLE gold.household_budgets
  DROP CONSTRAINT IF EXISTS household_budgets_date_range_check;

ALTER TABLE gold.household_budgets
  ADD CONSTRAINT household_budgets_date_range_check
    CHECK (start_date IS NULL OR end_date IS NULL OR start_date <= end_date);

CREATE UNIQUE INDEX IF NOT EXISTS uq_household_budgets_active_household_type_period
  ON gold.household_budgets (household_id, budget_type, period)
  WHERE is_active = true;

COMMIT;
