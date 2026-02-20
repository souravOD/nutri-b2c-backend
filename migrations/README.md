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
