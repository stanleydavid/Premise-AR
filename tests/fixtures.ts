import { randomUUID } from 'node:crypto';
import { queryOne } from '@/lib/db/pg';
import type { AppSession } from '@/lib/auth/session';
import type { Role } from '@/lib/auth/roles';

/** Unique data per test (evidence and audit tables are append-only, so tests never clean up). */
export const uid = () => randomUUID().slice(0, 8);
export const ids = () => ({ requestId: `req_TEST${uid()}`, correlationId: `cor_TEST${uid()}` });
export const key = () => `test_${randomUUID().replace(/-/g, '')}`;

export async function makeUser(role: Role, extra: { email?: string; nric_hmac?: string; earthid_subject?: string } = {}): Promise<AppSession> {
  const row = await queryOne<{ id: string }>(
    'insert into app_users (display_name, role, email, nric_hmac, earthid_subject) values ($1,$2,$3,$4,$5) returning id',
    [`Ujian ${role} ${uid()}`, role, extra.email ?? `${uid()}@test.invalid`, extra.nric_hmac ?? null, extra.earthid_subject ?? null]);
  return { userId: row!.id, sub: extra.earthid_subject ?? `local:${row!.id}`, displayName: 'Ujian', role };
}

export async function makePremise(type = 'GUNTING', opts: { lat?: number; lng?: number; status?: string; days?: number } = {}) {
  const p = await queryOne<{ id: string }>(
    `insert into premises (external_ref, trade_name, location) values ($1,$2, st_setsrid(st_makepoint($4,$3),4326)::geography) returning id`,
    [`T-${uid()}`, `Premis Ujian ${uid()}`, opts.lat ?? 5.9, opts.lng ?? 116.05]);
  await queryOne(
    `insert into licences (premise_id, licence_no, licence_type_code, status, valid_until)
     values ($1,$2,$3,$4, current_date + $5::int)`, [p!.id, `T/LP/${uid()}`, type, opts.status ?? 'active', opts.days ?? 200]);
  return p!.id;
}

/** Smallest valid JPEG header bytes plus random padding (unique hash per call). */
export const jpeg = () => new Uint8Array([0xff, 0xd8, 0xff, 0xe0, ...new TextEncoder().encode(randomUUID())]);
