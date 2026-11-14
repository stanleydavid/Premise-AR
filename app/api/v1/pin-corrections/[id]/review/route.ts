import { z } from 'zod';
import { jsonBody, ok, route } from '@/lib/http/api';
import { PinReviewInput, reviewPin } from '@/lib/domain/inspections';

export const dynamic = 'force-dynamic';

export const POST = route<{ id: string }>('pins:review', async ({ request, session, ids, params }) =>
  ok(await reviewPin(session, z.uuid().parse(params.id), PinReviewInput.parse(await jsonBody(request)), ids), ids));
