# ADR 0001: Production architecture for Semak Premis

- Status: accepted (phase 1)
- Date: 2026-11-14

## Context

The GitHub Pages prototype (`prototype/`, `main` branch) proved the field idea: camera labels for nearby
licensed premises, matched by the officer against the signboard, then a checklist per licence type.
Production needs real data, DBKK ID sign-in, server-side records with audit, and work without signal.

## Decision

1. **Stack (EarthOps default):** Next.js App Router + TypeScript strict, Zod on every input, PostgreSQL 16
   + PostGIS, plain SQL migrations (`db/migrations`, never edited once applied), Vitest.
2. **Identity:** DBKK ID (EarthID Enterprise) OIDC, authorization code + PKCE S256, confidential client.
   Officers are registered by an administrator and linked on first sign-in by stored `sub`, then by
   MyDigital-verified IC (HMAC only), then by verified e-mail only when `EARTHID_LINK_BY_EMAIL=true`.
   An account already linked to another `sub` is never re-linked silently (refused and audited).
3. **Roles** live in `app_users` (pegawai, penyelia, pentadbir); DBKK ID roles are not used for access.
4. **Field view** stays framework-free inside one React client component (`app/periksa/field/app.ts`):
   a 60 fps camera overlay is simpler and smoother outside React's render cycle.
5. **Offline first:** every inspection/report is written to an IndexedDB outbox, then sent: photos first
   (deduplicated by SHA-256 per officer), then the record with an `Idempotency-Key`. Same key + same
   content = replay (200); same key + other content = 409. Records carry the officer's user id and are
   only sent with that officer's session.
6. **Evidence is immutable:** inspections, their items and photo links, and audit events are append-only
   (database triggers; the app role also lacks UPDATE/DELETE). A correction is a new inspection.
7. **Server decides:** inspection outcome and the licence status "seen" are computed on the server from
   the answers and the licence row, never taken from the phone.
8. **Photos** are stored on the application server's volume (`PHOTO_STORAGE_DIR`), sniffed by magic bytes
   (JPEG/WebP only), served only to the uploader or supervisors/administrators.
9. **Licence data** is loaded by CSV import (all-or-nothing, dry run first) until the licensing system
   integration is agreed. Officer-corrected pins survive imports unless the import moves a premise > 50 m.
10. **Pin corrections** are suggestions; a supervisor other than the suggester approves them.

## Deviations from the EARTH Info default (recorded here as required)

- **No shadcn/ui yet.** Tailwind tokens only; the office pages are small. Revisit when they grow.
- **No queue/worker.** Nothing asynchronous on the server in phase 1.
- **No local break-glass administrator login yet.** Bootstrap uses `scripts/create-user.mjs`; DBKK ID is
  the only interactive sign-in in production. To add before go-live (see compliance checklist).

## Open integration details (to obtain from DBKK / Earth platform team)

- DBKK ID client registration (client id/secret, redirect and post-logout URIs per environment) and
  confirmation of the live claim names (`nric`/`ic_no`, `mydigital_verified`).
- The licensing system's data feed (format, frequency, owner) to replace manual CSV import, and whether
  it should flow through Earth DataHub.
- Whether officers may be linked by verified e-mail (DBKK governance).
