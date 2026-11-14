import 'server-only';
import { NextResponse, type NextRequest } from 'next/server';
import * as Sentry from '@sentry/nextjs';
import { logger } from '@/lib/observability/logger';
import { absoluteUrl } from '@/lib/http/origin';
import { newCorrelationId, newSupportReference } from '@/lib/observability/ids';
import { stableErrorCode } from '@/lib/http/api';

type Handler = (request: NextRequest) => Promise<Response>;

/**
 * Browser-navigation route (login, callback, logout). An unhandled exception never reaches the
 * browser as raw output: it is logged with a support reference and the user lands on /login with it.
 */
export function navigationRoute(handler: Handler): Handler {
  return async (request) => {
    try {
      return await handler(request);
    } catch (error) {
      const supportReference = newSupportReference();
      const correlationId = request.headers.get('x-correlation-id') || newCorrelationId();
      logger.error('route.navigation_failed', error, {
        supportReferenceId: supportReference, correlationId, requestId: request.headers.get('x-request-id') ?? undefined,
        operation: request.nextUrl.pathname, result: 'failed', errorCode: stableErrorCode(500),
      });
      Sentry.captureException(error, { tags: { support_reference_id: supportReference, correlation_id: correlationId } });
      const response = NextResponse.redirect(absoluteUrl(request, `/login?error=server&ref=${encodeURIComponent(supportReference)}`), 303);
      response.headers.set('x-support-reference', supportReference);
      response.headers.set('cache-control', 'no-store');
      return response;
    }
  };
}
