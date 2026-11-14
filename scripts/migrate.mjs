#!/usr/bin/env node
// Apply db/migrations/*.sql in order, each in its own transaction. A migration that was applied
// and then edited is refused (checksum mismatch): add a new migration instead.
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import pg from 'pg';

for (const file of ['.env.local', '.env']) if (existsSync(file)) process.loadEnvFile(file);
const url = process.env.DATABASE_MIGRATION_URL || process.env.DATABASE_URL;
if (!url) { console.error('DATABASE_URL (or DATABASE_MIGRATION_URL) is not set'); process.exit(1); }

const dir = new URL('../db/migrations/', import.meta.url);
const client = new pg.Client({ connectionString: url });
await client.connect();
try {
  await client.query(`create table if not exists schema_migrations (
    name text primary key, checksum text not null, applied_at timestamptz not null default now())`);
  const applied = new Map((await client.query('select name, checksum from schema_migrations')).rows.map((r) => [r.name, r.checksum]));
  for (const name of readdirSync(dir).filter((f) => /^\d{4}_.+\.sql$/.test(f)).sort()) {
    const sql = readFileSync(new URL(name, dir), 'utf8');
    const checksum = createHash('sha256').update(sql).digest('hex');
    if (applied.has(name)) {
      if (applied.get(name) !== checksum) throw new Error(`Migration ${name} was edited after it was applied`);
      continue;
    }
    await client.query('begin');
    try {
      await client.query(sql);
      await client.query('insert into schema_migrations (name, checksum) values ($1, $2)', [name, checksum]);
      await client.query('commit');
      console.log(`applied ${name}`);
    } catch (error) {
      await client.query('rollback');
      throw new Error(`${name}: ${error.message}`);
    }
  }
  console.log('migrations up to date');
} finally {
  await client.end();
}
