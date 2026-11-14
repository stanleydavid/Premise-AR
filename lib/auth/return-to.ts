/**
 * EarthID seamless SSO (earthops-standards docs/sso/earthid-seamless-sso-standard.md §6): only a
 * relative path on this site may be a post-login destination; anything else falls back to /periksa.
 */
export function sanitizeReturnTo(value: string | null | undefined, fallback = '/periksa') {
  if (!value || value.length > 512) return fallback;
  if (!value.startsWith('/') || value.startsWith('//') || value.startsWith('/\\')) return fallback;
  if (/[\u0000-\u001f]/.test(value) || /^\/api\//.test(value) || value.startsWith('/login')) return fallback;
  return value;
}
