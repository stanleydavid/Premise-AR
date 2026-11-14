import { createHmac } from 'node:crypto';

/**
 * Officers are matched to DBKK ID by their MyDigital-verified IC. Only an HMAC of the 12 digits is
 * stored (NRIC_HMAC_SECRET); the IC itself is never stored or logged.
 */
export function normaliseNric(value: string | null | undefined) {
  const digits = String(value ?? '').replace(/\D/g, '');
  return digits.length === 12 ? digits : null;
}

export function nricHmac(value: string | null | undefined, secret = process.env.NRIC_HMAC_SECRET ?? '') {
  const digits = normaliseNric(value);
  if (!digits || secret.length < 32) return null;
  return createHmac('sha256', secret).update(`nric:${digits}`).digest('hex');
}
