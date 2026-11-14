import 'server-only';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { query, queryOne, withTransaction, type Db } from '@/lib/db/pg';
import { auditTx } from '@/lib/audit';
import { DomainError, type RequestIds } from '@/lib/http/api';
import type { AppSession } from '@/lib/auth/session';
import { can } from '@/lib/auth/roles';
import { inspectionOutcome, licenceStatus } from '@/lib/domain/licence-status';
import { applicableRules, ruleSet } from '@/lib/domain/premises';

export const IdempotencyKey = z.string().regex(/^[A-Za-z0-9_-]{16,64}$/, 'Idempotency-Key must be 16–64 characters [A-Za-z0-9_-]');

const Position = {
  lat: z.number().min(-90).max(90).nullable().optional(),
  lng: z.number().min(-180).max(180).nullable().optional(),
  accuracy_m: z.number().min(0).max(100_000).nullable().optional(),
  heading: z.number().min(0).max(360).nullable().optional(),
};

export const InspectionInput = z.object({
  premise_id: z.uuid(),
  observed_at: z.iso.datetime({ offset: true }),
  answers: z.record(z.string().max(60), z.enum(['patuh', 'tidak_patuh', 'tb'])),
  notes: z.string().max(2000).optional().default(''),
  photos: z.array(z.object({ photo_id: z.uuid(), rule_id: z.string().max(60).nullable().optional() })).max(30).default([]),
  ...Position,
}).strict();
export type InspectionInputT = z.infer<typeof InspectionInput>;

/** Canonical hash of the request content: a replay with the same key must carry the same content. */
export function requestHash(value: unknown) {
  const canon = (v: unknown): unknown => Array.isArray(v) ? v.map(canon)
    : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([k, x]) => [k, canon(x)]))
      : v;
  return createHash('sha256').update(JSON.stringify(canon(value))).digest('hex');
}

/** Device clock sanity: not in the future, not older than 7 days (an offline phone syncs within a shift or two). */
function checkObservedAt(iso: string, now = Date.now()) {
  const t = Date.parse(iso);
  if (t > now + 5 * 60_000) throw new DomainError('OBSERVED_AT_IN_FUTURE', 422);
  if (t < now - 7 * 86_400_000) throw new DomainError('OBSERVED_AT_TOO_OLD', 422);
}

async function linkPhotos(db: Db, session: AppSession, photos: InspectionInputT['photos'], allowedRules: Set<string> | null) {
  if (!photos.length) return [];
  const ids = photos.map((p) => p.photo_id);
  if (new Set(ids).size !== ids.length) throw new DomainError('PHOTO_DUPLICATED', 422);
  const owned = await query<{ id: string; used: boolean }>(
    `select p.id, exists (select 1 from inspection_photos ip where ip.photo_id = p.id)
                  or exists (select 1 from unlisted_report_photos rp where rp.photo_id = p.id) used
       from photos p where p.id = any($1::uuid[]) and p.uploaded_by = $2`, [ids, session.userId], db);
  if (owned.length !== ids.length) throw new DomainError('PHOTO_NOT_FOUND', 422);
  if (owned.some((p) => p.used)) throw new DomainError('PHOTO_ALREADY_USED', 409);
  if (allowedRules) for (const p of photos) if (p.rule_id && !allowedRules.has(p.rule_id)) throw new DomainError('PHOTO_RULE_NOT_IN_CHECKLIST', 422);
  return photos;
}

export type CreatedInspection = { id: string; outcome: string; licence_status_seen: string; replayed: boolean };

