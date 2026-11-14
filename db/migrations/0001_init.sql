-- Semak Premis: core schema. Never edit a migration once applied; add a new one.
create extension if not exists postgis;
create extension if not exists pgcrypto;

-- Records that are evidence or audit must never change after they are written.
create function forbid_change() returns trigger language plpgsql as $$
begin
  raise exception 'APPEND_ONLY: % on % is not allowed', tg_op, tg_table_name using errcode = 'P0001';
end $$;

------------------------------------------------------------------------------------------------
-- People. Officers are registered by an administrator, then linked to DBKK ID on first sign-in:
-- by stored sub, else by MyDigital-verified IC (HMAC only, never the IC itself), else by verified
-- e-mail when EARTHID_LINK_BY_EMAIL=true.
------------------------------------------------------------------------------------------------
create table app_users (
  id              uuid primary key default gen_random_uuid(),
  display_name    text not null check (char_length(display_name) between 2 and 120),
  role            text not null check (role in ('pegawai', 'penyelia', 'pentadbir')),
  active          boolean not null default true,
  email           text unique check (email = lower(email)),
  nric_hmac       text unique,
  staff_no        text unique,
  earthid_subject text unique,
  linked_at       timestamptz,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  check (email is not null or nric_hmac is not null or earthid_subject is not null)
);

------------------------------------------------------------------------------------------------
-- Licence types and their compliance checklist.
------------------------------------------------------------------------------------------------
create table licence_types (
  code   text primary key check (code ~ '^[A-Z][A-Z0-9_]{1,30}$'),
  name   text not null,
  active boolean not null default true
);

create table compliance_rules (
  id                text primary key check (id ~ '^[A-Za-z0-9_.-]{2,60}$'),
  licence_type_code text references licence_types(code),   -- null: applies to every licence type
  text              text not null,
  kind              text not null check (kind in ('visual', 'manual')),
  is_example        boolean not null default false,        -- placeholder rule awaiting DBKK confirmation
  sort              int not null default 0,
  active            boolean not null default true
);

------------------------------------------------------------------------------------------------
-- Premises and licences (imported from the licensing data; see ADR 0001).
------------------------------------------------------------------------------------------------
create table premises (
  id                  uuid primary key default gen_random_uuid(),
  external_ref        text not null unique,                 -- key in the licensing data
  trade_name          text not null check (char_length(trade_name) between 1 and 160),
  registered_name     text,
  address             text,
  floor               smallint not null default 0 check (floor between -2 and 30),
  location            geography(point, 4326) not null,
  location_source     text not null default 'import' check (location_source in ('import', 'officer')),
  location_updated_at timestamptz not null default now(),
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);
create index premises_location_gix on premises using gist (location);

create table licences (
  id                       uuid primary key default gen_random_uuid(),
  premise_id               uuid not null references premises(id),
  licence_no               text not null unique,
  licence_type_code        text not null references licence_types(code),
  status                   text not null check (status in ('active', 'suspended', 'revoked')),
  valid_until              date not null,
  conditions               text[] not null default '{}',
  outstanding_compound_sen bigint not null default 0 check (outstanding_compound_sen >= 0),
  updated_at               timestamptz not null default now()
);
create index licences_premise_idx on licences (premise_id, valid_until desc);

------------------------------------------------------------------------------------------------
-- Evidence photos. Stored outside the database (PHOTO_STORAGE_DIR); the row keeps the hash.
-- The same officer uploading the same bytes again gets the same row (safe retry from the outbox).
------------------------------------------------------------------------------------------------
create table photos (
  id           uuid primary key default gen_random_uuid(),
  uploaded_by  uuid not null references app_users(id),
  sha256       text not null check (sha256 ~ '^[0-9a-f]{64}$'),
  content_type text not null check (content_type in ('image/jpeg', 'image/webp')),
  size_bytes   int not null check (size_bytes > 0),
  storage_key  text not null unique,
  taken_at     timestamptz,
  lat          double precision,
  lng          double precision,
  accuracy_m   real,
  heading      real,
  created_at   timestamptz not null default now(),
  unique (uploaded_by, sha256)
);

