-- Migration 010: Backfill recipe source_type and enforce default
--
-- Why:
-- Meal planner filters eligible recipes by source_type. Historical rows may
-- have NULL source_type, which makes the planner think no recipes exist.

BEGIN;

UPDATE gold.recipes
SET source_type = 'curated'
WHERE source_type IS NULL;

ALTER TABLE gold.recipes
  ALTER COLUMN source_type SET DEFAULT 'curated';

COMMIT;

