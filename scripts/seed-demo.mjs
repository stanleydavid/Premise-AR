#!/usr/bin/env node
// Demo data for development and field trials: the prototype's 21 premises around the test point,
// plus three demo users. Refuses to run when APP_ENV=production. Safe to re-run (upserts).
import { existsSync } from 'node:fs';
import pg from 'pg';

for (const file of ['.env.local', '.env']) if (existsSync(file)) process.loadEnvFile(file);
if (process.env.APP_ENV === 'production') { console.error('Refusing to seed demo data in production'); process.exit(1); }
const url = process.env.DATABASE_MIGRATION_URL || process.env.DATABASE_URL;
if (!url) { console.error('DATABASE_URL is not set'); process.exit(1); }

const POINT = { lat: Number(process.env.DEMO_LAT ?? 5.6947939), lng: Number(process.env.DEMO_LNG ?? 115.958221) };
const STREET_BEARING = Number(process.env.DEMO_STREET_BEARING ?? 0);
const R = 6371000, D2R = Math.PI / 180;
const move = (p, b, m) => ({ lat: p.lat + (m * Math.cos(b * D2R) / R) / D2R, lng: p.lng + (m * Math.sin(b * D2R) / (R * Math.cos(p.lat * D2R))) / D2R });

// trade, registered, type, side, slot, floor, days to expiry, compound RM, suspended
const T = [
  ['Kedai Gunting Rambut Ali', 'Ali Barber Enterprise', 'GUNTING', 'R', 0, 0, 210, 0],
  ['Restoran Selera Sabah', 'Selera Sabah Sdn. Bhd.', 'MAKANAN', 'R', 1, 0, 18, 0],
  ['Salun Cantik Manis', 'Cantik Manis Beauty Enterprise', 'GUNTING', 'R', 1, 1, -35, 0],
  ['Kedai Runcit Hup Seng', 'Syarikat Hup Seng', 'RUNCIT', 'R', 2, 0, 300, 0],
  ['Barber Gentleman KK', 'Gentleman Grooming Enterprise', 'GUNTING', 'R', 3, 0, 150, 250],
  ['Spa Refleksologi Harmoni', 'Harmoni Wellness Sdn. Bhd.', 'SPA', 'R', 3, 1, 120, 0, true],
  ['Kedai Kopi Fook Lee', 'Fook Lee Coffee Shop', 'MAKANAN', 'R', 4, 0, 95, 0],
  ['Kedai Telefon MyTech', 'MyTech Mobile Enterprise', 'RUNCIT', 'R', 5, 0, 5, 0],
  ['Optik Jelas', 'Jelas Optical Enterprise', 'RUNCIT', 'R', 6, 0, 33, 0],
  ['Bengkel Motosikal Jaya', 'Jaya Motor Workshop', 'BENGKEL', 'L', 0, 0, 60, 0],
  ['Farmasi Gaya Sihat', 'Gaya Sihat Pharmacy Sdn. Bhd.', 'RUNCIT', 'L', 1, 0, 400, 0],
  ['Restoran Nasi Kandar Mutiara', 'Mutiara Food Enterprise', 'MAKANAN', 'L', 2, 0, -10, 500],
  ['Butik Nur Aina', 'Nur Aina Boutique', 'RUNCIT', 'L', 3, 0, 120, 0],
  ['Gunting Rambut Pak Usu', 'Usu Hair Cut Enterprise', 'GUNTING', 'L', 4, 0, 45, 0],
  ['Pusat Urutan Kaki Tenang', 'Tenang Reflexology Enterprise', 'SPA', 'L', 4, 1, 200, 0],
  ['Kedai Roti Tuaran', 'Roti Tuaran Bakery', 'MAKANAN', 'L', 5, 0, 250, 0],
  ['Kedai Perkakasan Kinabalu', 'Kinabalu Hardware Trading', 'RUNCIT', 'L', 6, 0, 80, 0],
  ['Dobi Bersih', 'Bersih Laundry Services', 'RUNCIT', 'R', -3, 0, 150, 0],
  ['Bengkel Kereta Maju', 'Maju Auto Services', 'BENGKEL', 'L', -4, 0, -90, 300],
  ['Restoran Seafood Tanjung', 'Tanjung Seafood Sdn. Bhd.', 'MAKANAN', 'R', 12, 0, 60, 0],
  ['Barber Station Moden', 'Moden Barber Enterprise', 'GUNTING', 'L', 16, 0, -5, 0],
];
const CONDITIONS = {
  GUNTING: ['Waktu operasi 9.00 pagi – 9.00 malam'],
  MAKANAN: ['Kaki lima tidak boleh digunakan untuk meja makan'],
  SPA: ['Tiada perkhidmatan selepas 10.00 malam'],
  BENGKEL: ['Kerja membaiki di dalam premis sahaja'],
};

const center = move(POINT, STREET_BEARING, -30);   // the test point is mid-street, row A in front
const client = new pg.Client({ connectionString: url });
await client.connect();
try {
  await client.query('begin');
  for (const [i, [trade, reg, type, side, slot, floor, days, compound, suspended]] of T.entries()) {
    const p = move(move(center, STREET_BEARING, 9 + slot * 6.5), STREET_BEARING + (side === 'R' ? 90 : -90), 11);
    const ref = `DEMO-${String(i + 1).padStart(3, '0')}`;
    const unit = (floor ? 'Tkt 1, ' : '') + `Lot ${side === 'R' ? 2 * (slot + 10) : 2 * (slot + 10) - 1}, Blok ${side === 'R' ? 'A' : 'B'}`;
    const { rows: [premise] } = await client.query(
      `insert into premises (external_ref, trade_name, registered_name, address, floor, location)
       values ($1,$2,$3,$4,$5, st_setsrid(st_makepoint($6,$7),4326)::geography)
       on conflict (external_ref) do update set trade_name = excluded.trade_name, registered_name = excluded.registered_name,
         address = excluded.address, floor = excluded.floor, location = excluded.location, updated_at = now()
       returning id`, [ref, trade, reg, unit, floor, p.lng, p.lat]);
    await client.query(
      `insert into licences (premise_id, licence_no, licence_type_code, status, valid_until, conditions, outstanding_compound_sen)
       values ($1,$2,$3,$4, (now() at time zone 'Asia/Kuala_Lumpur')::date + $5::int, $6, $7)
       on conflict (licence_no) do update set status = excluded.status, valid_until = excluded.valid_until,
         conditions = excluded.conditions, outstanding_compound_sen = excluded.outstanding_compound_sen, updated_at = now()`,
      [premise.id, `DEMO/LP/2026/${String(10457 + i * 37).padStart(5, '0')}`, type, suspended ? 'suspended' : 'active', days,
        CONDITIONS[type] ?? [], compound * 100]);
  }
  for (const [name, role, email] of [
    ['Pegawai Demo', 'pegawai', 'pegawai@demo.invalid'],
    ['Penyelia Demo', 'penyelia', 'penyelia@demo.invalid'],
    ['Pentadbir Demo', 'pentadbir', 'pentadbir@demo.invalid'],
  ]) {
    await client.query(`insert into app_users (display_name, role, email) values ($1,$2,$3) on conflict (email) do nothing`, [name, role, email]);
  }
  await client.query('commit');
  console.log(`seeded ${T.length} premises around ${POINT.lat}, ${POINT.lng} (street bearing ${STREET_BEARING}°) and 3 demo users`);
} catch (error) {
  await client.query('rollback');
  throw error;
} finally {
  await client.end();
}
