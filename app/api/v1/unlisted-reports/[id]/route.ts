import { z } from 'zod';
import { jsonBody, ok, route } from '@/lib/http/api';
import { UnlistedStatusInput, updateUnlistedStatus } from '@/lib/domain/inspections';

export const dynamic = 'force-dynamic';

export const PATCH = route<{ id: string }>('reports:manage', async ({ request, session, ids, params }) =>
  ok(await updateUnlistedStatus(session, z.uuid().parse(params.id), UnlistedStatusInput.parse(await jsonBody(request)), ids), ids));
