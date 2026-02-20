-- Migration 011: Grocery list hardening for PRD-05
-- Adds audit/update semantics, data quality checks, and key indexes.

BEGIN;

-- 1) Add updated_at to shopping_list_items for real-time freshness semantics.
ALTER TABLE gold.shopping_list_items
  ADD COLUMN IF NOT EXISTS updated_at timestamp without time zone DEFAULT now() NOT NULL;

-- 2) Keep shopping_list_items.updated_at in sync on updates.
DROP TRIGGER IF EXISTS trigger_update_shopping_list_items_updated_at ON gold.shopping_list_items;
CREATE TRIGGER trigger_update_shopping_list_items_updated_at
  BEFORE UPDATE ON gold.shopping_list_items
  FOR EACH ROW EXECUTE FUNCTION gold.update_updated_at_column();

-- 3) Keep shopping_lists.updated_at in sync on updates.
DROP TRIGGER IF EXISTS trigger_update_shopping_lists_updated_at ON gold.shopping_lists;
CREATE TRIGGER trigger_update_shopping_lists_updated_at
  BEFORE UPDATE ON gold.shopping_lists
  FOR EACH ROW EXECUTE FUNCTION gold.update_updated_at_column();

-- 4) Data checks for quantity/price safety.
ALTER TABLE gold.shopping_list_items
  DROP CONSTRAINT IF EXISTS shopping_list_items_quantity_positive_check,
  DROP CONSTRAINT IF EXISTS shopping_list_items_estimated_price_nonnegative_check,
  DROP CONSTRAINT IF EXISTS shopping_list_items_actual_price_nonnegative_check;

ALTER TABLE gold.shopping_list_items
  ADD CONSTRAINT shopping_list_items_quantity_positive_check
    CHECK (quantity > 0),
  ADD CONSTRAINT shopping_list_items_estimated_price_nonnegative_check
    CHECK (estimated_price IS NULL OR estimated_price >= 0),
  ADD CONSTRAINT shopping_list_items_actual_price_nonnegative_check
    CHECK (actual_price IS NULL OR actual_price >= 0);

-- 5) Enforce one active list per meal plan.
CREATE UNIQUE INDEX IF NOT EXISTS uq_shopping_lists_active_per_meal_plan
  ON gold.shopping_lists (meal_plan_id)
  WHERE meal_plan_id IS NOT NULL AND status = 'active';

-- 6) Read/write path index for list rendering and check-off operations.
CREATE INDEX IF NOT EXISTS idx_shopping_list_items_list_purchased_category
  ON gold.shopping_list_items (shopping_list_id, is_purchased, category);

COMMIT;
