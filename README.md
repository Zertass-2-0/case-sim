# CaseSim

A small CS-style **case opening simulator** with floats and trade-up contracts.
Node.js/Express backend + PostgreSQL, everything runs with Docker Compose.

> Unofficial fan-made practice project. Virtual coins only, no real money. Not affiliated with Valve.
> Skin names and images come from the open [ByMykel/CSGO-API](https://github.com/ByMykel/CSGO-API) dataset and belong to their owners; images are hot-linked, not stored.

## Run it

```bash
cp .env.example .env     # then replace every CHANGE_ME (Windows: copy .env.example .env)
docker compose up --build
```

Open http://localhost:3000. Log in as the admin from `.env` (`ADMIN_NICK` / `ADMIN_PASSWORD`) or sign up as a normal player (1000 starting coins).

Stop with `docker compose down`. Data **stays** in the named volume `pgdata`; only `docker compose down -v` wipes it.

## Features

- Sign up / log in (passwords hashed with bcrypt, sessions are signed JWTs).
- Open cases (server-side weighted random roll, animated roulette in the browser).
- Every item is a unique instance with a **float** (0-1, stored as exact `NUMERIC`), which decides its wear and price.
- **Trade-up contracts**: 10 items of one rarity -> 1 item of the next rarity. The resulting float is the average of the inputs, so it can be aimed: an exact **0.5** (x25 price) is realistically only reachable through a contract; floats below 0.001 and the cleanest float in the whole game are worth even more.
- Sell items, inventory sorting, leaderboards (cleanest floats, richest players), transaction history.
- Admin panel: give/take coins, give cases, give skins (with a chosen float).

## Architecture

```
browser  --HTTP-->  backend (Node/Express, :3000)  --SQL-->  db (PostgreSQL, internal network only)
                         |                                         |
                 serves /public (HTML/JS)                  named volume pgdata
```

| Path | What |
|---|---|
| `compose.yaml` | `db` + `backend` services, network, named volume, healthcheck-based start order |
| `backend/Dockerfile` | custom image for the backend (node:20-alpine, non-root user) |
| `backend/sql/schema.sql` | tables, constraints, indexes (idempotent, applied on start) |
| `backend/data/seed.json` | rarities, 4 cases, 69 skins (generated once by `scripts/build_seed.py`) |
| `backend/src/` | `server.js` (app), `auth.js`, `game.js` (cases/inventory/contracts), `admin.js`, `pricing.js`, `db.js` |
| `backend/public/` | single-page frontend, no framework |

Config and secrets come from `.env` (not in Git). See `.env.example`.

### Database

`users`, `rarities`, `skins`, `cases`, `case_skins` (many-to-many), `user_cases`, `inventory`, `transactions` (ledger).
Money-changing operations (open case, sell, contract, admin grants) run in a single SQL **transaction**, with the user row locked (`SELECT ... FOR UPDATE`) so parallel requests can't spend the same coins twice.

### API (all under `/api`, JSON; everything except `/auth/*` and `/health` needs `Authorization: Bearer <token>`)

| Method | Path | |
|---|---|---|
| POST | `/auth/register`, `/auth/login` | returns token |
| GET | `/me`, `/cases`, `/cases/:id`, `/inventory`, `/transactions`, `/leaderboard` | read |
| POST | `/cases/:id/open` | open a case (uses an owned case first, else pays) |
| POST | `/inventory/sell` | `{ids:[...]}` |
| POST | `/contracts/preview`, `/contracts` | `{ids:[10 ids]}` |
| POST | `/admin/money`, `/admin/case`, `/admin/skin` | admin only |
| GET | `/admin/users`, `/admin/skins` | admin only |

## Regenerating the seed (optional)

```bash
python scripts/build_seed.py collections.json skins.json
```
using the files from `https://raw.githubusercontent.com/ByMykel/CSGO-API/main/public/api/en/`.
