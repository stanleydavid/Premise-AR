import 'server-only';
import { SERVICE } from '@/lib/product';

type LogLevel = 'debug' | 'info' | 'warn' | 'error';
type Fields = Record<string, unknown>;

const SENSITIVE_KEYS = /(authorization|cookie|token|secret|password|apikey|api_key|nric|mykad|identity_number)/i;

function redact(value: unknown, depth = 0): unknown {
  if (depth > 5) return '[MAX_DEPTH]';
  if (Array.isArray(value)) return value.slice(0, 50).map((item) => redact(item, depth + 1));
  if (value && typeof value === 'object') {
    const output: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>).slice(0, 100)) {
      output[key] = SENSITIVE_KEYS.test(key) ? '[REDACTED]' : redact(item, depth + 1);
    }
    return output;
  }
  if (typeof value === 'string' && value.length > 4000) return `${value.slice(0, 4000)}...[TRUNCATED]`;
  return value;
}

function serialiseError(error: unknown) {
  if (!(error instanceof Error)) return redact(error);
  return {
    name: error.name,
    message: error.message,
    ...(process.env.APP_ENV !== 'production' && error.stack ? { stack: error.stack } : {}),
  };
}

function shouldLog(level: LogLevel) {
  const configured = (process.env.LOG_LEVEL ?? 'info').toLowerCase();
  const weight: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };
  const threshold = configured in weight ? weight[configured as LogLevel] : 20;
  return weight[level] >= threshold;
}

/**
 * EarthOps log-event schema (earthops-standards/schemas/log-event.schema.json): timestamp, level
 * (DEBUG|INFO|WARN|ERROR|FATAL), service, environment, event_name (lowercase dotted), plus
 * snake_case context fields (request_id, correlation_id, support_reference_id, error_code …).
 */
export function eventName(event: string) {
  if (/^[a-z0-9_]+(\.[a-z0-9_]+)+$/.test(event)) return event;
  const parts = event.toLowerCase().split('_').filter(Boolean);
  return parts.length > 1 ? `${parts[0]}.${parts.slice(1).join('_')}` : `app.${parts[0] ?? 'event'}`;
}

const snake = (key: string) => key.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase();

function write(level: LogLevel, event: string, fields: Fields = {}) {
  if (!shouldLog(level)) return;
  const context: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(redact(fields) as Record<string, unknown>)) context[snake(key)] = value;
  const entry = {
    timestamp: new Date().toISOString(),
    level: level.toUpperCase(),
    service: SERVICE,
    environment: process.env.APP_ENV ?? process.env.NODE_ENV ?? 'development',
    service_version: process.env.APP_VERSION ?? process.env.VERCEL_GIT_COMMIT_SHA ?? 'development',
    event_name: eventName(event),
    ...context,
  };
  const line = JSON.stringify(entry);
  if (level === 'error') console.error(line);
  else if (level === 'warn') console.warn(line);
  else console.log(line);
}

export const logger = {
  debug: (event: string, fields?: Fields) => write('debug', event, fields),
  info: (event: string, fields?: Fields) => write('info', event, fields),
  warn: (event: string, fields?: Fields) => write('warn', event, fields),
  error: (event: string, error: unknown, fields: Fields = {}) => write('error', event, { ...fields, error: serialiseError(error) }),
};
