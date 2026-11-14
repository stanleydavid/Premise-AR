import { DomainError, ok, route } from '@/lib/http/api';
import { PhotoMeta, savePhoto } from '@/lib/domain/photos';

export const dynamic = 'force-dynamic';

/**
 * POST multipart/form-data: file (JPEG/WebP, ≤ 2.5 MB), meta (JSON: taken_at, lat, lng, accuracy_m, heading).
 * Uploading the same bytes again returns the same photo id (200 instead of 201).
 */
export const POST = route('inspections:create', async ({ request, session, ids }) => {
  const form = await request.formData().catch(() => { throw new DomainError('BODY_NOT_MULTIPART', 400); });
  const file = form.get('file');
  if (!(file instanceof Blob)) throw new DomainError('PHOTO_REQUIRED', 400);
  let meta: unknown = {};
  const rawMeta = form.get('meta');
  if (typeof rawMeta === 'string' && rawMeta) {
    try { meta = JSON.parse(rawMeta); } catch { throw new DomainError('PHOTO_META_NOT_JSON', 400); }
  }
  const saved = await savePhoto(session, new Uint8Array(await file.arrayBuffer()), PhotoMeta.parse(meta), ids);
  return ok(saved, ids, saved.duplicate ? 200 : 201);
});
