/**
 * EarthOps identifiers (earthops-standards: naming-conventions.md, observability standard §10):
 *   request_id      req_<26>          one per inbound request
 *   correlation_id  cor_<26>          one per transaction; generated at our ingress, never taken from
 *                                     an untrusted caller
 *   support ref     SEMAK-ERR-YYYYMMDD-XXXXX   shown to the user on a failure, mapped in the log
 * Crockford base32, no PII, safe to read aloud. Works in Node and edge runtimes.
 */
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

function random(length: number) {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => ALPHABET[b % 32]).join('');
}

export const newRequestId = () => `req_${random(26)}`;
export const newCorrelationId = () => `cor_${random(26)}`;

export function newSupportReference(now = new Date()) {
  const ymd = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kuala_Lumpur', year: 'numeric', month: '2-digit', day: '2-digit' })
    .format(now).replaceAll('-', '');
  return `SEMAK-ERR-${ymd}-${random(5)}`;
}

export const SUPPORT_REFERENCE = /^SEMAK-ERR-\d{8}-[0-9A-HJKMNP-TV-Z]{5}$/;
