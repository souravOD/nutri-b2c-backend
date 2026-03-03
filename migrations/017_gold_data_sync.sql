-- Migration 017: Gold data sync
-- 1. Allergens: set is_top_9 for FDA Top-9
-- 2. Cuisines:  insert Middle Eastern, Greek
-- 3. Dietary:   insert LOW_CARB, LOW_FAT, HIGH_PROTEIN

BEGIN;

-- ───────────────────────────────────────────────────────────────────────
-- 1. FDA Top-9 allergens
-- ───────────────────────────────────────────────────────────────────────
UPDATE gold.allergens
   SET is_top_9 = true
 WHERE code IN (
   'Milk_dairy',
   'Egg',
   'Fish_finned',
   'Shellfish_crustaceans',
   'Tree_nuts',
   'Peanut',
   'Wheat_gluten_cereals',
   'Soy',
   'Sesame_seed'
 );

-- ───────────────────────────────────────────────────────────────────────
-- 2. Missing cuisines
-- ───────────────────────────────────────────────────────────────────────
INSERT INTO gold.cuisines (id, code, name, created_at)
VALUES
  (gen_random_uuid(), 'middle-eastern', 'Middle Eastern', now()),
  (gen_random_uuid(), 'greek',          'Greek',          now())
ON CONFLICT DO NOTHING;

-- ───────────────────────────────────────────────────────────────────────
-- 3. Missing dietary preferences
-- ───────────────────────────────────────────────────────────────────────
INSERT INTO gold.dietary_preferences
  (id, code, name, category, description, is_medical, created_at)
VALUES
  (gen_random_uuid(), 'LOW_CARB',     'Low Carb',     'WEIGHT_MANAGEMENT',
   'Reduced carbohydrate intake, typically under 100-150g/day for weight management and blood sugar control.',
   false, now()),
  (gen_random_uuid(), 'LOW_FAT',      'Low Fat',      'WEIGHT_MANAGEMENT',
   'Reduced fat intake, emphasizing lean proteins, fruits, vegetables, and complex carbohydrates.',
   false, now()),
  (gen_random_uuid(), 'HIGH_PROTEIN', 'High Protein', 'WEIGHT_MANAGEMENT',
   'Increased protein consumption (>25% of calories) for muscle building, satiety, and metabolic support.',
   false, now())
ON CONFLICT DO NOTHING;

COMMIT;
