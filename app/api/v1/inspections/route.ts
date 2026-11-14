import { DomainError, jsonBody, ok, route } from '@/lib/http/api';
import { IdempotencyKey, InspectionInput, InspectionListQuery, createInspection, listInspections } from '@/lib/domain/inspections';

export const dynamic = 'force-dynamic';

/**
 * POST with header Idempotency-Key (16–64 chars, one per inspection, created on the phone).
 * 201 created; 200 replay of the same request; 409 IDEMPOTENCY_KEY_REUSED when the key carries other content.
 */
export const POST = route('inspections:create', async ({ request, session, ids }) => {
  const key = IdempotencyKey.safeParse(request.headers.get('idempotency-key'));
  if (!key.success) throw new DomainError('IDEMPOTENCY_KEY_REQUIRED', 400);
  const result = await createInspection(session, key.data, InspectionInput.parse(await jsonBody(request)), ids);
  return ok(result, ids, result.replayed ? 200 : 201);
});

/** GET ?scope=mine|all&outcome=&premise_id=&before=&limit= ("all" needs the supervisor permission). */
export const GET = route('inspections:read_own', async ({ request, session, ids }) => {
  const q = InspectionListQuery.parse(Object.fromEntries(request.nextUrl.searchParams));
  return ok({ inspections: await listInspections(session, q) }, ids);
});
