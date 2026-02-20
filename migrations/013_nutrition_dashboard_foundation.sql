-- Migration 013: Nutrition dashboard foundation for PRD-07
-- Adds weight history tracking and per-item nutrient snapshots.

BEGIN;

-- 1) Weight history tracking per member
CREATE TABLE IF NOT EXISTS gold.b2c_customer_weight_history (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  b2c_customer_id uuid NOT NULL,
  weight_kg numeric(5,2) NOT NULL,
  recorded_at timestamp without time zone NOT NULL DEFAULT now(),
  source varchar(30) NOT NULL DEFAULT 'profile_update',
  notes text,
  created_at timestamp without time zone NOT NULL DEFAULT now(),
  CONSTRAINT b2c_customer_weight_history_weight_kg_check CHECK (weight_kg > 0 AND weight_kg <= 500),
  CONSTRAINT b2c_customer_weight_history_source_check CHECK (
    source IN ('profile_update', 'manual_entry', 'sync', 'backfill', 'system')
  )
);

ALTER TABLE gold.b2c_customer_weight_history
  DROP CONSTRAINT IF EXISTS b2c_customer_weight_history_b2c_customer_id_fkey;

ALTER TABLE gold.b2c_customer_weight_history
  ADD CONSTRAINT b2c_customer_weight_history_b2c_customer_id_fkey
  FOREIGN KEY (b2c_customer_id)
  REFERENCES gold.b2c_customers(id)
  ON DELETE CASCADE;

CREATE INDEX IF NOT EXISTS idx_b2c_customer_weight_history_member_date
  ON gold.b2c_customer_weight_history (b2c_customer_id, recorded_at DESC);

CREATE OR REPLACE FUNCTION gold.capture_b2c_weight_history()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.weight_kg IS NOT NULL THEN
      INSERT INTO gold.b2c_customer_weight_history (
        b2c_customer_id,
        weight_kg,
        recorded_at,
        source,
        notes
      ) VALUES (
        NEW.b2c_customer_id,
        NEW.weight_kg,
        NOW(),
        'profile_update',
        NULL
      );
    END IF;

    RETURN NEW;
  END IF;

  IF TG_OP = 'UPDATE' THEN
    IF NEW.weight_kg IS NOT NULL AND NEW.weight_kg IS DISTINCT FROM OLD.weight_kg THEN
      INSERT INTO gold.b2c_customer_weight_history (
        b2c_customer_id,
        weight_kg,
        recorded_at,
        source,
        notes
      ) VALUES (
        NEW.b2c_customer_id,
        NEW.weight_kg,
        NOW(),
        'profile_update',
        NULL
      );
    END IF;

    RETURN NEW;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trigger_capture_b2c_weight_history ON gold.b2c_customer_health_profiles;
CREATE TRIGGER trigger_capture_b2c_weight_history
  AFTER INSERT OR UPDATE ON gold.b2c_customer_health_profiles
  FOR EACH ROW EXECUTE FUNCTION gold.capture_b2c_weight_history();

-- Seed existing profile weights once.
INSERT INTO gold.b2c_customer_weight_history (
  b2c_customer_id,
  weight_kg,
  recorded_at,
  source,
  notes
)
SELECT
  hp.b2c_customer_id,
  hp.weight_kg,
  COALESCE(hp.updated_at, hp.created_at, NOW()),
  'backfill',
  'Initial backfill from health profile'
FROM gold.b2c_customer_health_profiles hp
WHERE hp.weight_kg IS NOT NULL
  AND NOT EXISTS (
    SELECT 1
    FROM gold.b2c_customer_weight_history wh
    WHERE wh.b2c_customer_id = hp.b2c_customer_id
  );

-- 2) Per-meal-log-item nutrient snapshots for dashboard analytics
CREATE TABLE IF NOT EXISTS gold.meal_log_item_nutrients (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  meal_log_item_id uuid NOT NULL,
  nutrient_id uuid NOT NULL,
  amount numeric(12,4) NOT NULL,
  unit varchar(20) NOT NULL,
  source varchar(30) NOT NULL DEFAULT 'derived',
  created_at timestamp without time zone NOT NULL DEFAULT now(),
  CONSTRAINT meal_log_item_nutrients_amount_nonnegative_check CHECK (amount >= 0),
  CONSTRAINT meal_log_item_nutrients_source_check CHECK (
    source IN ('derived', 'manual_entry', 'recipe_profile', 'product_profile', 'backfill')
  )
);

ALTER TABLE gold.meal_log_item_nutrients
  DROP CONSTRAINT IF EXISTS meal_log_item_nutrients_meal_log_item_id_fkey;

ALTER TABLE gold.meal_log_item_nutrients
  ADD CONSTRAINT meal_log_item_nutrients_meal_log_item_id_fkey
  FOREIGN KEY (meal_log_item_id)
  REFERENCES gold.meal_log_items(id)
  ON DELETE CASCADE;

ALTER TABLE gold.meal_log_item_nutrients
  DROP CONSTRAINT IF EXISTS meal_log_item_nutrients_nutrient_id_fkey;

ALTER TABLE gold.meal_log_item_nutrients
  ADD CONSTRAINT meal_log_item_nutrients_nutrient_id_fkey
  FOREIGN KEY (nutrient_id)
  REFERENCES gold.nutrition_definitions(id)
  ON DELETE RESTRICT;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'meal_log_item_nutrients_unique'
      AND conrelid = 'gold.meal_log_item_nutrients'::regclass
  ) THEN
    ALTER TABLE gold.meal_log_item_nutrients
      ADD CONSTRAINT meal_log_item_nutrients_unique UNIQUE (meal_log_item_id, nutrient_id);
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_meal_log_item_nutrients_item
  ON gold.meal_log_item_nutrients (meal_log_item_id);

CREATE INDEX IF NOT EXISTS idx_meal_log_item_nutrients_nutrient
  ON gold.meal_log_item_nutrients (nutrient_id);

CREATE INDEX IF NOT EXISTS idx_meal_log_item_nutrients_item_nutrient
  ON gold.meal_log_item_nutrients (meal_log_item_id, nutrient_id);

COMMIT;
