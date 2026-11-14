import 'server-only';
import * as Sentry from '@sentry/nextjs';
import { query, type Db } from '@/lib/db/pg';
import { logger } from '@/lib/observability/logger';

/**
 * EarthOps audit event (schemas/audit-event.schema.json). Stored in audit_events, which database
 * triggers make append-only. Pass `db` (a transaction client) so the audited change and its audit
 * row commit together: then the change cannot happen without its audit row.
 */
export type AuditInput = {
  eventName: string;
  actor?: { userId: string; sub: string; role: string } | null;
  action: string;
  entityType: string;
  entityId: string;
  result: string;
  reason?: string | null;
  before?: unknown;
  after?: unknown;
  requestId?: string | null;
  correlationId?: string | null;
};

const INSERT = `insert into audit_events
  (event_name, actor_id, earthid_subject, actor_role, action, entity_type, entity_id, result, reason, before, after, request_id, correlation_id)
  values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`;

function params(input: AuditInput) {
  return [
    input.eventName, input.actor?.userId ?? null, input.actor?.sub ?? null, input.actor?.role ?? null,
    input.action, input.entityType, input.entityId, input.result, input.reason ?? null,
    input.before === undefined ? null : JSON.stringify(input.before),
    input.after === undefined ? null : JSON.stringify(input.after),
    input.requestId ?? null, input.correlationId ?? null,
  ];
}

/** Audit inside a transaction: a failure throws and rolls the change back. */
export async function auditTx(db: Db, input: AuditInput) {
  await query(INSERT, params(input), db);
}

/**
 * Audit for actions that already happened and must not be undone by an audit outage (login,
 * logout). A failed write is logged and reported, then the request goes on.
 */
export async function auditBestEffort(input: AuditInput) {
  try {
    await query(INSERT, params(input));
  } catch (error) {
    logger.error('audit.write_failed', error, { auditEvent: input.eventName, entityType: input.entityType, requestId: input.requestId, correlationId: input.correlationId });
    Sentry.captureException(error, { tags: { audit_event: input.eventName } });
  }
}
