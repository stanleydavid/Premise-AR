import 'server-only';
import { Pool, type PoolClient } from 'pg';
import { SERVICE } from '@/lib/product';

/** Direct PostgreSQL access (PostGIS). One pool per process. */
let pool: Pool | null = null;

export function getPool(): Pool {
  if (pool) return pool;
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) throw new Error('DATABASE_URL is not configured');
  pool = new Pool({
    connectionString,
    max: Number(process.env.DATABASE_POOL_MAX ?? 10),
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
    application_name: SERVICE,
  });
  pool.on('error', (err) => console.error(JSON.stringify({ level: 'ERROR', event_name: 'db.pool_error', message: err.message })));
  return pool;
}

export type Db = Pick<PoolClient, 'query'>;

export async function query<T = Record<string, unknown>>(text: string, params: unknown[] = [], db?: Db): Promise<T[]> {
  const result = await (db ?? getPool()).query(text, params as never[]);
  return result.rows as T[];
}

export async function queryOne<T = Record<string, unknown>>(text: string, params: unknown[] = [], db?: Db): Promise<T | null> {
  const rows = await query<T>(text, params, db);
  return rows[0] ?? null;
}

/** Run statements in one transaction; the domain row and its audit row commit together or not at all. */
export async function withTransaction<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await getPool().connect();
  try {
    await client.query('begin');
    const result = await fn(client);
    await client.query('commit');
    return result;
  } catch (error) {
    await client.query('rollback').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

/** Test helper: close the pool so a test process can exit. */
export async function closePool() {
  if (pool) { await pool.end(); pool = null; }
}