export async function createInspection(session: AppSession, key: string, input: InspectionInputT, ids: RequestIds): Promise<CreatedInspection> {
  checkObservedAt(input.observed_at);
  const hash = requestHash(input);

  const prior = await queryOne<{ id: string; outcome: string; licence_status_seen: string; request_hash: string }>(
    'select id, outcome, licence_status_seen, request_hash from inspections where officer_id = $1 and idempotency_key = $2', [session.userId, key]);
  if (prior) {
    if (prior.request_hash !== hash) throw new DomainError('IDEMPOTENCY_KEY_REUSED', 409);
    return { id: prior.id, outcome: prior.outcome, licence_status_seen: prior.licence_status_seen, replayed: true };
  }

  const premise = await queryOne<{ id: string; licence_id: string | null; type_code: string | null; status: string | null; valid_until: string | null }>(
    `select p.id, l.id licence_id, l.licence_type_code type_code, l.status, to_char(l.valid_until, 'YYYY-MM-DD') valid_until
       from premises p left join lateral (select * from licences l where l.premise_id = p.id order by valid_until desc limit 1) l on true
      where p.id = $1`, [input.premise_id]);
  if (!premise) throw new DomainError('PREMISE_NOT_FOUND', 404);

  const rules = applicableRules((await ruleSet()).rules, premise.type_code);
  const ruleById = new Map(rules.map((r) => [r.id, r]));
  const answered = Object.keys(input.answers);
  if (!answered.length) throw new DomainError('ANSWERS_REQUIRED', 422);
  const unknown = answered.filter((id) => !ruleById.has(id));
  if (unknown.length) throw new DomainError('RULE_NOT_IN_CHECKLIST', 422, { rule_ids: unknown.slice(0, 10) });

  const outcome = inspectionOutcome(input.answers, rules.map((r) => r.id));
  const seen = licenceStatus(premise.licence_id ? { status: premise.status!, valid_until: premise.valid_until! } : null).code;

  return withTransaction(async (db) => {
    const row = await queryOne<{ id: string }>(
      `insert into inspections (idempotency_key, request_hash, officer_id, premise_id, licence_id, licence_status_seen, outcome, notes,
                                observed_at, lat, lng, accuracy_m, heading)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
       on conflict (officer_id, idempotency_key) do nothing returning id`,
      [key, hash, session.userId, premise.id, premise.licence_id, seen, outcome, input.notes || null, input.observed_at,
        input.lat ?? null, input.lng ?? null, input.accuracy_m ?? null, input.heading ?? null], db);
    if (!row) throw new DomainError('IDEMPOTENCY_IN_PROGRESS', 409);   // a concurrent retry won; the client retries and gets the replay
    for (const [ruleId, result] of Object.entries(input.answers)) {
      await query('insert into inspection_items (inspection_id, rule_id, rule_text, result) values ($1,$2,$3,$4)',
        [row.id, ruleId, ruleById.get(ruleId)!.text, result], db);
    }
    const photos = await linkPhotos(db, session, input.photos, new Set(rules.map((r) => r.id)));
    for (const p of photos) {
      await query('insert into inspection_photos (inspection_id, photo_id, rule_id) values ($1,$2,$3)', [row.id, p.photo_id, p.rule_id ?? null], db);
    }
    await auditTx(db, { eventName: 'inspection.recorded', actor: session, action: 'CREATE', entityType: 'inspection', entityId: row.id, result: 'success',
      after: { premise_id: premise.id, outcome, licence_status_seen: seen, items: answered.length, photos: photos.length }, ...ids });
    return { id: row.id, outcome, licence_status_seen: seen, replayed: false };
  });
}

export const InspectionListQuery = z.object({
  scope: z.enum(['mine', 'all']).default('mine'),
  outcome: z.enum(['patuh', 'tidak_patuh', 'belum_lengkap']).optional(),
  premise_id: z.uuid().optional(),
  before: z.iso.datetime({ offset: true }).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(30),
});

export async function listInspections(session: AppSession, q: z.infer<typeof InspectionListQuery>) {
  if (q.scope === 'all' && !can(session.role, 'inspections:read_all')) throw new Error('FORBIDDEN');
  const where = ['true'];
  const params: unknown[] = [];
  const add = (sql: string, v: unknown) => { params.push(v); where.push(sql.replace('?', `$${params.length}`)); };
  if (q.scope === 'mine') add('i.officer_id = ?', session.userId);
  if (q.outcome) add('i.outcome = ?', q.outcome);
  if (q.premise_id) add('i.premise_id = ?', q.premise_id);
  if (q.before) add('i.observed_at < ?', q.before);
  params.push(q.limit);
  return query(
    `select i.id, i.observed_at, i.received_at, i.outcome, i.licence_status_seen, i.notes, i.lat, i.lng, i.accuracy_m, i.heading,
            p.id premise_id, p.trade_name, l.licence_no, u.display_name officer_name,
            (select count(*)::int from inspection_photos ip where ip.inspection_id = i.id) photo_count,
            coalesce((select json_agg(json_build_object('rule_id', it.rule_id, 'rule_text', it.rule_text, 'result', it.result) order by it.rule_id)
                        from inspection_items it where it.inspection_id = i.id), '[]') items,
            coalesce((select json_agg(json_build_object('photo_id', ip.photo_id, 'rule_id', ip.rule_id))
                        from inspection_photos ip where ip.inspection_id = i.id), '[]') photos
       from inspections i join premises p on p.id = i.premise_id
       left join licences l on l.id = i.licence_id join app_users u on u.id = i.officer_id
      where ${where.join(' and ')}
      order by i.observed_at desc limit $${params.length}`, params);
}

