import { NextRequest, NextResponse } from 'next/server';
import { sessionFromToken } from '@/lib/auth/session';
import { absoluteUrl } from '@/lib/http/origin';
import { auditBestEffort } from '@/lib/audit';
import { idsOf } from '@/lib/http/api';
import { navigationRoute } from '@/lib/http/route-errors';
import { discoverEarthId } from '@/lib/auth/earthid';
import { openSecret } from '@/lib/security/secret-box';
import { logger } from '@/lib/observability/logger';
import { SESSION_COOKIE } from '@/lib/product';

export const dynamic = 'force-dynamic';

/** End the local session, then RP-initiated logout at DBKK ID (id_token_hint) so single sign-on ends too. */
async function handler(request: NextRequest) {
  const ids = idsOf(request);
  const session = await sessionFromToken(request.cookies.get(SESSION_COOKIE)?.value).catch(() => null);
  if (session) {
    await auditBestEffort({ eventName: 'auth.logout', actor: session, action: 'LOGOUT', entityType: 'app_user', entityId: session.userId, result: 'success', ...ids });
  }
  const sealed = request.cookies.get('earthid_id_token')?.value;
  let target = absoluteUrl(request, '/login?signedOut=1');
  if (sealed && process.env.EARTHID_ISSUER) {
    try {
      const discovery = await discoverEarthId();
      if (discovery.end_session_endpoint) {
        const url = new URL(discovery.end_session_endpoint);
        url.searchParams.set('id_token_hint', openSecret(sealed));
        url.searchParams.set('client_id', process.env.EARTHID_CLIENT_ID ?? '');
        url.searchParams.set('post_logout_redirect_uri', process.env.EARTHID_POST_LOGOUT_REDIRECT_URI || absoluteUrl(request, '/login').toString());
        target = url;
      }
    } catch (error) {
      logger.warn('earthid.logout_unavailable', { ...ids, errorType: (error as Error).name });
    }
  }
  const response = NextResponse.redirect(target, 303);
  response.cookies.delete(SESSION_COOKIE);
  response.cookies.delete('earthid_id_token');
  // Drop the offline copy of the field page (it shows the officer's name). Unsent records in IndexedDB
  // are kept: they belong to this officer and are only sent with their session.
  response.headers.set('clear-site-data', '"cache"');
  return response;
}

export const GET = navigationRoute(handler);
export const POST = navigationRoute(handler);
