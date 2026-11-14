import 'server-only';
import { createHash, randomBytes } from 'node:crypto';
import { createRemoteJWKSet, jwtVerify } from 'jose';

export type OidcDiscovery = {
  authorization_endpoint: string;
  token_endpoint: string;
  jwks_uri: string;
  end_session_endpoint?: string;
};

export function randomUrlSafe(bytes = 32) {
  return randomBytes(bytes).toString('base64url');
}

export function pkceChallenge(verifier: string) {
  return createHash('sha256').update(verifier).digest('base64url');
}

export async function discoverEarthId(): Promise<OidcDiscovery> {
  const issuer = process.env.EARTHID_ISSUER?.replace(/\/$/, '');
  if (!issuer) throw new Error('EARTHID_ISSUER is not configured');
  const res = await fetch(`${issuer}/.well-known/openid-configuration`, { cache: 'no-store' });
  if (!res.ok) throw new Error(`EarthID discovery failed: ${res.status}`);
  return res.json();
}

export async function verifyIdToken(idToken: string, jwksUri: string) {
  const issuer = process.env.EARTHID_ISSUER?.replace(/\/$/, '');
  const audience = process.env.EARTHID_CLIENT_ID;
  if (!issuer || !audience) throw new Error('EarthID configuration incomplete');
  const jwks = createRemoteJWKSet(new URL(jwksUri));
  const { payload } = await jwtVerify(idToken, jwks, { issuer, audience });
  return payload;
}
