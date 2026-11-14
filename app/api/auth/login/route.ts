import { NextRequest, NextResponse } from 'next/server';
import { discoverEarthId, pkceChallenge, randomUrlSafe } from '@/lib/auth/earthid';
import { absoluteUrl } from '@/lib/http/origin';
import { navigationRoute } from '@/lib/http/route-errors';
import { sanitizeReturnTo } from '@/lib/auth/return-to';
import { logger } from '@/lib/observability/logger';

export const dynamic = 'force-dynamic';

/** Start DBKK ID sign-in: authorization code + PKCE S256, fresh state, nonce and verifier per attempt. */
export const GET = navigationRoute(async (request: NextRequest) => {
  const requestId = request.headers.get('x-request-id');
  const clientId = process.env.EARTHID_CLIENT_ID;
  const redirectUri = process.env.EARTHID_REDIRECT_URI;
  if (!process.env.EARTHID_ISSUER || !clientId || !redirectUri || !process.env.EARTHID_CLIENT_SECRET) {
    logger.warn('earthid.client_misconfigured', { requestId });
    return NextResponse.redirect(absoluteUrl(request, '/login?error=earthid-unavailable'), 303);
  }
  let discovery;
  try {
    discovery = await discoverEarthId();
  } catch (error) {
    logger.warn('earthid.discovery_unavailable', { requestId, errorType: (error as Error).name });
    return NextResponse.redirect(absoluteUrl(request, '/login?error=earthid-unavailable'), 303);
  }
  const state = randomUrlSafe();
  const verifier = randomUrlSafe(48);
  const nonce = randomUrlSafe();
  const url = new URL(discovery.authorization_endpoint);
  url.searchParams.set('client_id', clientId);
  url.searchParams.set('redirect_uri', redirectUri);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('scope', process.env.EARTHID_SCOPES || 'openid profile email nric mydigital.verification');
  url.searchParams.set('state', state);
  url.searchParams.set('nonce', nonce);
  url.searchParams.set('code_challenge', pkceChallenge(verifier));
  url.searchParams.set('code_challenge_method', 'S256');

  logger.info('earthid.login_initiated', { requestId });
  const response = NextResponse.redirect(url);
  const options = { httpOnly: true, secure: process.env.NODE_ENV === 'production', sameSite: 'lax' as const, path: '/', maxAge: 600 };
  response.cookies.set('earthid_state', state, options);
  response.cookies.set('earthid_verifier', verifier, options);
  response.cookies.set('earthid_nonce', nonce, options);
  // Empty when no page was asked for, so the callback can choose the role's home page.
  response.cookies.set('earthid_return', sanitizeReturnTo(request.nextUrl.searchParams.get('returnTo'), ''), options);
  return response;
});
