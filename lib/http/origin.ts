/**
 * Redirects must stay on the host the browser actually used.
 *
 * `new URL('/path', request.url)` looks correct but Next.js dev reconstructs
 * `request.url` as `http://localhost:3000/...` regardless of the Host header,
 * so every redirect sent a LAN visitor to their own machine.
 */
import type { NextRequest } from 'next/server';

export function requestOrigin(request: NextRequest): string {
  // P0-04: behind FortiGate/Caddy the public address is configuration, not a header guess.
  const configured = process.env.APP_URL || process.env.NEXT_PUBLIC_APP_URL;
  if (configured) {
    try { return new URL(configured).origin; } catch { /* fall back to headers below */ }
  }
  const forwardedHost = request.headers.get('x-forwarded-host');
  const host = forwardedHost?.split(',')[0]?.trim() || request.headers.get('host');
  if (!host) return new URL(request.url).origin;
  const forwardedProto = request.headers.get('x-forwarded-proto')?.split(',')[0]?.trim();
  const proto = forwardedProto || new URL(request.url).protocol.replace(':', '') || 'http';
  return `${proto}://${host}`;
}

/** Absolute URL on the caller's own origin. */
export function absoluteUrl(request: NextRequest, path: string): URL {
  return new URL(path, requestOrigin(request));
}
