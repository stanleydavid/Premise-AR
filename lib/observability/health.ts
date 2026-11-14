import 'server-only';
import { queryOne } from '@/lib/db/pg';
import { logger } from '@/lib/observability/logger';
import { storageWritable } from '@/lib/domain/photos';
import { SERVICE } from '@/lib/product';

/**
 * EarthOps health (docs/health-checks.md): status ok | degraded | unavailable, service, version, timestamp.
 * Critical (→ unavailable): database + PostGIS, session secret, photo storage, DBKK ID config in production.
 * Non-critical (→ degraded): DBKK ID outside production, NRIC HMAC secret (only needed to register by IC).
 */
export type HealthStatus = 'ok' | 'degraded' | 'unavailable';
type Check = { status: HealthStatus; detail?: string };

export const VERSION = () => process.env.APP_VERSION ?? 'development';
export const live = () => ({ status: 'ok' as HealthStatus, service: SERVICE, version: VERSION(), timestamp: new Date().toISOString() });

export async function readiness() {
  const production = process.env.APP_ENV === 'production';
  const checks: Record<string, Check> = {};
  const earthId = Boolean(process.env.EARTHID_ISSUER && process.env.EARTHID_CLIENT_ID && process.env.EARTHID_CLIENT_SECRET && process.env.EARTHID_REDIRECT_URI);
  checks.identity = earthId ? { status: 'ok' } : { status: production ? 'unavailable' : 'degraded', detail: 'DBKK ID (EARTHID_*) not configured' };
  checks.session_secret = (process.env.SESSION_SECRET?.length ?? 0) >= 32 ? { status: 'ok' } : { status: 'unavailable', detail: 'SESSION_SECRET missing or short' };
  checks.nric_hmac_secret = (process.env.NRIC_HMAC_SECRET?.length ?? 0) >= 32 ? { status: 'ok' } : { status: 'degraded', detail: 'NRIC_HMAC_SECRET missing: officers can only be linked by e-mail' };
  checks.photo_storage = (await storageWritable()) ? { status: 'ok' } : { status: 'unavailable', detail: 'PHOTO_STORAGE_DIR not writable' };
  try {
    const db = await queryOne<{ postgis: string | null; superuser: boolean }>(
      `select (select extversion from pg_extension where extname = 'postgis') postgis, (select rolsuper from pg_roles where rolname = current_user) superuser`);
    checks.database = db?.postgis ? { status: 'ok' } : { status: 'unavailable', detail: 'PostGIS extension missing' };
    if (production && db?.superuser) checks.database_role = { status: 'degraded', detail: 'app connects as a superuser; use semak_app' };
  } catch {
    checks.database = { status: 'unavailable', detail: 'unreachable' };
  }
  const values = Object.values(checks).map((c) => c.status);
  const status: HealthStatus = values.includes('unavailable') ? 'unavailable' : values.includes('degraded') ? 'degraded' : 'ok';
  if (status !== 'ok') logger.warn('health.not_ok', { status, checks: Object.fromEntries(Object.entries(checks).filter(([, c]) => c.status !== 'ok')) });
  return { ...live(), status, checks, integrations: { sentry: process.env.SENTRY_DSN ? 'configured' : 'disabled' } };
}

export const publicHealth = (r: { status: HealthStatus; service: string; version: string; timestamp: string }) =>
  ({ status: r.status, service: r.service, version: r.version, timestamp: r.timestamp });
