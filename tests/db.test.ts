import { afterAll, describe, expect, it } from 'vitest';
import pg from 'pg';
import { closePool, query, queryOne } from '@/lib/db/pg';
import { createInspection, createUnlistedReport, reviewPin, suggestPin } from '@/lib/domain/inspections';
import { nearbyPremises } from '@/lib/domain/premises';
import { savePhoto } from '@/lib/domain/photos';
import { createUser, importPremises, updateUser } from '@/lib/domain/admin';
import { linkOfficer } from '@/lib/domain/officers';
import { nricHmac } from '@/lib/security/nric';
import { DomainError } from '@/lib/http/api';
import { ids, jpeg, key, makePremise, makeUser, uid } from './fixtures';

afterAll(closePool);
const now = () => new Date().toISOString();
const codeOf = async (p: Promise<unknown>) => p.then(() => 'OK', (e) => (e instanceof DomainError ? e.code : (e as Error).message));
const auditCount = async (event: string, entityId: string) =>
  (await queryOne<{ n: number }>('select count(*)::int n from audit_events where event_name = $1 and entity_id = $2', [event, entityId]))!.n;

describe('nearby premises (PostGIS)', () => {
  it('returns premises within the radius, nearest first, with the licence display status', async () => {
    const lat = 5.31 + Math.random() * 0.01, lng = 116.3;
    const near = await makePremise('MAKANAN', { lat, lng: lng + 0.0001, days: -3 });      // ~11 m, expired
    const far = await makePremise('MAKANAN', { lat, lng: lng + 0.01 });                  // ~1.1 km
    const rows = await nearbyPremises({ lat, lng, radius: 100 });
    const ids_ = rows.map((r) => r.id);
    expect(ids_).toContain(near);
    expect(ids_).not.toContain(far);
    const hit = rows.find((r) => r.id === near)!;
    expect(hit.distance_m).toBeGreaterThan(5); expect(hit.distance_m).toBeLessThan(20);
    expect(hit.licence?.display.code).toBe('TAMAT');
  });
});

describe('inspections', () => {
  it('records once per Idempotency-Key, replays the same content, refuses the key with other content', async () => {
    const officer = await makeUser('pegawai');
    const premise = await makePremise('GUNTING');
    const k = key();
    const input = { premise_id: premise, observed_at: now(), answers: { 'COMMON.lesen': 'patuh' as const, 'GUNTING.kaca': 'tidak_patuh' as const }, notes: '', photos: [] };
    const first = await createInspection(officer, k, input, ids());
    expect(first).toMatchObject({ outcome: 'tidak_patuh', licence_status_seen: 'SAH', replayed: false });
    const again = await createInspection(officer, k, input, ids());
    expect(again).toMatchObject({ id: first.id, replayed: true });
    expect(await codeOf(createInspection(officer, k, { ...input, notes: 'lain' }, ids()))).toBe('IDEMPOTENCY_KEY_REUSED');
    expect(await auditCount('inspection.recorded', first.id)).toBe(1);
  });

  it('rejects checklist items from another licence type and photos that are not the officer\'s own', async () => {
    const officer = await makeUser('pegawai');
    const other = await makeUser('pegawai');
    const premise = await makePremise('GUNTING');
    expect(await codeOf(createInspection(officer, key(), { premise_id: premise, observed_at: now(), answers: { 'MAKANAN.tifoid': 'patuh' }, notes: '', photos: [] }, ids())))
      .toBe('RULE_NOT_IN_CHECKLIST');
    const othersPhoto = await savePhoto(other, jpeg(), {}, ids());
    expect(await codeOf(createInspection(officer, key(), { premise_id: premise, observed_at: now(), answers: { 'COMMON.lesen': 'patuh' }, notes: '',
      photos: [{ photo_id: othersPhoto.id, rule_id: null }] }, ids()))).toBe('PHOTO_NOT_FOUND');
  });

  it('links photos to checklist items, and a photo can be used only once', async () => {
    const officer = await makeUser('pegawai');
    const premise = await makePremise('GUNTING');
    const photo = await savePhoto(officer, jpeg(), { lat: 5.9, lng: 116.05, accuracy_m: 6 }, ids());
    const again = await savePhoto(officer, jpeg(), {}, ids());
    expect(again.id).not.toBe(photo.id);
    const bytes = jpeg();
    expect((await savePhoto(officer, bytes, {}, ids())).id).toBe((await savePhoto(officer, bytes, {}, ids())).id);   // retry-safe
    const base = { premise_id: premise, observed_at: now(), answers: { 'GUNTING.kaca': 'tidak_patuh' as const }, notes: '' };
    const r = await createInspection(officer, key(), { ...base, photos: [{ photo_id: photo.id, rule_id: 'GUNTING.kaca' }] }, ids());
    const link = await queryOne<{ rule_id: string }>('select rule_id from inspection_photos where inspection_id = $1', [r.id]);
    expect(link?.rule_id).toBe('GUNTING.kaca');
    expect(await codeOf(createInspection(officer, key(), { ...base, photos: [{ photo_id: photo.id, rule_id: null }] }, ids()))).toBe('PHOTO_ALREADY_USED');
    expect(await codeOf(createInspection(officer, key(), { ...base, photos: [{ photo_id: again.id, rule_id: 'MAKANAN.tifoid' }] }, ids()))).toBe('PHOTO_RULE_NOT_IN_CHECKLIST');
  });

  it('refuses device times in the future or older than 7 days', async () => {
    const officer = await makeUser('pegawai');
    const premise = await makePremise();
    const at = (ms: number) => new Date(Date.now() + ms).toISOString();
    const input = (observed_at: string) => ({ premise_id: premise, observed_at, answers: { 'COMMON.lesen': 'patuh' as const }, notes: '', photos: [] });
    expect(await codeOf(createInspection(officer, key(), input(at(60 * 60_000)), ids()))).toBe('OBSERVED_AT_IN_FUTURE');
    expect(await codeOf(createInspection(officer, key(), input(at(-8 * 86_400_000)), ids()))).toBe('OBSERVED_AT_TOO_OLD');
  });
});

