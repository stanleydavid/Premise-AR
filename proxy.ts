import { NextRequest, NextResponse } from 'next/server';
import { newCorrelationId, newRequestId } from '@/lib/observability/ids';
import { SESSION_COOKIE } from '@/lib/product';

const REQUEST_ID = 'x-request-id';
const CORRELATION_ID = 'x-correlation-id';
const MUTATING_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/**
 * Per-client rate limits for the paths that are cheap to spam and expensive to serve.
 */
const RATE_LIMITS: Array<{ pattern: RegExp; limit: number; windowMs: number }> = [
  { pattern: /^\/api\/auth\//, limit: 20, windowMs: 60_000 },
  { pattern: /^\/api\/v1\/photos$/, limit: 120, windowMs: 60_000 },
];

/** Photos are resized on the phone to ~1600 px JPEG (well under 3 MB); imports allow 5 MB of CSV. */
const MAX_BODY_BYTES = 1_000_000;
const LARGE_BODY: Array<{ pattern: RegExp; max: number }> = [
  { pattern: /^\/api\/v1\/photos$/, max: 3_000_000 },
  { pattern: /^\/api\/v1\/admin\/import$/, max: 5_000_000 },
];
const PROTECTED = /^\/(periksa|semakan|admin)(\/|$)/;

type Bucket = { count: number; resetAt: number };

// Per-instance buckets. A single gateway serves this app; if it is ever scaled out this has to
// move to Redis, otherwise each instance enforces its own allowance.
const buckets = new Map<string, Bucket>();

function clientKey(request: NextRequest) {
  const forwarded = request.headers.get('x-forwarded-for');
  const ip = forwarded ? forwarded.split(',')[0].trim() : request.headers.get('x-real-ip') ?? 'unknown';
  return `${ip}:${request.nextUrl.pathname.replace(/[0-9a-f-]{36}/gi, ':id')}`;
}

function rateLimited(key: string, limit: number, windowMs: number) {
  const now = Date.now();
  const existing = buckets.get(key);
  if (!existing || existing.resetAt <= now) {
    buckets.set(key, { count: 1, resetAt: now + windowMs });
    return false;
  }
  existing.count += 1;
  return existing.count > limit;
}

function validHeaderId(value: string | null) {
  if (!value) return null;
  const trimmed = value.trim();
  if (trimmed.length < 8 || trimmed.length > 128) return null;
  return /^[A-Za-z0-9._:-]+$/.test(trimmed) ? trimmed : null;
}

/**
 * Request origin as the browser sees it.
 *
 * Behind a reverse proxy or Cloudflare Tunnel, Next.js reconstructs
 * `request.nextUrl.origin` from the listener (e.g. `http://localhost:3000`),
 * so comparing a browser Origin header against it rejected every legitimate
 * same-site POST. Prefer the forwarded headers, then the app's configured URL.
 */
function publicOrigin(request: NextRequest): string | null {
  const forwardedHost = request.headers.get('x-forwarded-host')?.split(',')[0]?.trim();
  const forwardedProto = request.headers.get('x-forwarded-proto')?.split(',')[0]?.trim();
  if (forwardedHost) return `${forwardedProto || 'https'}://${forwardedHost}`;

  const host = request.headers.get('host');
  if (host && !/^(localhost|127\.0\.0\.1)(:\d+)?$/i.test(host)) {
    const proto = forwardedProto || new URL(request.url).protocol.replace(':', '');
    return `${proto}://${host}`;
  }

  for (const candidate of [
    process.env.NEXT_PUBLIC_APP_URL,
    process.env.APP_URL,
    host ? `http://${host}` : null,
    new URL(request.url).origin,
  ]) {
    if (candidate) {
      try {
        return new URL(candidate).origin;
      } catch {
        /* ignore malformed */
      }
    }
  }
  return null;
}

function crossOriginBrowserMutation(request: NextRequest) {
  if (!request.nextUrl.pathname.startsWith('/api/') || !MUTATING_METHODS.has(request.method)) return false;
  const origin = request.headers.get('origin');
  if (!origin) return false; // server-to-server/curl requests do not normally send Origin.
  let callerOrigin: string;
  try {
    callerOrigin = new URL(origin).origin;
  } catch {
    return true;
  }
  const expected = publicOrigin(request);
  if (!expected) return true;
  return callerOrigin !== expected;
}

/**
 * Content-Security-Policy with a per-request nonce. Next injects the nonce into its own inline bootstrap
 * scripts when it sees the nonce in the CSP on the request headers, and `strict-dynamic` lets those scripts
 * load the chunked runtime; nothing else may run inline. `style-src 'unsafe-inline'` is required because the
 * UI uses inline style attributes. No third-party script/style/frame origins are allowed.
 */
function contentSecurityPolicy(nonce: string) {
  return [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self'",
    "connect-src 'self'",
    "worker-src 'self'",
    "media-src 'self' blob:",
    "manifest-src 'self'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
    'upgrade-insecure-requests',
  ].join('; ');
}

function applySecurityHeaders(response: NextResponse, requestId: string, correlationId: string, csp?: string) {
  response.headers.set(REQUEST_ID, requestId);
  response.headers.set(CORRELATION_ID, correlationId);
  response.headers.set('x-content-type-options', 'nosniff');
  response.headers.set('x-frame-options', 'DENY');
  response.headers.set('referrer-policy', 'strict-origin-when-cross-origin');
  // The field view needs the camera, GPS and compass on our own origin only.
  response.headers.set('permissions-policy', 'camera=(self), geolocation=(self), accelerometer=(self), gyroscope=(self), magnetometer=(self), microphone=()');
  response.headers.set('cross-origin-opener-policy', 'same-origin');
  response.headers.set('cross-origin-resource-policy', 'same-origin');
  if (csp) response.headers.set('content-security-policy', csp);
  if (process.env.NODE_ENV === 'production') {
    response.headers.set('strict-transport-security', 'max-age=31536000; includeSubDomains');
  }
  return response;
}

export function proxy(request: NextRequest) {
  const requestHeaders = new Headers(request.headers);
  // EarthOps: every request gets a request_id (an upstream proxy's id is kept if well-formed); the
  // correlation_id is always generated here, because a public caller must not choose it.
  const requestId = validHeaderId(requestHeaders.get(REQUEST_ID)) ?? newRequestId();
  const correlationId = newCorrelationId();

  const declaredLength = Number(request.headers.get('content-length') ?? '0');
  const maxBody = LARGE_BODY.find((rule) => rule.pattern.test(request.nextUrl.pathname))?.max ?? MAX_BODY_BYTES;
  if (Number.isFinite(declaredLength) && declaredLength > maxBody) {
    return applySecurityHeaders(
      NextResponse.json({ error: 'PAYLOAD_TOO_LARGE', requestId }, { status: 413 }),
      requestId,
      correlationId,
    );
  }

  for (const rule of RATE_LIMITS) {
    if (!rule.pattern.test(request.nextUrl.pathname)) continue;
    if (rateLimited(clientKey(request), rule.limit, rule.windowMs)) {
      return applySecurityHeaders(
        NextResponse.json(
          { error: 'RATE_LIMITED', requestId },
          { status: 429, headers: { 'retry-after': '60' } },
        ),
        requestId,
        correlationId,
      );
    }
    break;
  }

  if (crossOriginBrowserMutation(request)) {
    return applySecurityHeaders(
      NextResponse.json({ error: 'CROSS_ORIGIN_MUTATION_REJECTED', requestId }, { status: 403 }),
      requestId,
      correlationId,
    );
  }

  // EarthID seamless SSO: an unauthenticated deep link to a protected page goes to sign-in and comes
  // back to the same page afterwards (returnTo is sanitised again at /login and /api/auth/*).
  if (request.method === 'GET' && PROTECTED.test(request.nextUrl.pathname) && !request.cookies.get(SESSION_COOKIE)) {
    const login = new URL('/login', request.url);
    login.searchParams.set('returnTo', request.nextUrl.pathname + request.nextUrl.search);
    return applySecurityHeaders(NextResponse.redirect(login, 307), requestId, correlationId);
  }

  requestHeaders.set(REQUEST_ID, requestId);
  requestHeaders.set(CORRELATION_ID, correlationId);

  // Per-request CSP nonce: set it on the request so Next tags its inline scripts, and on the response so the
  // browser enforces it. Only HTML navigations need it; it is harmless on other responses.
  const nonce = Buffer.from(crypto.randomUUID()).toString('base64');
  const csp = contentSecurityPolicy(nonce);
  requestHeaders.set('x-nonce', nonce);
  requestHeaders.set('content-security-policy', csp);

  const response = NextResponse.next({ request: { headers: requestHeaders } });
  return applySecurityHeaders(response, requestId, correlationId, csp);
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico|icon-.*\\.png|manifest.webmanifest).*)'],
};
