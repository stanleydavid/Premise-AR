import 'server-only';
import { NextResponse, type NextRequest } from 'next/server';
import * as Sentry from '@sentry/nextjs';
import { ZodError } from 'zod';
import { logger } from '@/lib/observability/logger';
import { newCorrelationId, newRequestId, newSupportReference } from '@/lib/observability/ids';
import { requirePermission, requireSession, type AppSession } from '@/lib/auth/session';
import type { Permission } from '@/lib/auth/roles';
import { PRODUCT_CODE } from '@/lib/product';

/** A known, user-facing failure with a stable code (e.g. PREMISE_NOT_FOUND → 404). */
export class DomainError extends Error {
  constructor(public code: string, public status: number, public details?: Record<string, unknown>) {
    super(code); this.name = 'DomainError';
  }
}

/** Stable EarthOps codes (<PRODUCT>-<CATEGORY>-<NUMBER>) by HTTP status; `error` keeps the precise code. */
const STABLE: Record<number, string> = {
  400: 'VAL-001', 401: 'AUTH-001', 403: 'AUTH-002', 404: 'DATA-404', 409: 'STATE-001', 413: 'FILE-001',
  415: 'FILE-002', 422: 'VAL-002', 429: 'RATE-001', 500: 'SYS-001', 502: 'DEP-001', 503: 'DEP-002',
};
export const stableErrorCode = (status: number) => `${PRODUCT_CODE}-${STABLE[status] ?? `HTTP-${status}`}`;

export type RequestIds = { requestId: string; correlationId: string };

/** request_id / correlation_id are set by proxy.ts at ingress; generated here only if absent (tests). */
export function idsOf(request: Request): RequestIds {
  return {
    requestId: request.headers.get('x-request-id') ?? newRequestId(),
    correlationId: request.headers.get('x-correlation-id') ?? newCorrelationId(),
  };
}

const NO_STORE = { 'cache-control': 'no-store' };

export function ok(data: unknown, ids: RequestIds, status = 200) {
  return NextResponse.json({ data, request_id: ids.requestId, correlation_id: ids.correlationId }, { status, headers: NO_STORE });
}

export function failure(error: unknown, ids: RequestIds, operation: string) {
  let status = 500, code = 'INTERNAL_ERROR', details: Record<string, unknown> | undefined;
  if (error instanceof DomainError) { status = error.status; code = error.code; details = error.details; }
  else if (error instanceof ZodError) {
    status = 422; code = 'VALIDATION_FAILED';
    details = { fields: error.issues.slice(0, 20).map((i) => ({ path: i.path.join('.'), message: i.message })) };
  } else if (error instanceof Error && error.message === 'UNAUTHENTICATED') { status = 401; code = 'UNAUTHENTICATED'; }
  else if (error instanceof Error && error.message === 'FORBIDDEN') { status = 403; code = 'FORBIDDEN'; }

  const body: Record<string, unknown> = {
    error: code, error_code: stableErrorCode(status), request_id: ids.requestId, correlation_id: ids.correlationId, ...details,
  };
  const headers: Record<string, string> = { ...NO_STORE };
  if (status === 500) {
    // Unknown failure: no detail to the client, only a support reference mapped in the log.
    const supportReference = newSupportReference();
    body.support_reference = supportReference;
    headers['x-support-reference'] = supportReference;
    logger.error('api.unhandled_error', error, { ...ids, supportReferenceId: supportReference, operation, errorCode: body.error_code, result: 'failed' });
    Sentry.captureException(error, { tags: { support_reference_id: supportReference, correlation_id: ids.correlationId } });
  } else if (status === 401 || status === 403) {
    logger.warn('api.access_denied', { ...ids, operation, errorCode: body.error_code, result: code.toLowerCase() });
  } else {
    // Business validation failures are not errors (EarthOps §7).
    logger.info('api.request_rejected', { ...ids, operation, errorCode: body.error_code, result: code.toLowerCase() });
  }
  return NextResponse.json(body, { status, headers });
}

type Ctx<P> = { request: NextRequest; session: AppSession; ids: RequestIds; params: P };

/**
 * Authenticated JSON route. `permission` is checked server-side before the handler runs.
 * Usage: export const GET = route('premises:read', async ({ request, session, ids }) => ok(..., ids));
 */
export function route<P = Record<string, never>>(permission: Permission | null, handler: (ctx: Ctx<P>) => Promise<Response>) {
  return async (request: NextRequest, context?: { params?: Promise<P> }) => {
    const ids = idsOf(request);
    const operation = `${request.method} ${request.nextUrl.pathname.replace(/[0-9a-f-]{36}/gi, ':id')}`;
    try {
      const session = permission ? await requirePermission(permission) : await requireSession();
      const params = (context?.params ? await context.params : {}) as P;
      return await handler({ request, session, ids, params });
    } catch (error) {
      return failure(error, ids, operation);
    }
  };
}

/** Parse a JSON body; malformed JSON is a 400, not a 500. */
export async function jsonBody(request: Request): Promise<unknown> {
  try { return await request.json(); } catch { throw new DomainError('BODY_NOT_JSON', 400); }
}
