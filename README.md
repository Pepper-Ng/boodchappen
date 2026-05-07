# Boodchappen

A self-hostable grocery planner with real AH product and Allerhande recipe imports, user-scoped planning, and aggregated shopping lists.

## Features
- Registration plus login with username or email and password.
- User-scoped recipes, imported AH products, week-menu entries, and shopping lists.
- AH product import by URL with title, price, image, unit, and AH product ID extraction.
- AH recipe import by URL with description, normalized ingredients, instructions, and servings.
- Smart grocery aggregation that normalizes Dutch ingredient names and compatible units.
- Async recipe import jobs with status polling for loading-aware clients.
- PostgreSQL-first container deployment with persistent storage and health checks.

## Run locally (split-origin)
Copy `compose.local.example.env` to an untracked env file such as `compose.local.env`, fill in the blank secret values, and then run:

```bash
docker compose --env-file compose.local.env up --build
```

Open the frontend at `http://localhost:5173` and the backend docs at `http://localhost:8000/docs`.

The local example env file opts back into split-origin localhost access by setting `VITE_API_BASE_URL` and `CORS_ORIGINS` explicitly.

## Same-origin deployment
For a reverse-proxied deployment on one public origin, inject the required secrets from your shell, CI/CD system, or an untracked env file before starting the stack:

```bash
docker compose --env-file compose.prod.env up --build -d
```

Deployment guidance:
- `POSTGRES_PASSWORD` and `SECRET_KEY` are required and must be supplied at runtime.
- Leave `VITE_API_BASE_URL` empty to let the browser call the API on the current origin.
- Leave `CORS_ORIGINS` empty unless the browser will call the API from a different origin.
- Publish the frontend on the app origin and route API/docs traffic to the backend service.

## Test stack (split-origin)
Use the standalone test stack with its own env file to run an isolated deployment on separate ports:

```bash
docker compose --env-file compose.test.env -f docker-compose.test.yml up --build
```

That stack uses:
- frontend: `http://localhost:5174`
- backend: `http://localhost:8001/docs`
- PostgreSQL database: `boodschappen_test`

## Architecture
- `backend`: FastAPI, SQLModel, PostgreSQL via `psycopg`
- `frontend`: React + Vite
- `db`: PostgreSQL 16 with a persistent Docker volume

## API highlights
- `POST /auth/register`: create an account with email, password, and optional username.
- `POST /auth/login`: log in with `identifier` set to either username or email.
- `POST /products/import`: import an AH product from a product URL.
- `POST /recipes/import`: synchronous recipe import for the current frontend flow.
- `POST /recipes/import-jobs`: asynchronous recipe import with `GET /import-jobs/{id}` polling.
- `GET /shopping-list`: aggregated grocery list with matched products or AH search URLs.

## Notes
- `POSTGRES_PASSWORD`, `SECRET_KEY`, `TEST_POSTGRES_PASSWORD`, and `TEST_SECRET_KEY` are required runtime inputs for the compose stacks.
- `VITE_API_BASE_URL` and `CORS_ORIGINS` should stay empty for same-origin deployments and only be set for split-origin browser access.
- `compose.local.example.env` and `compose.test.example.env` are starter files for localhost runs; keep your real env files untracked.
- SQLModel `create_all()` is still used for bootstrap. For production migrations, add Alembic before live rollouts.
