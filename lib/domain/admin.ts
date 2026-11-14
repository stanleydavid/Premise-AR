import 'server-only';
import { z } from 'zod';
import { query, queryOne, withTransaction } from '@/lib/db/pg';
import { auditTx } from '@/lib/audit';
import { DomainError, type RequestIds } from '@/lib/http/api';
import type { AppSession } from '@/lib/auth/session';
import { ROLES } from '@/lib/auth/roles';
import { nricHmac, normaliseNric } from '@/lib/security/nric';

// ---------------------------------------------------------------- officers
export const UserCreate = z.object({
  display_name: z.string().trim().min(2).max(120),
  role: z.enum(ROLES),
  email: z.email().max(200).transform((v) => v.toLowerCase()).optional(),
  ic: z.string().max(20).optional(),
  staff_no: z.string().trim().max(30).optional(),
}).strict().refine((v) => v.email || v.ic, { message: 'E-mel atau No. KP diperlukan', path: ['email'] });

export const UserUpdate = z.object({ role: z.enum(ROLES).optional(), active: z.boolean().optional() }).strict()
  .refine((v) => v.role !== undefined || v.active !== undefined, { message: 'Tiada perubahan' });

export async function listUsers() {
  return query(`select id, display_name, role, active, email, staff_no, earthid_subject is not null linked, linked_at,
                       nric_hmac is not null has_ic, created_at
                  from app_users order by active desc, display_name`);
}

export async function createUser(session: AppSession, input: z.infer<typeof UserCreate>, ids: RequestIds) {
  let hmac: string | null = null;
  if (input.ic) {
    if (!normaliseNric(input.ic)) throw new DomainError('IC_INVALID', 422);
    hmac = nricHmac(input.ic);
    if (!hmac) throw new DomainError('NRIC_HMAC_SECRET_NOT_CONFIGURED', 503);
  }
  return withTransaction(async (db) => {
    const clash = await queryOne<{ id: string }>(
      'select id from app_users where ($1::text is not null and email = $1) or ($2::text is not null and nric_hmac = $2) or ($3::text is not null and staff_no = $3)',
      [input.email ?? null, hmac, input.staff_no ?? null], db);
    if (clash) throw new DomainError('USER_EXISTS', 409);
    const row = await queryOne<{ id: string }>(
      'insert into app_users (display_name, role, email, nric_hmac, staff_no) values ($1,$2,$3,$4,$5) returning id',
      [input.display_name, input.role, input.email ?? null, hmac, input.staff_no ?? null], db);
    await auditTx(db, { eventName: 'user.registered', actor: session, action: 'CREATE', entityType: 'app_user', entityId: row!.id, result: 'success',
      after: { display_name: input.display_name, role: input.role, email: input.email ?? null, by_ic: Boolean(hmac), staff_no: input.staff_no ?? null }, ...ids });
    return { id: row!.id };
  });
}

export async function updateUser(session: AppSession, id: string, input: z.infer<typeof UserUpdate>, ids: RequestIds) {
  if (id === session.userId) throw new DomainError('CANNOT_CHANGE_OWN_ACCESS', 409);
  return withTransaction(async (db) => {
    await query('lock table app_users in share row exclusive mode', [], db);
    const before = await queryOne<{ role: string; active: boolean }>('select role, active from app_users where id = $1', [id], db);
    if (!before) throw new DomainError('USER_NOT_FOUND', 404);
    const after = { role: input.role ?? before.role, active: input.active ?? before.active };
    if (before.role === 'pentadbir' && before.active && (after.role !== 'pentadbir' || !after.active)) {
      const admins = await queryOne<{ n: number }>(`select count(*)::int n from app_users where role = 'pentadbir' and active`, [], db);
      if ((admins?.n ?? 0) <= 1) throw new DomainError('LAST_ADMINISTRATOR', 409);
    }
    await query('update app_users set role = $2, active = $3, updated_at = now() where id = $1', [id, after.role, after.active], db);
    await auditTx(db, { eventName: 'user.access_changed', actor: session, action: 'UPDATE_ACCESS', entityType: 'app_user', entityId: id, result: 'success',
      before, after, ...ids });
    return { id, ...after };
  });
}