------------------------------------------------------------------------------------------------
-- Inspections. Immutable once written; a correction is a new inspection.
-- (officer_id, idempotency_key) makes the phone's offline outbox safe to retry.
------------------------------------------------------------------------------------------------
create table inspections (
  id                 uuid primary key default gen_random_uuid(),
  idempotency_key    text not null check (idempotency_key ~ '^[A-Za-z0-9_-]{16,64}$'),
  request_hash       text not null,                         -- same key + different content = rejected
  officer_id         uuid not null references app_users(id),
  premise_id         uuid not null references premises(id),
  licence_id         uuid references licences(id),
  licence_status_seen text not null,
  outcome            text not null check (outcome in ('patuh', 'tidak_patuh', 'belum_lengkap')),
  notes              text check (char_length(notes) <= 2000),
  observed_at        timestamptz not null,
  received_at        timestamptz not null default now(),
  lat                double precision,
  lng                double precision,
  accuracy_m         real,
  heading            real,
  unique (officer_id, idempotency_key)
);
create index inspections_premise_idx on inspections (premise_id, observed_at desc);
create index inspections_officer_idx on inspections (officer_id, observed_at desc);

create table inspection_items (
  inspection_id uuid not null references inspections(id),
  rule_id       text not null references compliance_rules(id),
  rule_text     text not null,                               -- what the officer saw, kept if the rule changes
  result        text not null check (result in ('patuh', 'tidak_patuh', 'tb')),
  primary key (inspection_id, rule_id)
);

create table inspection_photos (
  inspection_id uuid not null references inspections(id),
  photo_id      uuid not null unique references photos(id),
  rule_id       text references compliance_rules(id),       -- null: general evidence
  primary key (inspection_id, photo_id)
);

create trigger inspections_append_only before update or delete on inspections for each row execute function forbid_change();
create trigger inspection_items_append_only before update or delete on inspection_items for each row execute function forbid_change();
create trigger inspection_photos_append_only before update or delete on inspection_photos for each row execute function forbid_change();

------------------------------------------------------------------------------------------------
-- A signboard that matches no licensed premise (possible unlicensed business).
------------------------------------------------------------------------------------------------
create table unlisted_reports (
  id                uuid primary key default gen_random_uuid(),
  idempotency_key   text not null check (idempotency_key ~ '^[A-Za-z0-9_-]{16,64}$'),
  request_hash      text not null,
  officer_id        uuid not null references app_users(id),
  signboard_name    text not null check (char_length(signboard_name) between 1 and 160),
  licence_type_code text references licence_types(code),
  floor             smallint not null default 0,
  notes             text check (char_length(notes) <= 2000),
  observed_at       timestamptz not null,
  received_at       timestamptz not null default now(),
  location          geography(point, 4326),
  accuracy_m        real,
  heading           real,
  status            text not null default 'baru' check (status in ('baru', 'disiasat', 'ditutup')),
  status_reason     text,
  status_changed_by uuid references app_users(id),
  status_changed_at timestamptz,
  unique (officer_id, idempotency_key)
);

create table unlisted_report_photos (
  report_id uuid not null references unlisted_reports(id),
  photo_id  uuid not null unique references photos(id),
  primary key (report_id, photo_id)
);

------------------------------------------------------------------------------------------------
-- An officer's suggestion that a premise pin is wrong; a supervisor accepts or rejects it.
------------------------------------------------------------------------------------------------
create table pin_corrections (
  id          uuid primary key default gen_random_uuid(),
  premise_id  uuid not null references premises(id),
  officer_id  uuid not null references app_users(id),
  location    geography(point, 4326) not null,
  accuracy_m  real,
  status      text not null default 'cadangan' check (status in ('cadangan', 'diterima', 'ditolak')),
  reviewed_by uuid references app_users(id),
  reviewed_at timestamptz,
  created_at  timestamptz not null default now()
);
create index pin_corrections_open_idx on pin_corrections (status, created_at) where status = 'cadangan';

