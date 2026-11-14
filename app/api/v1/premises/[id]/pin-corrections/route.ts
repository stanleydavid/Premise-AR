import { z } from 'zod';
import { jsonBody, ok, route } from '@/lib/http/api';
import { PinInput, suggestPin } from '@/lib/domain/inspections';

export const dynamic = 'force-dynamic';

/** An officer standing at the premise suggests its correct position; a supervisor reviews it. */
export const POST = route<{ id: string }>('pins:suggest', async ({ request, session, ids, params }) => {
  const id = z.uuid().parse(params.id);
  return ok(await suggestPin(session, id, PinInput.parse(await jsonBody(request)), ids), ids, 201);
});