// ---------------------------------------------------------------- premise and licence import (CSV)
/** Minimal RFC 4180 parser: quoted fields, doubled quotes, CRLF or LF, BOM. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [], field = '', quoted = false;
  const src = text.replace(/^﻿/, '');
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (quoted) {
      if (ch === '"' && src[i + 1] === '"') { field += '"'; i++; }
      else if (ch === '"') quoted = false;
      else field += ch;
    } else if (ch === '"' && field === '') quoted = true;
    else if (ch === ',') { row.push(field); field = ''; }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && src[i + 1] === '\n') i++;
      row.push(field); field = '';
      if (row.some((c) => c.trim() !== '')) rows.push(row);
      row = [];
    } else field += ch;
  }
  row.push(field);
  if (row.some((c) => c.trim() !== '')) rows.push(row);
  return rows;
}

export const IMPORT_COLUMNS = ['external_ref', 'trade_name', 'registered_name', 'address', 'floor', 'lat', 'lng',
  'licence_no', 'licence_type', 'licence_status', 'valid_until', 'compound_rm', 'conditions'] as const;

const emptyToUndefined = (v: unknown) => (typeof v === 'string' && v.trim() === '' ? undefined : v);
const ImportRow = z.object({
  external_ref: z.string().trim().min(1, 'Wajib diisi').max(60, 'Maksimum 60 aksara'),
  trade_name: z.string().trim().min(1, 'Wajib diisi').max(160, 'Maksimum 160 aksara'),
  registered_name: z.preprocess(emptyToUndefined, z.string().trim().max(200, 'Maksimum 200 aksara').optional()),
  address: z.preprocess(emptyToUndefined, z.string().trim().max(300, 'Maksimum 300 aksara').optional()),
  floor: z.preprocess(emptyToUndefined, z.coerce.number({ error: 'Mesti nombor' }).int('Mesti nombor bulat').min(-2, 'Antara -2 dan 30').max(30, 'Antara -2 dan 30').default(0)),
  // Sabah sits around 4–7.5 N, 115–119.5 E: a swapped or zero coordinate is caught here.
  lat: z.coerce.number({ error: 'Latitud mesti nombor' }).min(4, 'Latitud di luar Sabah (4 hingga 7.5); lat dan lng tertukar?').max(7.5, 'Latitud di luar Sabah (4 hingga 7.5); lat dan lng tertukar?'),
  lng: z.coerce.number({ error: 'Longitud mesti nombor' }).min(115, 'Longitud di luar Sabah (115 hingga 119.5); lat dan lng tertukar?').max(119.5, 'Longitud di luar Sabah (115 hingga 119.5); lat dan lng tertukar?'),
  licence_no: z.string().trim().min(3, 'Minimum 3 aksara').max(60, 'Maksimum 60 aksara'),
  licence_type: z.string().trim().toUpperCase(),
  licence_status: z.preprocess((v) => (typeof v === 'string' ? v.trim().toLowerCase() : v),
    z.enum(['active', 'suspended', 'revoked'], { error: 'Mesti active, suspended atau revoked' })),
  valid_until: z.string().trim().regex(/^\d{4}-\d{2}-\d{2}$/, 'Format tarikh YYYY-MM-DD'),
  compound_rm: z.preprocess(emptyToUndefined, z.coerce.number({ error: 'Mesti nombor (RM)' }).min(0, 'Tidak boleh negatif').max(1_000_000, 'Terlalu besar').default(0)),
  conditions: z.preprocess(emptyToUndefined, z.string().max(2000, 'Maksimum 2000 aksara').optional()),
});

export type ImportReport = { rows: number; valid: number; errors: Array<{ line: number; field: string; message: string }>; created?: number; updated?: number };

export async function importPremises(session: AppSession, csv: string, dryRun: boolean, ids: RequestIds): Promise<ImportReport> {
  const table = parseCsv(csv);
  if (table.length < 2) throw new DomainError('IMPORT_EMPTY', 422);
  const header = table[0].map((h) => h.trim().toLowerCase());
  const missing = IMPORT_COLUMNS.filter((c) => !['registered_name', 'address', 'floor', 'compound_rm', 'conditions'].includes(c) && !header.includes(c));
  if (missing.length) throw new DomainError('IMPORT_COLUMNS_MISSING', 422, { missing });
  if (table.length > 20_001) throw new DomainError('IMPORT_TOO_MANY_ROWS', 413, { max_rows: 20_000 });

  const types = new Set((await query<{ code: string }>('select code from licence_types where active')).map((t) => t.code));
  const errors: ImportReport['errors'] = [];
  const valid: Array<z.infer<typeof ImportRow> & { line: number }> = [];
  const seenRef = new Map<string, number>(), seenLicence = new Map<string, number>();
  table.slice(1).forEach((cells, i) => {
    const line = i + 2;
    const record = Object.fromEntries(header.map((h, j) => [h, cells[j] ?? '']));
    const parsed = ImportRow.safeParse(record);
    if (!parsed.success) {
      for (const issue of parsed.error.issues.slice(0, 5)) errors.push({ line, field: String(issue.path[0] ?? ''), message: issue.message });
      return;
    }
    const r = parsed.data;
    if (!types.has(r.licence_type)) { errors.push({ line, field: 'licence_type', message: `Jenis lesen tidak dikenali: ${r.licence_type}` }); return; }
    if (Number.isNaN(Date.parse(`${r.valid_until}T00:00:00Z`))) { errors.push({ line, field: 'valid_until', message: 'Tarikh tidak sah' }); return; }
    if (seenLicence.has(r.licence_no)) { errors.push({ line, field: 'licence_no', message: `Berulang (baris ${seenLicence.get(r.licence_no)})` }); return; }
    seenLicence.set(r.licence_no, line);
    seenRef.set(r.external_ref, line);
    valid.push({ ...r, line });
  });

  const report: ImportReport = { rows: table.length - 1, valid: valid.length, errors: errors.slice(0, 200) };
  if (dryRun || errors.length) return report;   // all-or-nothing: nothing is written while any row is invalid

  return withTransaction(async (db) => {
    let created = 0, updated = 0;
    for (const r of valid) {
      const p = await queryOne<{ id: string; inserted: boolean }>(
        `insert into premises (external_ref, trade_name, registered_name, address, floor, location)
         values ($1,$2,$3,$4,$5, st_setsrid(st_makepoint($7,$6),4326)::geography)
         on conflict (external_ref) do update set trade_name = excluded.trade_name, registered_name = excluded.registered_name,
           address = excluded.address, floor = excluded.floor,
           -- an officer-corrected pin is kept unless the import itself moves the premise by more than 50 m
           location = case when premises.location_source = 'officer' and st_distance(premises.location, excluded.location) <= 50
                           then premises.location else excluded.location end,
           location_source = case when premises.location_source = 'officer' and st_distance(premises.location, excluded.location) <= 50
                           then 'officer' else 'import' end,
           updated_at = now()
         returning id, (xmax = 0) inserted`,
        [r.external_ref, r.trade_name, r.registered_name ?? null, r.address ?? null, r.floor, r.lat, r.lng], db);
      if (p!.inserted) created++; else updated++;
      const owner = await queryOne<{ premise_id: string }>('select premise_id from licences where licence_no = $1', [r.licence_no], db);
      if (owner && owner.premise_id !== p!.id) throw new DomainError('IMPORT_LICENCE_BELONGS_TO_OTHER_PREMISE', 409, { line: r.line, licence_no: r.licence_no });
      await query(
        `insert into licences (premise_id, licence_no, licence_type_code, status, valid_until, conditions, outstanding_compound_sen)
         values ($1,$2,$3,$4,$5,$6,$7)
         on conflict (licence_no) do update set licence_type_code = excluded.licence_type_code, status = excluded.status,
           valid_until = excluded.valid_until, conditions = excluded.conditions,
           outstanding_compound_sen = excluded.outstanding_compound_sen, updated_at = now()`,
        [p!.id, r.licence_no, r.licence_type, r.licence_status, r.valid_until,
          (r.conditions ?? '').split(';').map((c) => c.trim()).filter(Boolean), Math.round(r.compound_rm * 100)], db);
    }
    await auditTx(db, { eventName: 'premises.imported', actor: session, action: 'IMPORT', entityType: 'premise_import', entityId: ids.correlationId,
      result: 'success', after: { rows: valid.length, created, updated }, ...ids });
    return { ...report, created, updated };
  });
}
