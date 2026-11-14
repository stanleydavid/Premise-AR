import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { exportJWK, generateKeyPair, SignJWT, type JWK } from 'jose';
import { NextRequest, type NextResponse } from 'next/server';
import { closePool, queryOne } from '@/lib/db/pg';
import { nricHmac } from '@/lib/security/nric';
import { SESSION_COOKIE } from '@/lib/product';
import { makeUser, uid } from './fixtures';

/**
 * DBKK ID callback against a mock OIDC provider (discovery, token and JWKS served by a stubbed fetch).
 * Checks: state, nonce, signature, issuer, audience; linking by verified IC; no session on any failure.
 */
const ISSUER = 'https://dbkkid.test/api/earthid';
let privateKey: CryptoKey, jwk: JWK;

beforeAll(async () => {
  const pair = await generateKeyPair('RS256');
  privateKey = pair.privateKey;
  jwk = { ...(await exportJWK(pair.publicKey)), kid: 'k1', alg: 'RS256', use: 'sig' };
  Object.assign(process.env, {
    EARTHID_ISSUER: ISSUER, EARTHID_CLIENT_ID: 'svc-semak-premis', EARTHID_CLIENT_SECRET: 'test-secret',
    EARTHID_REDIRECT_URI: 'http://localhost/api/auth/callback', APP_URL: 'http://localhost',
  });
});
afterEach(() => vi.unstubAllGlobals());
afterAll(closePool);

async function idToken(claims: Record<string, unknown>, opts: { iss?: string; aud?: string; key?: CryptoKey } = {}) {
  return new SignJWT(claims).setProtectedHeader({ alg: 'RS256', kid: 'k1' }).setIssuer(opts.iss ?? ISSUER)
    .setAudience(opts.aud ?? 'svc-semak-premis').setIssuedAt().setExpirationTime('5m').sign(opts.key ?? privateKey);
}

function mockProvider(token: string) {
  const calls: string[] = [];
  vi.stubGlobal('fetch', vi.fn(async (input: string | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push(url);
    if (url.endsWith('/.well-known/openid-configuration')) {
      return Response.json({ authorization_endpoint: `${ISSUER}/protocol/openid-connect/auth`, token_endpoint: `${ISSUER}/protocol/openid-connect/token`,
        jwks_uri: `${ISSUER}/protocol/openid-connect/certs`, end_session_endpoint: `${ISSUER}/protocol/openid-connect/logout` });
    }
    if (url.endsWith('/certs')) return Response.json({ keys: [jwk] });
    if (url.endsWith('/token')) {
      const body = new URLSearchParams(String(init?.body));
      expect(body.get('code_verifier')).toBe('verifier-123');      // PKCE verifier goes to the token endpoint, from the server
      return Response.json({ id_token: token, access_token: 'a', token_type: 'Bearer' });
    }
    return new Response('not found', { status: 404 });
  }));
  return calls;
}

function callbackRequest(state = 'state-1', cookieState = 'state-1') {
  const req = new NextRequest(`http://localhost/api/auth/callback?code=c1&state=${state}`);
  req.cookies.set('earthid_state', cookieState);
  req.cookies.set('earthid_verifier', 'verifier-123');
  req.cookies.set('earthid_nonce', 'nonce-1');
  req.cookies.set('earthid_return', '/semakan');
  return req;
}

async function run(req: NextRequest) {
  const { GET } = await import('@/app/api/auth/callback/route');
  const res = (await GET(req)) as NextResponse;
  return { res, location: res.headers.get('location') ?? '', session: res.cookies.get(SESSION_COOKIE)?.value };
}

describe('DBKK ID callback', () => {
  it('links a registered officer by MyDigital-verified IC and signs them in', async () => {
    const ic = `7701${String(Math.floor(Math.random() * 1e8)).padStart(8, '0')}`;
    const officer = await makeUser('pegawai', { nric_hmac: nricHmac(ic)! });
    const sub = `sub-${uid()}`;
    mockProvider(await idToken({ sub, nonce: 'nonce-1', nric: `${ic.slice(0, 6)}-${ic.slice(6, 8)}-${ic.slice(8)}`, mydigital_verified: 'verified', name: 'Ali' }));
    const { location, session, res } = await run(callbackRequest());
    expect(location).toBe('http://localhost/semakan');
    expect(session).toBeTruthy();
    expect(res.cookies.get('earthid_id_token')?.value).toMatch(/^v1\./);           // sealed, not the raw token
    expect((await queryOne<{ earthid_subject: string }>('select earthid_subject from app_users where id = $1', [officer.userId]))?.earthid_subject).toBe(sub);
  });

  it('refuses a tampered state, a wrong nonce, a foreign signer, another audience or issuer — with no session', async () => {
    const sub = `sub-${uid()}`;
    mockProvider(await idToken({ sub, nonce: 'nonce-1' }));
    expect(await run(callbackRequest('evil', 'state-1'))).toMatchObject({ location: 'http://localhost/login?error=earthid-failed', session: undefined });

    mockProvider(await idToken({ sub, nonce: 'other' }));
    expect(await run(callbackRequest())).toMatchObject({ location: 'http://localhost/login?error=earthid-failed', session: undefined });

    const foreign = (await generateKeyPair('RS256')).privateKey;
    mockProvider(await idToken({ sub, nonce: 'nonce-1' }, { key: foreign }));
    expect(await run(callbackRequest())).toMatchObject({ location: 'http://localhost/login?error=earthid-failed', session: undefined });

    mockProvider(await idToken({ sub, nonce: 'nonce-1' }, { aud: 'some-other-app' }));
    expect(await run(callbackRequest())).toMatchObject({ location: 'http://localhost/login?error=earthid-failed', session: undefined });

    mockProvider(await idToken({ sub, nonce: 'nonce-1' }, { iss: 'https://evil.test/api/earthid' }));
    expect(await run(callbackRequest())).toMatchObject({ location: 'http://localhost/login?error=earthid-failed', session: undefined });
  });

  it('a valid DBKK ID user who was never registered gets "not registered", audited, no session', async () => {
    const sub = `sub-${uid()}`;
    mockProvider(await idToken({ sub, nonce: 'nonce-1', email: `${uid()}@x.test`, email_verified: true }));
    expect(await run(callbackRequest())).toMatchObject({ location: 'http://localhost/login?error=not-registered', session: undefined });
    expect(await queryOne(`select 1 from audit_events where event_name = 'auth.login_denied' and entity_id = $1`, [sub])).toBeTruthy();
  });
});