// ---------------------------------------------------------------- unlisted premises
export const UnlistedInput = z.object({
  signboard_name: z.string().trim().min(1).max(160),
  licence_type_code: z.string().regex(/^[A-Z][A-Z0-9_]{1,30}$/).nullable().optional(),
  floor: z.number().int().min(-2).max(30).default(0),
  notes: z.string().max(2000).optional().default(''),
  observed_at: z.iso.datetime({ offset: true }),
  photos: z.array(z.object({ photo_id: z.uuid() })).max(10).default([]),
  ...Position,
}).strict();

export async function createUnlistedReport(session: AppSession, key: string, input: z.infer<typeof UnlistedInput>, ids: RequestIds) {
  checkObservedAt(input.observed_at);
  const hash = requestHash(input);
  const prior = await queryOne<{ id: string; request_hash: string }>(
    'select id, request_hash from unlisted_reports where officer_id = $1 and idempotency_key = $2', [session.userId, key]);
  if (prior) {
    if (prior.request_hash !== hash) throw new DomainError('IDEMPOTENCY_KEY_REUSED', 409);
    return { id: prior.id, replayed: true };
  }
  return withTransaction(async (db) => {
    const row = await queryOne<{ id: string }>(
      `insert into unlisted_reports (idempotency_key, request_hash, officer_id, signboard_name, licence_type_code, floor, notes, observed_at,
                                     location, accuracy_m, heading)
       values ($1,$2,$3,$4,$5,$6,$7,$8,
               case when $9::float8 is null or $10::float8 is null then null else st_setsrid(st_makepoint($10, $9), 4326)::geography end, $11, $12)
       on conflict (officer_id, idempotency_key) do nothing returning id`,
      [key, hash, session.userId, input.signboard_name, input.licence_type_code ?? null, input.floor, input.notes || null, input.observed_at,
        input.lat ?? null, input.lng ?? null, input.accuracy_m ?? null, input.heading ?? null], db);
    if (!row) throw new DomainError('IDEMPOTENCY_IN_PROGRESS', 409);
    const photos = await linkPhotos(db, session, input.photos.map((p) => ({ photo_id: p.photo_id })), null);
    for (const p of photos) await query('insert into unlisted_report_photos (report_id, photo_id) values ($1,$2)', [row.id, p.photo_id], db);
    await auditTx(db, { eventName: 'unlisted_report.created', actor: session, action: 'CREATE', entityType: 'unlisted_report', entityId: row.id,
      result: 'success', after: { signboard_name: input.signboard_name, photos: photos.length }, ...ids });
    return { id: row.id, replayed: false };
  });
}

export const UnlistedStatusInput = z.object({
  status: z.enum(['disiasat', 'ditutup']),
  reason: z.string().trim().min(3).max(500),
}).strict();

export async function updateUnlistedStatus(session: AppSession, id: string, input: z.infer<typeof UnlistedStatusInput>, ids: RequestIds) {
  return withTransaction(async (db) => {
    const before = await queryOne<{ status: string }>('select status from unlisted_reports where id = $1 for update', [id], db);
    if (!before) throw new DomainError('REPORT_NOT_FOUND', 404);
    if (before.status === 'ditutup') throw new DomainError('REPORT_CLOSED', 409);
    await query(`update unlisted_reports set status = $2, status_reason = $3, status_changed_by = $4, status_changed_at = now() where id = $1`,
      [id, input.status, input.reason, session.userId], db);
    await auditTx(db, { eventName: 'unlisted_report.status_changed', actor: session, action: 'UPDATE_STATUS', entityType: 'unlisted_report', entityId: id,
      result: 'success', reason: input.reason, before: { status: before.status }, after: { status: input.status }, ...ids });
    return { id, status: input.status };
  });
}

