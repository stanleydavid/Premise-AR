import { NextRequest, NextResponse } from 'next/server';
import { queryOne } from '@/lib/db/pg';
import { sessionCookieOptions, sessionToken } from '@/lib/auth/session';
import { auditBestEffort } from '@/lib/audit';
import { absoluteUrl } from '@/lib/http/origin';
import { idsOf } from '@/lib/http/api';
import { navigationRoute } from '@/lib/http/route-errors';
import { isRole } from '@/lib/auth/roles';
import { SESSION_COOKIE } from '@/lib/product';
import { devLoginEnabled } from '@/lib/auth/dev-login';
import { homeFor } from '@/lib/auth/home';

export const dynamic = 'force-dynamic';

/** Demo sign-in (see lib/auth/dev-login.ts); 404 unless enabled. Audited. */
export const POST = navigationRoute(async (request: NextRequest) => {
  if (!devLoginEnabled()) return new NextResponse(null, { status: 404 });
  const form = await request.formData().catch(() => null);
  const email = String(form?.get('email') ?? '').toLowerCase();
  if (!/^[a-z0-9._-]+@demo\.invalid$/.test(email)) return NextResponse.redirect(absoluteUrl(request, '/login?error=not-registered'), 303);
  const user = await queryOne<{ id: string; display_name: string; role: string; active: boolean }>(
    'select id, display_name, role, active from app_users where email = $1', [email]);
  if (!user || !user.active || !isRole(user.role)) return NextResponse.redirect(absoluteUrl(request, '/login?error=not-registered'), 303);
  const session = { sub: `local:${user.id}`, userId: user.id, displayName: user.display_name, role: user.role };
  await auditBestEffort({ eventName: 'auth.dev_login', actor: session, action: 'LOGIN', entityType: 'app_user', entityId: user.id,
    result: 'success', reason: 'DEV_LOGIN_ENABLED', ...idsOf(request) });
  const response = NextResponse.redirect(absoluteUrl(request, homeFor(user.role)), 303);
  response.cookies.set(SESSION_COOKIE, await sessionToken(session), sessionCookieOptions);
  return response;
});
