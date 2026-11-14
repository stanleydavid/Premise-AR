import { NextRequest, NextResponse } from 'next/server';
import { discoverEarthId, verifyIdToken } from '@/lib/auth/earthid';
import { sessionCookieOptions, sessionToken } from '@/lib/auth/session';
import { auditBestEffort } from '@/lib/audit';
import { absoluteUrl } from '@/lib/http/origin';
import { idsOf } from '@/lib/http/api';
import { navigationRoute } from '@/lib/http/route-errors';
import { logger } from '@/lib/observability/logger';
import { sanitizeReturnTo } from '@/lib/auth/return-to';
import { sealSecret } from '@/lib/security/secret-box';
import { linkOfficer, readClaims } from '@/lib/domain/officers';
import { SESSION_COOKIE } from '@/lib/product';
import { homeFor } from '@/lib/auth/home';

export const dynamic = 'force-dynamic';

const TRANSIENT = ['earthid_state', 'earthid_verifier', 'earthid_nonce', 'earthid_return'];

function fail(request: NextRequest, event: string, error: string, fields: Record<string, unknown> = {}) {
  logger.warn(event, { ...idsOf(request), result: 'failed', ...fields });
  const response = NextResponse.redirect(absoluteUrl(request, `/login?error=${error}`), 303);
  for (const name of TRANSIENT) response.cookies.delete(name);
  return response;
}

/** DBKK ID redirect back: validate state, exchange the code on the server, verify the id_token, link the officer. */
export const GET = navigationRoute(async (request: NextRequest) => {
  const ids = idsOf(request);
  const params = request.nextUrl.searchParams;
  const idpError = params.get('error');
  if (idpError) return fail(request, 'earthid.authorization_error', 'earthid-failed', { errorCode: idpError.slice(0, 40) });
  const code = params.get('code');
  const state = params.get('state');
  const expectedState = request.cookies.get('earthid_state')?.value;
  const verifier = request.cookies.get('earthid_verifier')?.value;
  const expectedNonce = request.cookies.get('earthid_nonce')?.value;
  if (!code || !state || !expectedState || state !== expectedState || !verifier || !expectedNonce) {
    return fail(request, 'earthid.state_validation_failed', 'earthid-failed');
  }

  let discovery;
  try { discovery = await discoverEarthId(); } catch { return fail(request, 'earthid.discovery_unavailable', 'earthid-unavailable'); }

  const tokenResponse = await fetch(discovery.token_endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code', code, code_verifier: verifier,
      redirect_uri: process.env.EARTHID_REDIRECT_URI ?? '',
      client_id: process.env.EARTHID_CLIENT_ID ?? '', client_secret: process.env.EARTHID_CLIENT_SECRET ?? '',
    }),
    signal: AbortSignal.timeout(10_000),
  }).catch(() => null);
  if (!tokenResponse?.ok) return fail(request, 'earthid.token_exchange_failed', 'earthid-failed', { status: tokenResponse?.status ?? 0 });
  const tokens = (await tokenResponse.json().catch(() => ({}))) as { id_token?: string };
  if (!tokens.id_token) return fail(request, 'earthid.token_missing', 'earthid-failed');

  let claims;
  try {
    claims = await verifyIdToken(tokens.id_token, discovery.jwks_uri);
  } catch (error) {
    return fail(request, 'earthid.token_validation_failed', 'earthid-failed', { errorType: (error as Error).name });
  }
  if (claims.nonce !== expectedNonce) return fail(request, 'earthid.nonce_validation_failed', 'earthid-failed');

  const link = await linkOfficer(readClaims(claims as Record<string, unknown>), ids);
  if (!link.ok) {
    await auditBestEffort({ eventName: 'auth.login_denied', action: 'LOGIN', entityType: 'earthid_subject', entityId: String(claims.sub),
      result: link.reason, ...ids });
    return fail(request, 'earthid.account_link_failed', link.reason === 'already_linked' ? 'earthid-conflict' : 'not-registered', { result: link.reason });
  }
  if (!link.user.active) return fail(request, 'auth.login_disabled_account', 'disabled');

  const session = { sub: String(claims.sub), userId: link.user.id, displayName: link.user.display_name, role: link.user.role };
  await auditBestEffort({ eventName: 'auth.login_succeeded', actor: session, action: 'LOGIN', entityType: 'app_user', entityId: session.userId,
    result: 'success', reason: link.method, ...ids });
  logger.info('earthid.login_completed', { ...ids, result: 'success', linkMethod: link.method });

  const returnTo = sanitizeReturnTo(request.cookies.get('earthid_return')?.value, homeFor(session.role));
  const response = NextResponse.redirect(absoluteUrl(request, returnTo), 303);
  response.cookies.set(SESSION_COOKIE, await sessionToken(session), sessionCookieOptions);
  // Kept sealed and HTTP-only for RP-initiated logout, which needs id_token_hint. Never in localStorage.
  response.cookies.set('earthid_id_token', sealSecret(tokens.id_token), { ...sessionCookieOptions });
  for (const name of TRANSIENT) response.cookies.delete(name);
  return response;
});
