import { DomainError, ok, route } from '@/lib/http/api';
import { importPremises } from '@/lib/domain/admin';

export const dynamic = 'force-dynamic';

/**
 * POST text/csv (UTF-8) with the columns in IMPORT_COLUMNS. ?dry_run=true validates only.
 * All-or-nothing: if any row is invalid nothing is written and every error is listed by line.
 */
export const POST = route('premises:import', async ({ request, session, ids }) => {
  const type = request.headers.get('content-type') ?? '';
  if (!/^text\/(csv|plain)/.test(type)) throw new DomainError('IMPORT_NOT_CSV', 415);
  const report = await importPremises(session, await request.text(), request.nextUrl.searchParams.get('dry_run') === 'true', ids);
  return ok(report, ids, report.errors.length ? 422 : 200);
});
