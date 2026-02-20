-- Migration 009: AI Meal Planner columns
-- Adds new columns to meal_plans and meal_plan_items for AI generation features
--
-- Run this against the same database as your app's DATABASE_URL (e.g. Supabase
-- SQL Editor or the Postgres instance used by the backend). Required for
-- POST /api/v1/meal-plans/generate to succeed.

BEGIN;

-- ── meal_plans: AI generation metadata ──────────────────────────────────────

ALTER TABLE gold.meal_plans
  ADD COLUMN IF NOT EXISTS meals_per_day text[] DEFAULT '{breakfast,lunch,dinner}',
  ADD COLUMN IF NOT EXISTS generation_params jsonb,
  ADD COLUMN IF NOT EXISTS ai_model varchar(100),
  ADD COLUMN IF NOT EXISTS budget_amount numeric(10,2),
  ADD COLUMN IF NOT EXISTS budget_currency varchar(3) DEFAULT 'USD',
  ADD COLUMN IF NOT EXISTS member_ids uuid[],
  ADD COLUMN IF NOT EXISTS generation_time_ms integer;

-- ── meal_plan_items: swap tracking + nutrition snapshot ─────────────────────

ALTER TABLE gold.meal_plan_items
  ADD COLUMN IF NOT EXISTS original_recipe_id uuid REFERENCES gold.recipes(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS swap_reason text,
  ADD COLUMN IF NOT EXISTS swap_count integer DEFAULT 0,
  ADD COLUMN IF NOT EXISTS nutrition_snapshot jsonb;

-- ── Indexes for new columns ────────────────────────────────────────────────

CREATE INDEX IF NOT EXISTS idx_meal_plans_member_ids
  ON gold.meal_plans USING gin (member_ids);

CREATE INDEX IF NOT EXISTS idx_meal_plan_items_original_recipe
  ON gold.meal_plan_items USING btree (original_recipe_id)
  WHERE original_recipe_id IS NOT NULL;

-- ── Trigger: auto-update updated_at on meal_plans ──────────────────────────
-- PostgreSQL does not support CREATE TRIGGER IF NOT EXISTS,
-- so we drop first then create.

DROP TRIGGER IF EXISTS trigger_update_meal_plans_updated_at ON gold.meal_plans;

CREATE TRIGGER trigger_update_meal_plans_updated_at
  BEFORE UPDATE ON gold.meal_plans
  FOR EACH ROW EXECUTE FUNCTION gold.update_updated_at_column();

COMMIT;
