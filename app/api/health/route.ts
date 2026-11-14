import { NextResponse, type NextRequest } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { can } from '@/lib/auth/roles';
import { live, readiness } from '@/lib/observability/health';
import { auditBestEffort } from '@/lib/audit';
import { idsOf } from '@/lib/http/api';

export const dynamic = 'force-dynamic';

/** Detailed health for signed-in administrators (viewing is audited); everyone else gets liveness only. */
export async function GET(request: NextRequest) {
  const session = await getSession().catch(() => null);
  if (!session || !can(session.role, 'health:detail')) return NextResponse.json(live(), { headers: { 'cache-control': 'no-store' } });
  const r = await readiness();
  await auditBestEffort({ eventName: 'diagnostics.health_viewed', actor: session, action: 'VIEW', entityType: 'service', entityId: r.service, result: r.status, ...idsOf(request) });
  return NextResponse.json(r, { status: r.status === 'unavailable' ? 503 : 200, headers: { 'cache-control': 'no-store' } });
}
