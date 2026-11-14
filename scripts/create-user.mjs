#!/usr/bin/env node
// Register an officer before their first DBKK ID sign-in (bootstrap the first administrator with this;
// after that, administrators register officers in the app).
//   node scripts/create-user.mjs --name "Nama Pegawai" --role pentadbir --email nama@dbkk.sabah.gov.my [--ic 900101-12-1234]
import { existsSync } from 'node:fs';
import { createHmac } from 'node:crypto';
import { parseArgs } from 'node:util';
import pg from 'pg';

for (const file of ['.env.local', '.env']) if (existsSync(file)) process.loadEnvFile(file);
const { values } = parseArgs({ options: { name: { type: 'string' }, role: { type: 'string' }, email: { type: 'string' }, ic: { type: 'string' } } });
if (!values.name || !['pegawai', 'penyelia', 'pentadbir'].includes(values.role ?? '') || (!values.email && !values.ic)) {
  console.error('Usage: --name <name> --role pegawai|penyelia|pentadbir --email <e-mail> and/or --ic <IC no>');
  process.exit(1);
}
let hmac = null;
if (values.ic) {
  const digits = values.ic.replace(/\D/g, '');
  const secret = process.env.NRIC_HMAC_SECRET ?? '';
  if (digits.length !== 12) { console.error('IC must have 12 digits'); process.exit(1); }
  if (secret.length < 32) { console.error('NRIC_HMAC_SECRET (32+ characters) is required to register by IC'); process.exit(1); }
  hmac = createHmac('sha256', secret).update(`nric:${digits}`).digest('hex');
}
const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
await client.connect();
try {
  await client.query('begin');
  const { rows: [user] } = await client.query(
    'insert into app_users (display_name, role, email, nric_hmac) values ($1,$2,$3,$4) returning id',
    [values.name, values.role, values.email?.toLowerCase() ?? null, hmac]);
  await client.query(`insert into audit_events (event_name, action, entity_type, entity_id, result, reason, after)
    values ('user.registered', 'CREATE', 'app_user', $1, 'success', 'bootstrap script', $2)`,
    [user.id, JSON.stringify({ display_name: values.name, role: values.role, email: values.email ?? null, by_ic: Boolean(hmac) })]);
  await client.query('commit');
  console.log(`registered ${values.role} ${values.name} (${user.id})`);
} catch (error) {
  await client.query('rollback');
  console.error(error.message);
  process.exit(1);
} finally {
  await client.end();
}
