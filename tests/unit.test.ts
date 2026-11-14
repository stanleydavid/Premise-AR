import { describe, expect, it } from 'vitest';
import { inspectionOutcome, licenceStatus } from '@/lib/domain/licence-status';
import { parseCsv } from '@/lib/domain/admin';
import { requestHash } from '@/lib/domain/inspections';
import { sniffImage } from '@/lib/domain/photos';
import { readClaims } from '@/lib/domain/officers';
import { nricHmac, normaliseNric } from '@/lib/security/nric';
import { sanitizeReturnTo } from '@/lib/auth/return-to';
import { devLoginEnabled } from '@/lib/auth/dev-login';
import { can, ROLES, type Permission } from '@/lib/auth/roles';
import { newSupportReference, SUPPORT_REFERENCE } from '@/lib/observability/ids';
import { bearing, dist, move, n180 } from '@/app/periksa/field/geo';

describe('licence status', () => {
  const today = '2026-11-14';
  it('classifies by status and days to expiry (Malaysia calendar days)', () => {
    expect(licenceStatus({ status: 'active', valid_until: '2027-06-01' }, today).code).toBe('SAH');
    expect(licenceStatus({ status: 'active', valid_until: '2026-12-14' }, today)).toMatchObject({ code: 'HAMPIR_TAMAT', days: 30 });
    expect(licenceStatus({ status: 'active', valid_until: '2026-11-14' }, today)).toMatchObject({ code: 'HAMPIR_TAMAT', days: 0 });
    expect(licenceStatus({ status: 'active', valid_until: '2026-11-13' }, today)).toMatchObject({ code: 'TAMAT', key: 'bad', days: -1 });
    expect(licenceStatus({ status: 'suspended', valid_until: '2030-01-01' }, today).code).toBe('DIGANTUNG');
    expect(licenceStatus({ status: 'revoked', valid_until: '2030-01-01' }, today).code).toBe('DIBATALKAN');
    expect(licenceStatus(null, today).code).toBe('TIADA_LESEN');
  });
  it('decides the outcome from the answers, not from the client', () => {
    const rules = ['a', 'b', 'c'];
    expect(inspectionOutcome({ a: 'patuh', b: 'tb', c: 'patuh' }, rules)).toBe('patuh');
    expect(inspectionOutcome({ a: 'patuh' }, rules)).toBe('belum_lengkap');
    expect(inspectionOutcome({ a: 'tidak_patuh' }, rules)).toBe('tidak_patuh');
  });
});

describe('CSV import parser', () => {
  it('handles quotes, doubled quotes, CRLF, BOM and blank lines', () => {
    expect(parseCsv('﻿a,b\r\n"x, y","say ""hi"""\n\n1,\n')).toEqual([['a', 'b'], ['x, y', 'say "hi"'], ['1', '']]);
  });
});

describe('idempotency request hash', () => {
  it('ignores key order but not content', () => {
    expect(requestHash({ a: 1, b: { c: 2, d: 3 } })).toBe(requestHash({ b: { d: 3, c: 2 }, a: 1 }));
    expect(requestHash({ a: 1 })).not.toBe(requestHash({ a: 2 }));
  });
});

describe('photo type sniffing', () => {
  it('trusts the bytes, not the declared type', () => {
    expect(sniffImage(new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0]))).toBe('image/jpeg');
    expect(sniffImage(new TextEncoder().encode('RIFF\0\0\0\0WEBPVP8 '))).toBe('image/webp');
    expect(sniffImage(new TextEncoder().encode('<svg onload=alert(1)>'))).toBeNull();
    expect(sniffImage(new TextEncoder().encode('%PDF-1.7'))).toBeNull();
  });
});

