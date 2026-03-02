# Nutri B2C Backend

Backend API for Nutri B2C, focused on personalized nutrition workflows using Appwrite-authenticated users and a Gold-schema Postgres data model.

## Quick Start

```bash
# 1. Install dependencies
npm install

# 2. Configure environment
cp .env.example .env.local
# Edit .env.local with your actual credentials

# 3. Apply required migrations (against DATABASE_URL)
# See migrations/ folder — apply in order: 007 → 015

# 4. Start dev server
npm run dev

# 5. Run tests
npm test
```

## Environment Setup

Use `.env.example` as the template. Copy to `.env.local` and fill in real values — **never commit secrets**.

Key variable groups:

| Group | Variables |
|-------|-----------|
| **Runtime** | `NODE_ENV`, `PORT`, `HOST`, `TRUST_PROXY` |
| **Database** | `DATABASE_URL`, `DATABASE_REPLICA_URL` (optional) |
| **Supabase** | `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` |
| **Appwrite** | `APPWRITE_ENDPOINT`, `APPWRITE_PROJECT_ID`, `APPWRITE_API_KEY`, `ADMINS_TEAM_ID`, collection IDs |
| **CORS** | `WEB_ORIGINS`, `CORS_ALLOW_ALL` |
| **Rate Limit** | `RATE_LIMITS_READ_RPM`, `RATE_LIMITS_WRITE_RPM` |
| **LLM** | `LITELLM_BASE_URL`, `LITELLM_API_KEY`, `LITELLM_API_KEY_VISION`, `LLM_MODEL`, `LLM_VISION_MODEL` |
| **Meal Planner** | `MEAL_PLAN_LLM_MODEL`, `MEAL_PLAN_MAX_RECIPES`, timeout/cooldown knobs |
| **RAG** | `RAG_API_URL`, `RAG_API_KEY` (optional) |
| **Graph Flags** | `USE_GRAPH_SEARCH`, `USE_GRAPH_FEED`, `USE_GRAPH_MEAL_PLAN`, etc. |

## Docker

The backend is part of the root `docker-compose.yml` stack. Secrets are loaded from the root `.env` file (not committed).

```bash
# From project root (B2C/)
docker compose up -d --build backend
```

## API Route Groups

Base path: `/api/v1`

- `/recipes` — search, popular, detail, save, rating
- `/feed` — personalized feed, recommendations
- `/user` — profile, health, saved, history, account deletion
- `/user-recipes` — authenticated user recipe CRUD
- `/sync` — profile/health sync from Appwrite clients
- `/taxonomy` — allergens, conditions, diets, cuisines
- `/scan` — barcode lookup, scan history
- `/analyzer` — analyze text/url/image/barcode, save
- `/meal-log` — daily log, items, water, copy-day, streak, templates
- `/meal-plans` — generate/list/detail/activate/swap/regenerate/delete
- `/grocery-lists` — generate/list/detail, item CRUD, substitutions
- `/budget` — snapshot, create/update budget, trends
- `/households` — members list/add/read/update, member health
- `/admin` — curated recipes, audit, dashboard
- `/healthz`, `/readyz` — health endpoints (non-versioned)

## Required Migrations

Apply in order against `DATABASE_URL`:

| Migration | Purpose |
|-----------|---------|
| `007_drop_silver_sync_triggers.sql` | Remove Silver↔Gold sync dependencies |
| `008_meal_logging_tables.sql` | Meal log tables |
| `009_meal_plan_ai_columns.sql` | AI meal planner columns |
| `010_recipe_source_type_backfill.sql` | Backfill `source_type` for planner |
| `011_grocery_list_hardening.sql` | Grocery list schema fixes |
| `012_budget_tracker_foundation.sql` | Budget tracking tables |
| `013_budget_recommendations.sql` | Budget recommendation tables |
| `014_notifications_foundation.sql` | Notification system setup |
| `015_notifications.sql` | Notification triggers |

## NPM Scripts

| Script | Description |
|--------|-------------|
| `npm run dev` | Start dev server with hot reload |
| `npm run build` | Build for production |
| `npm run start` | Start production server |
| `npm run check` | TypeScript type check |
| `npm test` | Run all unit tests |
| `npm run test:grocery` | Grocery list tests only |
| `npm run test:budget` | Budget utils tests only |
| `npm run test:nutrition` | Nutrition dashboard tests only |

## Operational Notes

- Server keep-alive/header timeouts tuned for reverse proxy (Nginx, Next.js rewrite).
- Graceful shutdown on SIGTERM/SIGINT with DB connection drain.
- Error handler includes schema-out-of-date responses for missing columns.
- Rate limiting uses in-memory store (use Redis for multi-instance).
- Idempotency middleware uses in-memory TTL store.

## License

Use project default license policy.
