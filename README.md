# Nutri B2C Backend

Backend API for Nutri B2C, focused on personalized nutrition workflows using Appwrite-authenticated users and a Gold-schema Postgres data model.

## Current Scope

- Gold-schema-first backend for B2C customers, household members, recipes, products, meal logs, meal plans, ratings, and taxonomy data.
- Appwrite JWT authentication with request-level resolution of `b2cCustomerId`.
- LLM-powered recipe analyzer and AI-assisted meal planner flows.
- Barcode/product scanning with OpenFoodFacts fallback and scan history.
- Profile and health sync flows between Appwrite and Gold tables.

## Major Features

- Recipe search, detail, save, history, and rating.
- Personalized feed and recommendation retrieval.
- Recipe analyzer via text, URL, image, barcode, and save-to-user-recipe.
- Meal Log: daily entries, item CRUD, hydration, streaks, templates, and cooking-mode logging.
- Meal Plan: generate, activate, swap meal, regenerate, delete, and log to meal log.
- Household member management and member-specific health targets.
- Taxonomy lookups for allergens, conditions, dietary preferences, and cuisines.

## API Route Groups

Base path: `/api/v1`

- `/recipes`
  - search/list, popular, detail
  - save toggle, report placeholder
  - rating submit/read
- `/feed`
  - personalized feed
  - recommendations
- `/user`
  - profile and health read/update/delete
  - saved and history
  - user recipe CRUD helpers
  - account deletion
- `/user-recipes`
  - dedicated authenticated user recipe CRUD
- `/sync`
  - authenticated profile and health sync from Appwrite-facing clients
- `/taxonomy`
  - allergens, health conditions, dietary preferences, cuisines
- `/scan`
  - lookup by barcode, write/read scan history
- `/analyzer`
  - analyze text/url/image/barcode, save analyzed recipe
- `/meal-log`
  - daily log, item CRUD, water, copy-day, history, streak, templates, from-cooking
- `/meal-plans`
  - generate/list/detail/activate/swap/regenerate/delete/log-meal
- `/households`
  - household members list/add/read/update + member health update
- `/admin`
  - curated recipe operations and audit/dashboard endpoints

Health endpoints (non-versioned):

- `/healthz`
- `/readyz`

## Data Model Direction

This backend now targets Gold schema tables directly for B2C flows. Silver<->Gold sync trigger dependencies are being removed through migrations.

## Required Migrations

Apply these against the same database referenced by `DATABASE_URL`:

- `migrations/007_drop_silver_sync_triggers.sql`
- `migrations/008_meal_logging_tables.sql`
- `migrations/009_meal_plan_ai_columns.sql`
- `migrations/010_recipe_source_type_backfill.sql`

Important:

- `009` is required for AI meal planner columns.
- `010` is required so planner catalog logic does not miss recipes with null `source_type`.

## Environment Notes

Use `.env.example` as the template for local setup. Keep real secrets in `.env.local` (or deployment secret manager), never in source control.

Key groups:

- Runtime: `NODE_ENV`, `PORT`, `HOST`, `TRUST_PROXY`
- DB: `DATABASE_URL` (optional `DATABASE_REPLICA_URL`)
- Appwrite: endpoint/project/api key/db and collection IDs
- Rate limits and idempotency tuning
- LLM config: LiteLLM base URL, API keys, model names, planner timeout/cooldown knobs

## Local Run

1. Install dependencies.
2. Configure environment variables.
3. Apply required migrations.
4. Start API in dev mode.

Typical npm scripts in this repo:

- `npm run dev`
- `npm run build`
- `npm run start`

## Operational Notes

- Server keep-alive and header timeout are tuned to behave better behind reverse proxies.
- Error handler includes a specific response for schema-out-of-date situations (for missing columns after partial migration).
- Idempotency middleware currently uses an in-memory TTL store.
- Some legacy moderation/report endpoints are intentionally `501` under current Gold-schema implementation.

## Testing and Validation

Before merge/release, validate:

- Authenticated routes correctly resolve `b2cCustomerId`.
- Analyzer, scan, meal log, meal plan, household, and taxonomy flows.
- Migration-dependent endpoints after applying 007-010.
- Profile/health sync and Appwrite write-back paths.

## License

Use project default license policy.
