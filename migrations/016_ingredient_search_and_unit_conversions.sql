-- Migration: pg_trgm extension, ingredient search index, and unit_conversions table
-- This migration adds:
--  1. pg_trgm extension for fuzzy text search
--  2. GIN trigram index on gold.ingredients.name for fast ingredient search
--  3. gold.unit_conversions table for unit-to-gram conversion factors

-- ─── 1. Trigram extension + index ─────────────────────────────────────────────

CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE INDEX IF NOT EXISTS idx_ingredients_name_trgm
  ON gold.ingredients USING GIN (name gin_trgm_ops);

-- ─── 2. Unit conversions table ──────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS gold.unit_conversions (
    id uuid DEFAULT gen_random_uuid() NOT NULL PRIMARY KEY,
    from_unit character varying(50) NOT NULL,
    to_unit character varying(50) DEFAULT 'g'::character varying NOT NULL,
    factor numeric(12,4) NOT NULL,
    ingredient_id uuid,
    unit_category character varying(30) NOT NULL,
    aliases text[] DEFAULT '{}',
    system character varying(10) DEFAULT 'us'::character varying,
    is_approximate boolean DEFAULT false,
    source character varying(100),
    created_at timestamp without time zone DEFAULT now() NOT NULL,
    updated_at timestamp without time zone DEFAULT now() NOT NULL,

    CONSTRAINT unit_conversions_factor_positive CHECK (factor > 0),
    CONSTRAINT unit_conversions_category_check CHECK (
        (unit_category)::text = ANY (ARRAY['weight', 'volume', 'count', 'cooking', 'package'])
    ),
    CONSTRAINT unit_conversions_system_check CHECK (
        (system)::text = ANY (ARRAY['us', 'metric', 'universal'])
    )
);

COMMENT ON TABLE gold.unit_conversions IS
  'Unit-to-gram conversion factors. Universal rows (ingredient_id IS NULL) provide defaults. '
  'Ingredient-specific rows override universal ones for density-dependent conversions.';

CREATE INDEX IF NOT EXISTS idx_unit_conversions_from_unit
  ON gold.unit_conversions (lower(from_unit));

CREATE UNIQUE INDEX IF NOT EXISTS idx_unit_conversions_unique
  ON gold.unit_conversions (lower(from_unit), COALESCE(ingredient_id, '00000000-0000-0000-0000-000000000000'::uuid));

-- ─── 3. Seed data: Standard weight conversions ─────────────────────────────

INSERT INTO gold.unit_conversions (from_unit, to_unit, factor, unit_category, system, aliases, is_approximate) VALUES
  ('g',    'g', 1,        'weight', 'universal', ARRAY['gram','grams','gm'], false),
  ('kg',   'g', 1000,     'weight', 'metric',    ARRAY['kilogram','kilograms','kgs'], false),
  ('mg',   'g', 0.001,    'weight', 'metric',    ARRAY['milligram','milligrams'], false),
  ('lb',   'g', 453.5924, 'weight', 'us',        ARRAY['pound','pounds','lbs'], false),
  ('oz',   'g', 28.3495,  'weight', 'us',        ARRAY['ounce','ounces'], false)
ON CONFLICT DO NOTHING;

-- ─── 4. Seed data: Standard volume conversions ─────────────────────────────

INSERT INTO gold.unit_conversions (from_unit, to_unit, factor, unit_category, system, aliases, is_approximate) VALUES
  ('ml',     'ml', 1,        'volume', 'metric',    ARRAY['milliliter','milliliters','mL'], false),
  ('l',      'ml', 1000,     'volume', 'metric',    ARRAY['liter','liters','litre','litres','L'], false),
  ('dl',     'ml', 100,      'volume', 'metric',    ARRAY['deciliter','deciliters'], false),
  ('cup',    'ml', 236.588,  'volume', 'us',        ARRAY['cups','c'], false),
  ('tbsp',   'ml', 14.787,   'volume', 'us',        ARRAY['tablespoon','tablespoons','T','Tbsp'], false),
  ('tsp',    'ml', 4.929,    'volume', 'us',        ARRAY['teaspoon','teaspoons','t'], false),
  ('fl_oz',  'ml', 29.5735,  'volume', 'us',        ARRAY['fluid ounce','fluid ounces','fl oz'], false),
  ('pint',   'ml', 473.176,  'volume', 'us',        ARRAY['pints','pt'], false),
  ('quart',  'ml', 946.353,  'volume', 'us',        ARRAY['quarts','qt'], false),
  ('gallon', 'ml', 3785.41,  'volume', 'us',        ARRAY['gallons','gal'], false)
ON CONFLICT DO NOTHING;

-- ─── 5. Seed data: Count/piece conversions ─────────────────────────────────

INSERT INTO gold.unit_conversions (from_unit, to_unit, factor, unit_category, system, aliases, is_approximate) VALUES
  ('each',  'g', 1,   'count',   'universal', ARRAY['ea','whole','piece','pieces','pc','pcs'], true),
  ('dozen', 'g', 12,  'count',   'universal', ARRAY['doz'], true),
  ('clove', 'g', 3,   'count',   'universal', ARRAY['cloves'], true),
  ('slice', 'g', 30,  'count',   'universal', ARRAY['slices'], true),
  ('bunch', 'g', 150, 'count',   'universal', ARRAY['bunches'], true),
  ('sprig', 'g', 2,   'count',   'universal', ARRAY['sprigs'], true),
  ('pinch', 'g', 0.5, 'cooking', 'universal', ARRAY['pinches'], true),
  ('dash',  'g', 0.5, 'cooking', 'universal', ARRAY['dashes'], true),
  ('stick', 'g', 113, 'cooking', 'us',        ARRAY['sticks'], false),
  ('can',   'g', 400, 'package', 'universal', ARRAY['cans','tin','tins'], true)
ON CONFLICT DO NOTHING;
