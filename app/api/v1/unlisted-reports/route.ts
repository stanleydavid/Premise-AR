import { z } from 'zod';
import { DomainError, jsonBody, ok, route } from '@/lib/http/api';
import { IdempotencyKey, UnlistedInput, createUnlistedReport, listUnlistedReports } from '@/lib/domain/inspections';

export const dynamic = 'force-dynamic';

export const POST = route('reports:create', async ({ request, session, ids }) => {
  const key = IdempotencyKey.safeParse(request.headers.get('idempotency-key'));
  if (!key.success) throw new DomainError('IDEMPOTENCY_KEY_REQUIRED', 400);
  const result = await createUnlistedReport(session, key.data, UnlistedInput.parse(await jsonBody(request)), ids);
  return ok(result, ids, result.replayed ? 200 : 201);
});

/** Officers see their own reports; supervisors and administrators see all. */
export const GET = route('reports:create', async ({ request, session, ids }) => {
  const status = z.enum(['baru', 'disiasat', 'ditutup']).optional().parse(request.nextUrl.searchParams.get('status') ?? undefined);
  return ok({ reports: await listUnlistedReports(session, status) }, ids);
});