describe('evidence and audit are append-only', () => {
  it('neither the app role nor the table owner can change or delete them', async () => {
    const officer = await makeUser('pegawai');
    const r = await createInspection(officer, key(), { premise_id: await makePremise(), observed_at: now(), answers: { 'COMMON.lesen': 'patuh' }, notes: '', photos: [] }, ids());
    expect(await codeOf(query("update inspections set outcome = 'patuh' where id = $1", [r.id]))).toMatch(/permission denied|APPEND_ONLY/);
    expect(await codeOf(query('delete from audit_events where entity_id = $1', [r.id]))).toMatch(/permission denied|APPEND_ONLY/);
    const owner = new pg.Client({ connectionString: process.env.DATABASE_MIGRATION_URL });
    await owner.connect();
    try {
      await expect(owner.query("update inspections set outcome = 'patuh' where id = $1", [r.id])).rejects.toThrow(/APPEND_ONLY/);
      await expect(owner.query('delete from audit_events where entity_id = $1', [r.id])).rejects.toThrow(/APPEND_ONLY/);
      await expect(owner.query('truncate audit_events')).rejects.toThrow(/APPEND_ONLY|cannot truncate/);
    } finally { await owner.end(); }
  });
});

describe('unlisted reports', () => {
  it('are idempotent per key', async () => {
    const officer = await makeUser('pegawai');
    const k = key();
    const input = { signboard_name: 'Kedai Tanpa Lesen', floor: 0, notes: '', observed_at: now(), photos: [], lat: 5.9, lng: 116.05 };
    const a = await createUnlistedReport(officer, k, input, ids());
    const b = await createUnlistedReport(officer, k, input, ids());
    expect(b).toEqual({ id: a.id, replayed: true });
  });
});

