import 'server-only';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile, access, constants } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { queryOne, withTransaction } from '@/lib/db/pg';
import { auditTx } from '@/lib/audit';
import { DomainError, type RequestIds } from '@/lib/http/api';
import type { AppSession } from '@/lib/auth/session';
import { can } from '@/lib/auth/roles';

export const MAX_PHOTO_BYTES = 2_500_000;

/** Storage root on the application server (a mounted volume on the PDKN VM). */
export const storageRoot = () => path.resolve(/*turbopackIgnore: true*/ process.env.PHOTO_STORAGE_DIR || './storage/photos');

export async function storageWritable() {
  try { await mkdir(storageRoot(), { recursive: true }); await access(storageRoot(), constants.W_OK); return true; } catch { return false; }
}

/** The bytes decide the type, not the client's header. */
export function sniffImage(bytes: Uint8Array): 'image/jpeg' | 'image/webp' | null {
  if (bytes.length > 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  if (bytes.length > 12 && String.fromCharCode(...bytes.slice(0, 4)) === 'RIFF' && String.fromCharCode(...bytes.slice(8, 12)) === 'WEBP') return 'image/webp';
  return null;
}

export const PhotoMeta = z.object({
  taken_at: z.iso.datetime({ offset: true }).optional(),
  lat: z.number().min(-90).max(90).optional(),
  lng: z.number().min(-180).max(180).optional(),
  accuracy_m: z.number().min(0).max(100_000).optional(),
  heading: z.number().min(0).max(360).optional(),
}).strict();

export type StoredPhoto = { id: string; sha256: string; size_bytes: number; content_type: string; duplicate: boolean };

/** Store a photo for the officer. The same bytes from the same officer return the existing row (retry-safe). */
export async function savePhoto(session: AppSession, bytes: Uint8Array, meta: z.infer<typeof PhotoMeta>, ids: RequestIds): Promise<StoredPhoto> {
  if (bytes.length === 0) throw new DomainError('PHOTO_EMPTY', 400);
  if (bytes.length > MAX_PHOTO_BYTES) throw new DomainError('PHOTO_TOO_LARGE', 413, { max_bytes: MAX_PHOTO_BYTES });
  const contentType = sniffImage(bytes);
  if (!contentType) throw new DomainError('PHOTO_TYPE_NOT_ALLOWED', 415);
  const sha256 = createHash('sha256').update(bytes).digest('hex');

  const existing = await queryOne<{ id: string; size_bytes: number; content_type: string }>(
    'select id, size_bytes, content_type from photos where uploaded_by = $1 and sha256 = $2', [session.userId, sha256]);
  if (existing) return { ...existing, sha256, duplicate: true };

  const now = new Date();
  const key = `${now.getUTCFullYear()}/${String(now.getUTCMonth() + 1).padStart(2, '0')}/${randomUUID()}.${contentType === 'image/jpeg' ? 'jpg' : 'webp'}`;
  const file = path.join(/*turbopackIgnore: true*/ storageRoot(), key);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(`${file}.part`, bytes, { flag: 'wx' });
  await rename(`${file}.part`, file);

  return withTransaction(async (db) => {
    const row = await queryOne<{ id: string }>(
      `insert into photos (uploaded_by, sha256, content_type, size_bytes, storage_key, taken_at, lat, lng, accuracy_m, heading)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
       on conflict (uploaded_by, sha256) do nothing returning id`,
      [session.userId, sha256, contentType, bytes.length, key, meta.taken_at ?? null, meta.lat ?? null, meta.lng ?? null, meta.accuracy_m ?? null, meta.heading ?? null], db);
    if (!row) {
      // A concurrent retry stored the same photo first; use that one (the orphan file is harmless).
      const winner = await queryOne<{ id: string }>('select id from photos where uploaded_by = $1 and sha256 = $2', [session.userId, sha256], db);
      return { id: winner!.id, sha256, size_bytes: bytes.length, content_type: contentType, duplicate: true };
    }
    await auditTx(db, { eventName: 'photo.uploaded', actor: session, action: 'CREATE', entityType: 'photo', entityId: row.id, result: 'success',
      after: { sha256, size_bytes: bytes.length, content_type: contentType }, ...ids });
    return { id: row.id, sha256, size_bytes: bytes.length, content_type: contentType, duplicate: false };
  });
}

/** Read a photo: its uploader, or a supervisor/administrator who can read all inspections. */
export async function readPhoto(session: AppSession, id: string) {
  const row = await queryOne<{ uploaded_by: string; storage_key: string; content_type: string; sha256: string }>(
    'select uploaded_by, storage_key, content_type, sha256 from photos where id = $1', [id]);
  if (!row) throw new DomainError('PHOTO_NOT_FOUND', 404);
  if (row.uploaded_by !== session.userId && !can(session.role, 'inspections:read_all')) throw new DomainError('PHOTO_NOT_FOUND', 404);
  const file = path.join(/*turbopackIgnore: true*/ storageRoot(), row.storage_key);
  if (!file.startsWith(storageRoot() + path.sep)) throw new DomainError('PHOTO_NOT_FOUND', 404);
  const bytes = await readFile(file).catch(() => { throw new DomainError('PHOTO_FILE_MISSING', 404); });
  return { bytes, contentType: row.content_type, sha256: row.sha256 };
}
