import 'server-only';
import { SignJWT, jwtVerify } from 'jose';
import { cookies } from 'next/headers';
import { queryOne } from '@/lib/db/pg';
import { SESSION_COOKIE, SESSION_HOURS } from '@/lib/product';
import { can, isRole, type Permission, type Role } from '@/lib/auth/roles';

export type AppSession = { sub: string; userId: string; displayName: string; role: Role };

function secret() {
  const value = process.env.SESSION_SECRET;
  if (!value || value.length < 32) throw new Error('SESSION_SECRET must be at least 32 characters');
  return new TextEncoder().encode(value);
}

export async function sessionToken(session: AppSession) {
  return new SignJWT({ userId: session.userId })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime(`${SESSION_HOURS}h`)
    .setSubject(session.sub)
    .sign(secret());
}

export const sessionCookieOptions = {
  httpOnly: true, sameSite: 'lax' as const, secure: process.env.NODE_ENV === 'production', path: '/', maxAge: 60 * 60 * SESSION_HOURS,
};

export async function createSession(session: AppSession) {
  (await cookies()).set(SESSION_COOKIE, await sessionToken(session), sessionCookieOptions);
}

export async function clearSession() {
  (await cookies()).delete(SESSION_COOKIE);
}

/** Session from a token: the cookie only carries the user id; role and active flag are read fresh. */
export async function sessionFromToken(token: string | undefined): Promise<AppSession | null> {
  if (!token) return null;
  let userId: string;
  try {
    const { payload } = await jwtVerify(token, secret());
    userId = String(payload.userId ?? '');
  } catch {
    return null;
  }
  if (!/^[0-9a-f-]{36}$/i.test(userId)) return null;
  const user = await queryOne<{ id: string; earthid_subject: string | null; display_name: string; role: string; active: boolean }>(
    'select id, earthid_subject, display_name, role, active from app_users where id = $1', [userId]);
  if (!user || !user.active || !isRole(user.role)) return null;
  return { sub: user.earthid_subject ?? `local:${user.id}`, userId: user.id, displayName: user.display_name, role: user.role };
}

export async function getSession(): Promise<AppSession | null> {
  return sessionFromToken((await cookies()).get(SESSION_COOKIE)?.value);
}

export async function requireSession() {
  const session = await getSession();
  if (!session) throw new Error('UNAUTHENTICATED');
  return session;
}

export async function requirePermission(permission: Permission) {
  const session = await requireSession();
  if (!can(session.role, permission)) throw new Error('FORBIDDEN');
  return session;
}