describe('pin corrections', () => {
  it('a supervisor cannot approve their own suggestion; approval moves the pin and is audited with before/after', async () => {
    const officer = await makeUser('pegawai'), sup = await makeUser('penyelia');
    const premise = await makePremise('RUNCIT', { lat: 5.8, lng: 116.1 });
    const own = await suggestPin(sup, premise, { lat: 5.80005, lng: 116.1, accuracy_m: 5 }, ids());
    expect(await codeOf(reviewPin(sup, own.id, { decision: 'diterima' }, ids()))).toBe('PIN_REVIEW_OWN_SUGGESTION');
    const s = await suggestPin(officer, premise, { lat: 5.80009, lng: 116.10002, accuracy_m: 6 }, ids());
    await reviewPin(sup, s.id, { decision: 'diterima' }, ids());
    const moved = await queryOne<{ lat: number; source: string }>(`select st_y(location::geometry) lat, location_source source from premises where id = $1`, [premise]);
    expect(moved?.lat).toBeCloseTo(5.80009, 5);
    expect(moved?.source).toBe('officer');
    expect(await codeOf(reviewPin(sup, s.id, { decision: 'ditolak' }, ids()))).toBe('PIN_CORRECTION_ALREADY_REVIEWED');
    const audit = await queryOne<{ before: unknown; after: unknown }>(`select before, after from audit_events where event_name = 'premise.pin_reviewed' and entity_id = $1`, [premise]);
    expect(audit?.before).toMatchObject({ lat: 5.8 });
    expect(audit?.after).toMatchObject({ lat: 5.80009, location_source: 'officer' });
  });
});

describe('officer administration', () => {
  it('the last active administrator cannot be removed, and nobody changes their own access', async () => {
    const admin = await makeUser('pentadbir');
    expect(await codeOf(updateUser(admin, admin.userId, { active: false }, ids()))).toBe('CANNOT_CHANGE_OWN_ACCESS');
    const target = await makeUser('pegawai');
    const r = await updateUser(admin, target.userId, { role: 'penyelia' }, ids());
    expect(r.role).toBe('penyelia');
    expect(await auditCount('user.access_changed', target.userId)).toBe(1);
    // Disable every other administrator except one, then try to disable that one.
    await query(`update app_users set active = false where role = 'pentadbir' and id <> $1`, [admin.userId]);
    const lonely = await makeUser('penyelia');
    expect(await codeOf(updateUser(lonely, admin.userId, { active: false }, ids()))).toBe('LAST_ADMINISTRATOR');
  });

  it('registers by IC without storing the IC, and refuses duplicates', async () => {
    const admin = await makeUser('pentadbir');
    const ic = `9001${String(Math.floor(Math.random() * 1e8)).padStart(8, '0')}`;
    const u = await createUser(admin, { display_name: 'Pegawai Baharu', role: 'pegawai', ic }, ids());
    const row = await queryOne<{ nric_hmac: string }>('select nric_hmac from app_users where id = $1', [u.id]);
    expect(row?.nric_hmac).toBe(nricHmac(ic));
    expect(JSON.stringify(await query('select * from audit_events where entity_id = $1', [u.id]))).not.toContain(ic);
    expect(await codeOf(createUser(admin, { display_name: 'Dua', role: 'pegawai', ic }, ids()))).toBe('USER_EXISTS');
  });
});