describe('DBKK ID claims and IC handling', () => {
  it('reads nric / ic_no and the string mydigital_verified claim', () => {
    const c = readClaims({ sub: 's1', ic_no: '900101-12-1234', mydigital_verified: 'verified', email: 'A@DBKK.my', email_verified: 'true', name: 'Ali' }, {});
    expect(c).toMatchObject({ sub: 's1', nric: '900101-12-1234', mydigital: 'verified', email: 'a@dbkk.my', emailVerified: true });
  });
  it('honours configured claim names', () => {
    expect(readClaims({ sub: 's', my_ic: '1', my_status: 'verified' }, { EARTHID_NRIC_CLAIM: 'my_ic', EARTHID_VERIFIED_CLAIM: 'my_status' }))
      .toMatchObject({ nric: '1', mydigital: 'verified' });
  });
  it('hashes only well-formed ICs and never without a strong secret', () => {
    const secret = 'x'.repeat(32);
    expect(normaliseNric('900101-12-1234')).toBe('900101121234');
    expect(nricHmac('900101-12-1234', secret)).toBe(nricHmac('900101121234', secret));
    expect(nricHmac('900101-12-1234', secret)).toMatch(/^[0-9a-f]{64}$/);
    expect(nricHmac('pending-mydigitalid-verification', secret)).toBeNull();
    expect(nricHmac('900101-12-1234', 'short')).toBeNull();
  });
});

describe('sign-in safety', () => {
  it('returnTo accepts only relative paths on this site', () => {
    expect(sanitizeReturnTo('/semakan?tab=laporan')).toBe('/semakan?tab=laporan');
    for (const bad of ['https://evil.example', '//evil.example', '/\\evil', '/api/v1/me', '/login', 'javascript:alert(1)', null]) {
      expect(sanitizeReturnTo(bad)).toBe('/periksa');
    }
  });
  it('demo sign-in is impossible in production, whatever the flag says', () => {
    expect(devLoginEnabled({ DEV_LOGIN_ENABLED: 'true', APP_ENV: 'production' })).toBe(false);
    expect(devLoginEnabled({ APP_ENV: 'development' })).toBe(false);
    expect(devLoginEnabled({ DEV_LOGIN_ENABLED: 'true', APP_ENV: 'staging' })).toBe(true);
  });
});

describe('role permissions (negative cases)', () => {
  const allowed: Record<string, Permission[]> = {
    pegawai: ['premises:read', 'inspections:create', 'inspections:read_own', 'reports:create', 'pins:suggest'],
  };
  it('an officer cannot read others, review pins, manage users, import or see health detail', () => {
    for (const p of ['inspections:read_all', 'reports:manage', 'pins:review', 'users:manage', 'premises:import', 'health:detail'] as Permission[]) {
      expect(can('pegawai', p)).toBe(false);
    }
    for (const p of allowed.pegawai) expect(can('pegawai', p)).toBe(true);
  });
  it('a supervisor cannot manage users or import; an administrator does not record inspections', () => {
    expect(can('penyelia', 'users:manage')).toBe(false);
    expect(can('penyelia', 'premises:import')).toBe(false);
    expect(can('pentadbir', 'inspections:create')).toBe(false);
    expect(ROLES).toEqual(['pegawai', 'penyelia', 'pentadbir']);
  });
});

describe('identifiers', () => {
  it('support references follow SEMAK-ERR-YYYYMMDD-XXXXX in Malaysia time', () => {
    const ref = newSupportReference(new Date('2026-11-14T17:30:00Z'));
    expect(ref).toMatch(SUPPORT_REFERENCE);
    expect(ref.startsWith('SEMAK-ERR-20261115-')).toBe(true);
  });
});

describe('field geometry', () => {
  it('move/dist/bearing agree to within centimetres at shophouse scale', () => {
    const a = { lat: 5.6947939, lng: 115.958221 };
    const b = move(a, 90, 11);
    expect(dist(a, b)).toBeCloseTo(11, 1);
    expect(bearing(a, b)).toBeCloseTo(90, 0);
    expect(n180(350 - 10)).toBe(-20);
  });
});
