-- 008_meal_logging_tables.sql
-- PRD-03: Meal Logging & Cooking Tracker
-- Creates meal_logs, meal_log_items, meal_log_streaks, meal_log_templates tables
-- in the gold schema with indexes, triggers, and constraints.

-- ============================================================================
-- 1. gold.meal_logs — Daily meal log container (one per user per date)
-- ============================================================================
CREATE TABLE gold.meal_logs (
    id uuid DEFAULT gen_random_uuid() NOT NULL PRIMARY KEY,
    b2c_customer_id uuid NOT NULL REFERENCES gold.b2c_customers(id),
    household_id uuid REFERENCES gold.households(id),
    log_date date NOT NULL,

    -- Daily aggregated nutrition (computed from items)
    total_calories integer DEFAULT 0,
    total_protein_g numeric(8,2) DEFAULT 0,
    total_carbs_g numeric(8,2) DEFAULT 0,
    total_fat_g numeric(8,2) DEFAULT 0,
    total_fiber_g numeric(8,2) DEFAULT 0,
    total_sugar_g numeric(8,2) DEFAULT 0,
    total_sodium_mg integer DEFAULT 0,

    -- Water tracking
    water_ml integer DEFAULT 0,
    water_goal_ml integer DEFAULT 2500,

    -- Goal tracking
    calorie_goal integer,
    goal_met boolean DEFAULT false,

    -- Streak
    streak_count integer DEFAULT 0,

    notes text,
    created_at timestamp without time zone DEFAULT now() NOT NULL,
    updated_at timestamp without time zone DEFAULT now() NOT NULL,

    CONSTRAINT meal_logs_unique UNIQUE (b2c_customer_id, log_date)
);

COMMENT ON TABLE gold.meal_logs IS 'Daily meal log container per B2C customer. One row per user per date with aggregated nutrition totals.';

CREATE INDEX idx_meal_logs_customer_date ON gold.meal_logs(b2c_customer_id, log_date DESC);
CREATE INDEX idx_meal_logs_household ON gold.meal_logs(household_id, log_date DESC);

CREATE TRIGGER update_meal_logs_updated_at
    BEFORE UPDATE ON gold.meal_logs
    FOR EACH ROW EXECUTE FUNCTION gold.update_updated_at_column();

-- ============================================================================
-- 2. gold.meal_log_items — Individual food items within a daily log
-- ============================================================================
CREATE TABLE gold.meal_log_items (
    id uuid DEFAULT gen_random_uuid() NOT NULL PRIMARY KEY,
    meal_log_id uuid NOT NULL REFERENCES gold.meal_logs(id) ON DELETE CASCADE,

    -- Meal slot
    meal_type varchar(20) NOT NULL,

    -- Source reference (one of these should be set)
    recipe_id uuid REFERENCES gold.recipes(id),
    product_id uuid REFERENCES gold.products(id),

    -- For custom/manual entries
    custom_name varchar(500),
    custom_brand varchar(255),

    -- Quantity
    servings numeric(6,2) DEFAULT 1 NOT NULL,
    serving_size varchar(100),
    serving_size_g numeric(10,2),

    -- Nutrition per logged amount (servings * per_serving)
    calories integer,
    protein_g numeric(8,2),
    carbs_g numeric(8,2),
    fat_g numeric(8,2),
    fiber_g numeric(8,2),
    sugar_g numeric(8,2),
    sodium_mg integer,
    saturated_fat_g numeric(6,2),

    -- Cooking integration
    cooked_via_app boolean DEFAULT false,
    cooking_started_at timestamp without time zone,
    cooking_finished_at timestamp without time zone,

    -- Future meal plan integration
    meal_plan_item_id uuid REFERENCES gold.meal_plan_items(id),

    -- Metadata
    logged_at timestamp without time zone DEFAULT now() NOT NULL,
    source varchar(20) DEFAULT 'manual',
    notes text,
    image_url varchar(1000),

    CONSTRAINT meal_log_items_meal_type_check CHECK (
        meal_type IN ('breakfast', 'lunch', 'dinner', 'snack')
    ),
    CONSTRAINT meal_log_items_source_check CHECK (
        source IN ('manual', 'recipe', 'scan', 'quick_add', 'copy', 'cooking_mode')
    )
);

COMMENT ON TABLE gold.meal_log_items IS 'Individual food items logged within a daily meal log. Supports recipes, scanned products, and manual entries.';

CREATE INDEX idx_meal_log_items_log ON gold.meal_log_items(meal_log_id);
CREATE INDEX idx_meal_log_items_meal_type ON gold.meal_log_items(meal_log_id, meal_type);
CREATE INDEX idx_meal_log_items_recipe ON gold.meal_log_items(recipe_id) WHERE recipe_id IS NOT NULL;
CREATE INDEX idx_meal_log_items_product ON gold.meal_log_items(product_id) WHERE product_id IS NOT NULL;

-- ============================================================================
-- 3. gold.meal_log_streaks — Per-user streak tracking
-- ============================================================================
CREATE TABLE gold.meal_log_streaks (
    id uuid DEFAULT gen_random_uuid() NOT NULL PRIMARY KEY,
    b2c_customer_id uuid NOT NULL REFERENCES gold.b2c_customers(id),
    current_streak integer DEFAULT 0,
    longest_streak integer DEFAULT 0,
    last_logged_date date,
    total_days_logged integer DEFAULT 0,
    updated_at timestamp without time zone DEFAULT now() NOT NULL,

    CONSTRAINT meal_log_streaks_unique UNIQUE (b2c_customer_id)
);

COMMENT ON TABLE gold.meal_log_streaks IS 'Tracks consecutive-day meal logging streaks per B2C customer.';

-- ============================================================================
-- 4. gold.meal_log_templates — Quick-add meal templates
-- ============================================================================
CREATE TABLE gold.meal_log_templates (
    id uuid DEFAULT gen_random_uuid() NOT NULL PRIMARY KEY,
    b2c_customer_id uuid NOT NULL REFERENCES gold.b2c_customers(id),
    template_name varchar(255) NOT NULL,
    meal_type varchar(20),
    items jsonb NOT NULL,
    use_count integer DEFAULT 0,
    created_at timestamp without time zone DEFAULT now() NOT NULL,

    CONSTRAINT meal_log_templates_meal_type_check CHECK (
        meal_type IS NULL OR meal_type IN ('breakfast', 'lunch', 'dinner', 'snack')
    )
);

COMMENT ON TABLE gold.meal_log_templates IS 'User-created meal templates for quick-add functionality. Items stored as JSONB array.';

CREATE INDEX idx_meal_log_templates_customer ON gold.meal_log_templates(b2c_customer_id);
