import { z } from 'zod';
import { route } from '@/lib/http/api';
import { readPhoto } from '@/lib/domain/photos';

export const dynamic = 'force-dynamic';

export const GET = route<{ id: string }>('premises:read', async ({ session, params }) => {
  const photo = await readPhoto(session, z.uuid().parse(params.id));
  return new Response(new Uint8Array(photo.bytes), {
    headers: { 'content-type': photo.contentType, 'cache-control': 'private, max-age=86400, immutable', etag: `"${photo.sha256}"`, 'x-content-type-options': 'nosniff' },
  });
});
