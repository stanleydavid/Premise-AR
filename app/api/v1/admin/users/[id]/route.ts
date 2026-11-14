import { z } from 'zod';
import { jsonBody, ok, route } from '@/lib/http/api';
import { UserUpdate, updateUser } from '@/lib/domain/admin';

export const dynamic = 'force-dynamic';

export const PATCH = route<{ id: string }>('users:manage', async ({ request, session, ids, params }) =>
  ok(await updateUser(session, z.uuid().parse(params.id), UserUpdate.parse(await jsonBody(request)), ids), ids));
