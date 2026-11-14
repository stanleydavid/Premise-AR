import 'server-only';
import { createCipheriv, createDecipheriv, createHmac, randomBytes } from 'node:crypto';

/**
 * Seals small secrets before they leave the server (the DBKK ID id_token kept in an HTTP-only cookie
 * for RP-initiated logout). AES-256-GCM; key from SETTINGS_ENCRYPTION_KEY, else derived from
 * SESSION_SECRET. Format: v1.<iv>.<tag>.<ciphertext> (base64url).
 */
function key() {
  const base = process.env.SETTINGS_ENCRYPTION_KEY || process.env.SESSION_SECRET;
  if (!base || base.length < 32) throw new Error('SETTINGS_ENCRYPTION_KEY_NOT_CONFIGURED');
  return createHmac('sha256', base).update('semak-premis-sealed-v1').digest();
}

export function sealSecret(plain: string) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key(), iv);
  const data = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  return ['v1', iv.toString('base64url'), cipher.getAuthTag().toString('base64url'), data.toString('base64url')].join('.');
}

export function openSecret(sealed: string) {
  const [version, iv, tag, data] = sealed.split('.');
  if (version !== 'v1' || !iv || !tag || !data) throw new Error('SEALED_SECRET_MALFORMED');
  const decipher = createDecipheriv('aes-256-gcm', key(), Buffer.from(iv, 'base64url'));
  decipher.setAuthTag(Buffer.from(tag, 'base64url'));
  return Buffer.concat([decipher.update(Buffer.from(data, 'base64url')), decipher.final()]).toString('utf8');
}