describe('linking a DBKK ID sign-in to a registered officer', () => {
  it('links by MyDigital-verified IC once; never by an unverified IC; never re-links to another identity', async () => {
    const ic = `8501${String(Math.floor(Math.random() * 1e8)).padStart(8, '0')}`;
    const officer = await makeUser('pegawai', { nric_hmac: nricHmac(ic)! });
    const sub = `sub-${uid()}`;
    expect(await linkOfficer({ sub, nric: ic, mydigital: 'pending', email: null, emailVerified: false, name: null }, ids())).toEqual({ ok: false, reason: 'not_registered' });
    const linked = await linkOfficer({ sub, nric: ic, mydigital: 'verified', email: null, emailVerified: false, name: null }, ids());
    expect(linked).toMatchObject({ ok: true, method: 'nric', user: { id: officer.userId } });
    expect(await linkOfficer({ sub, nric: null, mydigital: null, email: null, emailVerified: false, name: null }, ids())).toMatchObject({ ok: true, method: 'subject' });
    expect(await linkOfficer({ sub: `other-${uid()}`, nric: ic, mydigital: 'verified', email: null, emailVerified: false, name: null }, ids()))
      .toEqual({ ok: false, reason: 'already_linked' });
    expect(await auditCount('user.identity_link_refused', officer.userId)).toBe(1);
  });

  it('links by verified e-mail only when EARTHID_LINK_BY_EMAIL=true', async () => {
    const email = `${uid()}@dbkk.test`;
    const officer = await makeUser('penyelia', { email });
    const claims = { sub: `sub-${uid()}`, nric: null, mydigital: null, email, emailVerified: true, name: null };
    expect(await linkOfficer(claims, ids(), { ...process.env, EARTHID_LINK_BY_EMAIL: 'false' })).toEqual({ ok: false, reason: 'not_registered' });
    expect(await linkOfficer({ ...claims, emailVerified: false }, ids(), { ...process.env, EARTHID_LINK_BY_EMAIL: 'true' })).toEqual({ ok: false, reason: 'not_registered' });
    expect(await linkOfficer(claims, ids(), { ...process.env, EARTHID_LINK_BY_EMAIL: 'true' })).toMatchObject({ ok: true, method: 'email', user: { id: officer.userId } });
  });
});

describe('premise import', () => {
  const header = 'external_ref,trade_name,registered_name,address,floor,lat,lng,licence_no,licence_type,licence_status,valid_until,compound_rm,conditions';
  it('is all-or-nothing and lists errors by line', async () => {
    const admin = await makeUser('pentadbir');
    const ref = `IMP-${uid()}`;
    const bad = [header,
      `${ref},Kedai A,,Lot 1,0,5.95,116.07,L/${uid()},GUNTING,active,2027-01-31,0,`,
      `${ref}-2,Kedai B,,Lot 2,0,116.07,5.95,L/${uid()},GUNTING,active,2027-01-31,0,`,      // lat/lng swapped
      `${ref}-3,Kedai C,,Lot 3,0,5.95,116.07,L/${uid()},KARAOKE,active,2027-01-31,0,`].join('\n');   // unknown type
    const r = await importPremises(admin, bad, false, ids());
    expect(r.errors.map((e) => e.line)).toEqual([3, 3, 4]);
    expect(await queryOne('select 1 from premises where external_ref = $1', [ref])).toBeNull();
  });

  it('upserts premises and licences, keeping an officer-corrected pin for small moves', async () => {
    const admin = await makeUser('pentadbir');
    const ref = `IMP-${uid()}`, lic = `L/${uid()}`;
    const csv = (lat: number, status = 'active') => [header, `${ref},"Kedai ""Baru""",,Lot 9,0,${lat},116.07,${lic},RUNCIT,${status},2027-01-31,150.50,Syarat 1; Syarat 2`].join('\n');
    expect(await importPremises(admin, csv(5.95), true, ids())).toMatchObject({ valid: 1, errors: [] });
    expect(await queryOne('select 1 from premises where external_ref = $1', [ref])).toBeNull();     // dry run writes nothing
    expect(await importPremises(admin, csv(5.95), false, ids())).toMatchObject({ created: 1, updated: 0 });
    const premise = (await queryOne<{ id: string }>('select id from premises where external_ref = $1', [ref]))!.id;
    await query(`update premises set location = st_setsrid(st_makepoint(116.07, 5.95003),4326)::geography, location_source = 'officer' where id = $1`, [premise]);
    expect(await importPremises(admin, csv(5.95, 'suspended'), false, ids())).toMatchObject({ created: 0, updated: 1 });
    const row = await queryOne<{ lat: number; source: string; trade_name: string; status: string; sen: string; conditions: string[] }>(
      `select st_y(p.location::geometry) lat, p.location_source source, p.trade_name, l.status, l.outstanding_compound_sen::text sen, l.conditions
         from premises p join licences l on l.premise_id = p.id where p.id = $1`, [premise]);
    expect(row).toMatchObject({ source: 'officer', trade_name: 'Kedai "Baru"', status: 'suspended', sen: '15050', conditions: ['Syarat 1', 'Syarat 2'] });
    expect(row!.lat).toBeCloseTo(5.95003, 5);
  });
});
