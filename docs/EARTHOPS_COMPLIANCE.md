# EarthOps compliance: Semak Premis (phase 1)

Checklist from `EARTH-Info/earthops-standards` (`specifications/compliance-checklist.md`), filled in honestly.
PASS = implemented and tested; PARTIAL = implemented, gap noted; TODO = not yet; EXCEPTION = ADR recorded.

| Area | Status | Evidence / gap |
|---|---|---|
| `request_id` / `correlation_id` per request, generated at ingress | PASS | `proxy.ts`; returned in every API envelope and header |
| Support reference `SEMAK-ERR-YYYYMMDD-XXXXX` on 5xx | PASS | `lib/http/api.ts`, `lib/http/route-errors.ts`; unit test |
| Structured JSON logs, schema fields, no secrets/tokens/IC | PASS | `lib/observability/logger.ts` (redaction); callback tests log no claims |
| Business validation failures not logged as ERROR | PASS | `api.request_rejected` at INFO |
| Append-only audit for privileged changes | PASS | `audit_events` + triggers; login, link, user access, import, pins, reports, inspections, health view |
| Audited change and its audit row in one transaction | PASS | `auditTx` in domain functions; tests check rows |
| Health live / ready / authenticated detail | PASS | `/api/health/live`, `/api/health/ready`, `/api/health` (admin, audited) |
| Friendly errors (401/403/404/500, sign-in errors) | PASS | `app/login`, `app/not-found.tsx`, `app/error.tsx` |
| Zod on every untrusted input | PASS | all `/api/v1` handlers |
| Server-side authorization on every privileged action | PASS | `route('<permission>')`; `tests/route-permissions.test.ts` pins each endpoint |
| Negative authorization tests | PASS | unit (role matrix), DB (self-review, own access, last admin), route permissions |
| Idempotency for retryable critical mutations | PASS | inspections, reports, photos; DB tests |
| Migrations for all schema changes | PASS | `db/migrations`, checksum-guarded runner |
| Non-superuser app role tested | PASS | tests and dev run as `semak_app` |
| DBKK ID OIDC: PKCE S256, state, nonce, iss/aud/sig checks | PASS | `tests/earthid-callback.test.ts` (mock provider) |
| Tokens never in localStorage; id_token sealed for logout | PASS | HTTP-only cookies, `sealSecret` |
| RP-initiated logout with `id_token_hint` | PASS | `app/api/auth/logout` (not yet tested against live DBKK ID) |
| Account linking order sub → IC → e-mail (policy-gated), no silent re-link | PASS | `lib/domain/officers.ts`; DB tests |
| Front-channel logout | TODO | add when DBKK ID registration supports it |
| Local break-glass admin login | TODO | ADR 0001; required before go-live |
| OpenTelemetry traces | TODO | Sentry capture wired; OTel exporter not configured yet |
| Sentry DSN configured | PARTIAL | code calls Sentry; `SENTRY_DSN`/init per environment pending |
| OpenAPI as API source of truth | TODO | `/api/v1` routes documented in code; OpenAPI file to add |
| Secrets outside git; `.env.example` without values | PASS | `.env*` ignored; examples carry placeholders only |
| CI: lint, typecheck, tests with DB, build | PASS | `.github/workflows/ci.yml` (PostGIS service) |
| Backups include photo volume | TODO | deployment runbook (PDKN) |
| Penetration test (PDKN) | TODO | before go-live, per `dbkk-pdkn-deployment` |
