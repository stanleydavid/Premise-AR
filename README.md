# Semak Premis

Field app for DBKK licensing officers: point the phone at a row of shops, see each licensed premise's
**trade name, licence type and licence status** as camera labels, match the label to the signboard, and
record a **compliance checklist for that licence type** with photo evidence per item. Works without
signal: records wait on the phone and send themselves when there is a connection.

- `prototype/` — the original static prototype (also live from the `main` branch on GitHub Pages).
- Everything else — the production app (this branch). Decisions: [`docs/adr/0001-production-architecture.md`](docs/adr/0001-production-architecture.md).
  Standards status: [`docs/EARTHOPS_COMPLIANCE.md`](docs/EARTHOPS_COMPLIANCE.md).

## Who does what

| Role | Can |
|---|---|
| **Pegawai** (officer) | Field view, record inspections and "premis tiada dalam senarai" reports, suggest pin corrections, see own records |
| **Penyelia** (supervisor) | Everything a pegawai can, plus all officers' records, update report status, approve/reject pin suggestions (not their own) |
| **Pentadbir** (administrator) | Register officers and their roles, import premise and licence data (CSV), see all records, health detail |

Sign-in is **DBKK ID** only. An administrator registers each officer first (name, role, and IC and/or
official e-mail); the account links automatically on the officer's first DBKK ID sign-in. Only an HMAC of
the IC is stored.

## Stack

Next.js 16 (App Router) · TypeScript strict · PostgreSQL 16 + PostGIS · Zod · Tailwind 4 · Vitest.

## Run locally

Requirements: Node 22, PostgreSQL 16 with PostGIS.

```bash
npm install
cp .env.example .env.local          # fill in; for local work set DEV_LOGIN_ENABLED=true
# database and the non-superuser app role (as a DBA):
psql -c "create role semak_app login password '…'" -c "create database semak"
npm run db:migrate                  # uses DATABASE_MIGRATION_URL (owner) when set
npm run db:seed                     # optional demo: 21 premises around the test point + 3 demo users
npm run dev
```

With `DEV_LOGIN_ENABLED=true` (never in production) the sign-in page offers demo users
(pegawai / penyelia / pentadbir @demo.invalid). The field view also offers **Mod latihan** outside
production: no camera, drag to turn, and nothing is saved.

The camera, GPS and compass need **HTTPS** (or `localhost`). To try the field view on a phone, serve it
over HTTPS (staging behind the WAF, or a tunnel).

First administrator in a new environment:

```bash
node scripts/create-user.mjs --name "Nama Pentadbir" --role pentadbir --email nama@dbkk.sabah.gov.my --ic 800101-12-1234
```

## Tests

```bash
cp .env.test.example .env.test      # points at a disposable semak_test database
DATABASE_URL=$DATABASE_MIGRATION_URL npm run db:migrate   # once, as owner
npm run lint && npm run typecheck && npm test && npm run build
```

46 tests: licence status and outcome rules, CSV parsing, IC handling, role matrix, every `/api/v1`
endpoint's permission, PostGIS nearby query, idempotency and replay, photo ownership and reuse,
append-only evidence (as app role and as owner), pin review segregation, last-administrator guard,
import all-or-nothing and pin preservation, DBKK ID callback against a mock provider (state, nonce,
signature, issuer, audience, unregistered user).

## API (v1)

All responses: `{ "data": …, "request_id": "req_…", "correlation_id": "cor_…" }`; errors:
`{ "error": "<CODE>", "error_code": "SEMAK-<CAT>-<NNN>", "request_id", "correlation_id", "support_reference"? }`.

| Method & path | Permission | Notes |
|---|---|---|
| `GET /api/v1/me` | signed in | user and capabilities |
| `GET /api/v1/rules` | premises:read | licence types + checklist |
| `GET /api/v1/premises/nearby?lat&lng&radius` | premises:read | ≤ 500 m, nearest first, licence status |
| `POST /api/v1/photos` | inspections:create | multipart `file` (JPEG/WebP ≤ 2.5 MB) + `meta`; same bytes → same id |
| `GET /api/v1/photos/:id` | uploader or read_all | |
| `POST /api/v1/inspections` | inspections:create | header `Idempotency-Key`; `answers`, `photos[{photo_id, rule_id}]` |
| `GET /api/v1/inspections?scope=mine\|all` | read_own / read_all | |
| `POST /api/v1/unlisted-reports` | reports:create | `Idempotency-Key` |
| `PATCH /api/v1/unlisted-reports/:id` | reports:manage | status + reason |
| `POST /api/v1/premises/:id/pin-corrections` | pins:suggest | officer's position, accuracy ≤ 20 m in the UI |
| `GET /api/v1/pin-corrections`, `POST …/:id/review` | pins:review | not one's own |
| `GET/POST /api/v1/admin/users`, `PATCH …/:id` | users:manage | |
| `POST /api/v1/admin/import[?dry_run=true]` | premises:import | `text/csv`, all-or-nothing |
| `GET /api/health/live`, `/ready`, `/api/health` | public / public / admin | |

## Premise import format

UTF-8 CSV with header:
`external_ref,trade_name,registered_name,address,floor,lat,lng,licence_no,licence_type,licence_status,valid_until,compound_rm,conditions`
— `licence_status` is `active|suspended|revoked`, `valid_until` is `YYYY-MM-DD`, `conditions` separated by `;`.
Coordinates outside Sabah are rejected (catches swapped lat/lng).

## Compliance rules are examples

The checklist in `db/migrations/0001_init.sql` (`compliance_rules`) is a placeholder taken from the
prototype; rules marked `is_example` (e.g. the barber glazing rule) must be confirmed by DBKK licensing.
Change rules with a new migration.
