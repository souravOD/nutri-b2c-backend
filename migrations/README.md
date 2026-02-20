# Database migrations

Run these SQL files **against the same database as your app's `DATABASE_URL`** (e.g. Supabase SQL Editor, or the Postgres instance used by the backend in Docker).

## Required for AI Meal Planner (PRD-04)

- **`009_meal_plan_ai_columns.sql`** — Adds columns to `gold.meal_plans` and `gold.meal_plan_items` (e.g. `meals_per_day`, `generation_params`, `nutrition_snapshot`).  
  **If this migration is not applied**, `GET /api/v1/meal-plans`, `POST /api/v1/meal-plans/generate`, and related endpoints will fail with a schema error (e.g. "column meals_per_day does not exist").
- **`010_recipe_source_type_backfill.sql`** — Backfills `gold.recipes.source_type` from `NULL` to `'curated'` and sets default to `'curated'`.  
  **If this migration is not applied**, meal planner catalog filtering may return zero recipes even when recipes exist.

### How to run (Supabase)

1. Open your Supabase project → **SQL Editor**.
2. Paste the contents of `009_meal_plan_ai_columns.sql`.
3. Run the script.

### How to run (local Postgres / psql)

```bash
psql "$DATABASE_URL" -f nutrition-backend-b2c/migrations/009_meal_plan_ai_columns.sql
```

After running the migration, restart the backend if it is already running.

## Required for Smart Grocery List (PRD-05)

- **`011_grocery_list_hardening.sql`** — Adds `updated_at` support, list/item constraints, active-list uniqueness per meal plan, and performance indexes for grocery list reads and updates.

## Required for Budget Tracker (PRD-06)

- **`012_budget_tracker_foundation.sql`** — Adds household timezone support, purchase timestamp semantics (`shopping_list_items.purchased_at`), and budget-table hardening (`updated_at`, date-range check, and active budget uniqueness).

## Required for Nutrition Dashboard (PRD-07)

- **`013_nutrition_dashboard_foundation.sql`** - Adds weight history tracking (`b2c_customer_weight_history` + profile trigger + initial backfill) and per-item nutrient snapshots (`meal_log_item_nutrients`) used by dashboard analytics.
