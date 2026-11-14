import { NextResponse } from 'next/server';
import { live } from '@/lib/observability/health';

export const dynamic = 'force-dynamic';

/** Liveness: the process answers. No dependency calls. */
export function GET() {
  return NextResponse.json(live(), { headers: { 'cache-control': 'no-store' } });
}
