import 'server-only';
import { queryOne, withTransaction } from '@/lib/db/pg';
import { auditTx } from '@/lib/audit';
import { nricHmac } from '@/lib/security/nric';
import { isRole, type Role } from '@/lib/auth/roles';
import type { RequestIds } from '@/lib/http/api';

/**
 * DBKK ID claims used to link a sign-in to a registered officer (earthid-standards §8):
 *   nric / ic_no               only released when MyKad is verified (dashed 900101-12-1234)
 *   mydigital_verified         string verified | pending | failed | unverified (not boolean)
 * Claim names can be overridden once confirmed against the live DBKK ID (EARTHID_NRIC_CLAIM,
 * EARTHID_VERIFIED_CLAIM). Placeholder values (e.g. "pending-mydigitalid-verification") never link.
 */
export type LinkClaims = {
  sub: string; nric: string | null; mydigital: string | null;
  email: string | null; emailVerified: boolean; name: string | null;
};

export function readClaims(claims: Record<string, unknown>, env: Record<string, string | undefined> = process.env): LinkClaims {
  const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : null);
  const nricClaim = env.EARTHID_NRIC_CLAIM || 'nric';
  const verifiedClaim = env.EARTHID_VERIFIED_CLAIM || 'mydigital_verified';
  return {
    sub: String(claims.sub ?? ''),
    nric: str(claims[nricClaim]) ?? str(claims.ic_no),
    mydigital: str(claims[verifiedClaim]),
    email: str(claims.email)?.toLowerCase() ?? null,
    emailVerified: claims.email_verified === true || claims.email_verified === 'true',
    name: str(claims.name),
  };
}

export type LinkedUser = { id: string; display_name: string; role: Role; active: boolean };
export type LinkResult =
  | { ok: true; user: LinkedUser; method: 'subject' | 'nric' | 'email' }
  | { ok: false; reason: 'not_registered' | 'already_linked' | 'invalid_subject' | 'role_invalid' };

type Row = { id: string; display_name: string; role: string; active: boolean; earthid_subject: string | null };

function asUser(row: Row): LinkedUser | null {
  return isRole(row.role) ? { id: row.id, display_name: row.display_name, role: row.role, active: row.active } : null;
}

export async function linkOfficer(c: LinkClaims, ids: RequestIds, env: Record<string, string | undefined> = process.env): Promise<LinkResult> {
  if (!c.sub || c.sub.length > 255) return { ok: false, reason: 'invalid_subject' };

  const existing = await queryOne<Row>('select id, display_name, role, active, earthid_subject from app_users where earthid_subject = $1', [c.sub]);
  if (existing) {
    const user = asUser(existing);
    return user ? { ok: true, user, method: 'subject' } : { ok: false, reason: 'role_invalid' };
  }

  // Strong key first: the MyDigital-verified IC. Then e-mail, only where DBKK governance allows it.
  const candidates: Array<{ method: 'nric' | 'email'; column: 'nric_hmac' | 'email'; value: string }> = [];
  const hmac = c.mydigital === 'verified' ? nricHmac(c.nric, env.NRIC_HMAC_SECRET ?? '') : null;
  if (hmac) candidates.push({ method: 'nric', column: 'nric_hmac', value: hmac });
  if (env.EARTHID_LINK_BY_EMAIL === 'true' && c.emailVerified && c.email) candidates.push({ method: 'email', column: 'email', value: c.email });

  for (const candidate of candidates) {
    const result = await withTransaction(async (db): Promise<LinkResult | null> => {
      const row = await queryOne<Row>(
        `select id, display_name, role, active, earthid_subject from app_users where ${candidate.column} = $1 for update`, [candidate.value], db);
      if (!row) return null;
      if (row.earthid_subject && row.earthid_subject !== c.sub) {
        // Never silently re-link an account that already belongs to another DBKK ID identity.
        await auditTx(db, { eventName: 'user.identity_link_refused', action: 'LINK_IDENTITY', entityType: 'app_user', entityId: row.id,
          result: 'already_linked', reason: candidate.method, ...ids });
        return { ok: false, reason: 'already_linked' };
      }
      await queryOne('update app_users set earthid_subject = $1, linked_at = now(), updated_at = now() where id = $2', [c.sub, row.id], db);
      await auditTx(db, { eventName: 'user.identity_linked', actor: { userId: row.id, sub: c.sub, role: row.role }, action: 'LINK_IDENTITY',
        entityType: 'app_user', entityId: row.id, result: 'success', reason: candidate.method, ...ids });
      const user = asUser(row);
      return user ? { ok: true, user, method: candidate.method } : { ok: false, reason: 'role_invalid' };
    });
    if (result) return result;
  }
  return { ok: false, reason: 'not_registered' };
}