export async function listUnlistedReports(session: AppSession, status?: string) {
  const mine = !can(session.role, 'reports:manage');
  return query(
    `select r.id, r.signboard_name, r.licence_type_code, r.floor, r.notes, r.observed_at, r.status, r.status_reason,
            st_y(r.location::geometry) lat, st_x(r.location::geometry) lng, r.accuracy_m, u.display_name officer_name,
            coalesce((select json_agg(rp.photo_id) from unlisted_report_photos rp where rp.report_id = r.id), '[]') photo_ids
       from unlisted_reports r join app_users u on u.id = r.officer_id
      where ($1::boolean = false or r.officer_id = $2) and ($3::text is null or r.status = $3)
      order by r.observed_at desc limit 100`, [mine, session.userId, status ?? null]);
}

// ---------------------------------------------------------------- pin corrections
export const PinInput = z.object({
  lat: z.number().min(-90).max(90), lng: z.number().min(-180).max(180), accuracy_m: z.number().min(0).max(100).nullable().optional(),
}).strict();

export async function suggestPin(session: AppSession, premiseId: string, input: z.infer<typeof PinInput>, ids: RequestIds) {
  return withTransaction(async (db) => {
    const premise = await queryOne<{ id: string }>('select id from premises where id = $1', [premiseId], db);
    if (!premise) throw new DomainError('PREMISE_NOT_FOUND', 404);
    const row = await queryOne<{ id: string }>(
      `insert into pin_corrections (premise_id, officer_id, location, accuracy_m)
       values ($1,$2, st_setsrid(st_makepoint($4,$3),4326)::geography, $5) returning id`,
      [premiseId, session.userId, input.lat, input.lng, input.accuracy_m ?? null], db);
    await auditTx(db, { eventName: 'premise.pin_suggested', actor: session, action: 'SUGGEST_LOCATION', entityType: 'premise', entityId: premiseId,
      result: 'success', after: { pin_correction_id: row!.id, lat: input.lat, lng: input.lng, accuracy_m: input.accuracy_m ?? null }, ...ids });
    return { id: row!.id, status: 'cadangan' };
  });
}

export async function listPinCorrections() {
  return query(
    `select c.id, c.premise_id, p.trade_name, c.status, c.created_at, c.accuracy_m, u.display_name officer_name,
            st_y(c.location::geometry) lat, st_x(c.location::geometry) lng,
            st_y(p.location::geometry) current_lat, st_x(p.location::geometry) current_lng,
            round(st_distance(c.location, p.location)::numeric, 1)::float8 shift_m
       from pin_corrections c join premises p on p.id = c.premise_id join app_users u on u.id = c.officer_id
      where c.status = 'cadangan' order by c.created_at limit 100`);
}

export const PinReviewInput = z.object({ decision: z.enum(['diterima', 'ditolak']), reason: z.string().trim().max(500).optional() }).strict();

export async function reviewPin(session: AppSession, id: string, input: z.infer<typeof PinReviewInput>, ids: RequestIds) {
  return withTransaction(async (db) => {
    const c = await queryOne<{ premise_id: string; status: string; officer_id: string; lat: number; lng: number }>(
      `select premise_id, status, officer_id, st_y(location::geometry) lat, st_x(location::geometry) lng from pin_corrections where id = $1 for update`, [id], db);
    if (!c) throw new DomainError('PIN_CORRECTION_NOT_FOUND', 404);
    if (c.status !== 'cadangan') throw new DomainError('PIN_CORRECTION_ALREADY_REVIEWED', 409);
    if (c.officer_id === session.userId) throw new DomainError('PIN_REVIEW_OWN_SUGGESTION', 403);   // segregation of duties
    await query('update pin_corrections set status = $2, reviewed_by = $3, reviewed_at = now() where id = $1', [id, input.decision, session.userId], db);
    let before: unknown = null;
    if (input.decision === 'diterima') {
      before = await queryOne(`select st_y(location::geometry) lat, st_x(location::geometry) lng, location_source from premises where id = $1 for update`, [c.premise_id], db);
      await query(`update premises set location = st_setsrid(st_makepoint($3,$2),4326)::geography, location_source = 'officer',
                   location_updated_at = now(), updated_at = now() where id = $1`, [c.premise_id, c.lat, c.lng], db);
    }
    await auditTx(db, { eventName: 'premise.pin_reviewed', actor: session, action: input.decision === 'diterima' ? 'APPROVE' : 'REJECT',
      entityType: 'premise', entityId: c.premise_id, result: input.decision, reason: input.reason ?? null, before,
      after: input.decision === 'diterima' ? { lat: c.lat, lng: c.lng, location_source: 'officer' } : null, ...ids });
    return { id, status: input.decision };
  });
}
