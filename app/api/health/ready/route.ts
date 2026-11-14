import { NextResponse } from 'next/server';
import { publicHealth, readiness } from '@/lib/observability/health';

export const dynamic = 'force-dynamic';

/** Readiness (public, minimal body). 503 when a critical dependency is unavailable; details go to the log. */
export async function GET() {
  const r = await readiness();
  return NextResponse.json(publicHealth(r), { status: r.status === 'unavailable' ? 503 : 200, headers: { 'cache-control': 'no-store' } });
}