------------------------------------------------------------------------------------------------
-- Audit (EarthOps §8): append-only, separate from logs.
------------------------------------------------------------------------------------------------
create table audit_events (
  audit_id        uuid primary key default gen_random_uuid(),
  timestamp       timestamptz not null default now(),
  event_name      text not null,
  actor_id        uuid,
  earthid_subject text,
  actor_role      text,
  action          text not null,
  entity_type     text not null,
  entity_id       text not null,
  result          text not null,
  reason          text,
  before          jsonb,
  after           jsonb,
  request_id      text,
  correlation_id  text
);
create index audit_events_entity_idx on audit_events (entity_type, entity_id, timestamp desc);
create trigger audit_events_append_only before update or delete on audit_events for each row execute function forbid_change();
create trigger audit_events_no_truncate before truncate on audit_events for each statement execute function forbid_change();

------------------------------------------------------------------------------------------------
-- Reference data: licence types and the example checklist from the prototype.
-- Rules marked is_example are placeholders until DBKK licensing confirms the real conditions.
------------------------------------------------------------------------------------------------
insert into licence_types (code, name) values
  ('GUNTING', 'Kedai gunting rambut / salun'),
  ('MAKANAN', 'Premis makanan'),
  ('RUNCIT',  'Perniagaan runcit'),
  ('SPA',     'Spa / refleksologi'),
  ('BENGKEL', 'Bengkel kenderaan');

insert into compliance_rules (id, licence_type_code, text, kind, is_example, sort) values
  ('COMMON.lesen',     null,      'Lesen asal dipamerkan di tempat yang mudah dilihat', 'visual', false, 1),
  ('COMMON.papan',     null,      'Nama pada papan tanda sepadan dengan nama dalam lesen', 'visual', false, 2),
  ('GUNTING.kaca',     'GUNTING', 'Dinding hadapan lutsinar: bahagian dalam kedai boleh dilihat dari luar (tiada cermin gelap, kabur atau ditutup pelekat)', 'visual', true, 10),
  ('GUNTING.alat',     'GUNTING', 'Peralatan gunting dan pisau cukur dibersihkan dan disanitasi', 'manual', false, 11),
  ('GUNTING.masa',     'GUNTING', 'Waktu operasi mengikut syarat lesen', 'manual', false, 12),
  ('MAKANAN.kakilima', 'MAKANAN', 'Kaki lima tidak dihalang oleh meja, kerusi atau peralatan masak', 'visual', false, 10),
  ('MAKANAN.tifoid',   'MAKANAN', 'Semua pengendali makanan ada suntikan tifoid dan sijil kursus pengendali makanan', 'manual', false, 11),
  ('MAKANAN.sampah',   'MAKANAN', 'Tong sampah bertutup dan perangkap minyak berfungsi', 'manual', false, 12),
  ('RUNCIT.kakilima',  'RUNCIT',  'Barang jualan tidak dipamerkan atau disimpan di kaki lima', 'visual', false, 10),
  ('RUNCIT.iklan',     'RUNCIT',  'Papan iklan tambahan mempunyai permit', 'manual', false, 11),
  ('SPA.kaca',         'SPA',     'Bahagian hadapan premis tidak ditutup sepenuhnya oleh cermin gelap atau langsir', 'visual', true, 10),
  ('SPA.bilik',        'SPA',     'Bilik rawatan tidak boleh dikunci dari dalam', 'manual', true, 11),
  ('SPA.pekerja',      'SPA',     'Semua pekerja mempunyai permit kerja atau dokumen yang sah', 'manual', false, 12),
  ('BENGKEL.jalan',    'BENGKEL', 'Kenderaan tidak dibaiki di kaki lima atau di atas jalan', 'visual', false, 10),
  ('BENGKEL.minyak',   'BENGKEL', 'Minyak terpakai disimpan dalam bekas tertutup', 'manual', false, 11);
