import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { getSession } from '@/lib/auth/session';
import { can } from '@/lib/auth/roles';
import { listInspections, listPinCorrections, listUnlistedReports } from '@/lib/domain/inspections';
import AppHeader from '@/components/AppHeader';
import { PinActions, ReportActions } from './actions';

export const metadata: Metadata = { title: 'Rekod semakan' };
export const dynamic = 'force-dynamic';

type Props = { searchParams: Promise<Record<string, string | string[] | undefined>> };
type InspectionRow = {
  id: string; observed_at: string; outcome: string; licence_status_seen: string; notes: string | null; trade_name: string;
  licence_no: string | null; officer_name: string; accuracy_m: number | null; lat: number | null; lng: number | null;
  items: Array<{ rule_id: string; rule_text: string; result: string }>; photos: Array<{ photo_id: string; rule_id: string | null }>;
};
type ReportRow = { id: string; signboard_name: string; observed_at: string; status: string; status_reason: string | null; notes: string | null;
  officer_name: string; lat: number | null; lng: number | null; photo_ids: string[] };
type PinRow = { id: string; trade_name: string; officer_name: string; created_at: string; shift_m: number; accuracy_m: number | null };

const OUTCOME: Record<string, [string, string]> = {
  patuh: ['Patuh', 'bg-ok-bg text-ok'], tidak_patuh: ['Tidak patuh', 'bg-bad-bg text-bad'], belum_lengkap: ['Belum lengkap', 'bg-warn-bg text-warn'],
};
const RESULT: Record<string, string> = { patuh: 'Patuh', tidak_patuh: 'Tidak patuh', tb: 'T/B' };
const STATUS: Record<string, string> = { baru: 'Baru', disiasat: 'Disiasat', ditutup: 'Ditutup' };
const fmt = (t: string) => new Intl.DateTimeFormat('ms-MY', { timeZone: 'Asia/Kuala_Lumpur', dateStyle: 'medium', timeStyle: 'short' }).format(new Date(t));

export default async function RecordsPage({ searchParams }: Props) {
  const session = await getSession();
  if (!session) redirect('/login?returnTo=%2Fsemakan');
  const params = await searchParams;
  const one = (k: string) => (typeof params[k] === 'string' ? (params[k] as string) : undefined);
  const readAll = can(session.role, 'inspections:read_all');
  const tab = one('tab') === 'laporan' ? 'laporan' : one('tab') === 'pin' && can(session.role, 'pins:review') ? 'pin' : 'semakan';
  const scope = readAll && one('scope') !== 'mine' ? 'all' : 'mine';
  const outcome = ['patuh', 'tidak_patuh', 'belum_lengkap'].includes(one('outcome') ?? '') ? (one('outcome') as 'patuh') : undefined;

  const inspections = tab === 'semakan' ? (await listInspections(session, { scope, outcome, limit: 50 })) as InspectionRow[] : [];
  const reports = tab === 'laporan' ? (await listUnlistedReports(session)) as ReportRow[] : [];
  const pins = tab === 'pin' ? (await listPinCorrections()) as PinRow[] : [];
  const q = (patch: Record<string, string | undefined>) => {
    const next = new URLSearchParams({ tab, ...(scope === 'mine' && readAll ? { scope } : {}), ...(outcome ? { outcome } : {}) });
    for (const [k, v] of Object.entries(patch)) { if (v) next.set(k, v); else next.delete(k); }
    return `/semakan?${next}`;
  };
  const tabLink = (key: string, label: string) => (
    <a href={`/semakan?tab=${key}`} aria-current={tab === key ? 'page' : undefined}
      className={`px-3 py-2 rounded-lg text-sm font-semibold border ${tab === key ? 'bg-fg text-bg border-fg' : 'border-line'}`}>{label}</a>
  );

  return (
    <>
      <AppHeader session={session} current="semakan" />
      <main className="max-w-5xl mx-auto px-4 py-6 flex flex-col gap-5">
        <h1 className="text-2xl font-bold">Rekod semakan</h1>
        <nav aria-label="Jenis rekod" className="flex flex-wrap gap-2">
          {tabLink('semakan', 'Semakan premis')}{tabLink('laporan', 'Premis tiada dalam senarai')}
          {can(session.role, 'pins:review') && tabLink('pin', 'Cadangan lokasi')}
        </nav>

        {tab === 'semakan' && (
          <section aria-labelledby="h-insp" className="flex flex-col gap-3">
            <h2 id="h-insp" className="sr-only">Semakan premis</h2>
            <div className="flex flex-wrap gap-2 text-sm">
              {readAll && <>
                <a href={q({ scope: undefined })} aria-current={scope === 'all' ? 'true' : undefined} className={`px-3 py-1.5 rounded-full border ${scope === 'all' ? 'bg-accent text-accent-fg border-accent' : 'border-line'}`}>Semua pegawai</a>
                <a href={q({ scope: 'mine' })} aria-current={scope === 'mine' ? 'true' : undefined} className={`px-3 py-1.5 rounded-full border ${scope === 'mine' ? 'bg-accent text-accent-fg border-accent' : 'border-line'}`}>Saya sahaja</a>
                <span className="w-px bg-line mx-1" aria-hidden="true" />
              </>}
              {[['', 'Semua keputusan'], ['tidak_patuh', 'Tidak patuh'], ['patuh', 'Patuh'], ['belum_lengkap', 'Belum lengkap']].map(([k, label]) => (
                <a key={k} href={q({ outcome: k || undefined })} aria-current={(outcome ?? '') === k ? 'true' : undefined}
                  className={`px-3 py-1.5 rounded-full border ${(outcome ?? '') === k ? 'bg-fg text-bg border-fg' : 'border-line'}`}>{label}</a>
              ))}
            </div>
            {!inspections.length && (
              <p className="rounded-xl border border-dashed border-line p-6 text-center text-muted">
                {outcome ? 'Tiada semakan dengan keputusan ini. ' : 'Belum ada semakan. '}
                {outcome ? <a className="underline" href={q({ outcome: undefined })}>Buang tapisan</a> : 'Semakan dari paparan lapangan akan muncul di sini selepas dihantar.'}
              </p>
            )}
            <ul className="flex flex-col gap-2">
              {inspections.map((i) => {
                const [label, cls] = OUTCOME[i.outcome] ?? [i.outcome, ''];
                return (
                  <li key={i.id} className="rounded-xl border border-line bg-surface">
                    <details>
                      <summary className="cursor-pointer list-none p-3 flex flex-wrap items-center gap-x-3 gap-y-1">
                        <strong className="min-w-0 break-words">{i.trade_name}</strong>
                        <span className={`text-xs font-bold px-2 py-0.5 rounded ${cls}`}>{label}</span>
                        <span className="text-sm text-muted w-full sm:w-auto sm:ml-auto tabular-nums">{fmt(i.observed_at)} · {i.officer_name} · lesen {i.licence_status_seen.replace('_', ' ').toLowerCase()} · {i.photos.length} gambar</span>
                      </summary>
                      <div className="px-3 pb-3 flex flex-col gap-2 text-sm">
                        <ul className="flex flex-col gap-1">
                          {i.items.map((it) => (
                            <li key={it.rule_id}><strong className={it.result === 'tidak_patuh' ? 'text-bad' : ''}>{RESULT[it.result]}</strong> · {it.rule_text}
                              {i.photos.filter((p) => p.rule_id === it.rule_id).length > 0 && (
                                <span className="flex gap-2 mt-1">{i.photos.filter((p) => p.rule_id === it.rule_id).map((p, n) => (
                                  // eslint-disable-next-line @next/next/no-img-element -- private, session-authenticated evidence; not optimisable
                                  <a key={p.photo_id} href={`/api/v1/photos/${p.photo_id}`} target="_blank" rel="noopener"><img src={`/api/v1/photos/${p.photo_id}`} width={120} height={90} alt={`Bukti ${n + 1}: ${it.rule_text}`} className="rounded border border-line object-cover w-[120px] h-[90px]" loading="lazy" /></a>
                                ))}</span>
                              )}
                            </li>
                          ))}
                        </ul>
                        {i.photos.some((p) => !p.rule_id) && (
                          <div className="flex flex-wrap gap-2">{i.photos.filter((p) => !p.rule_id).map((p, n) => (
                            // eslint-disable-next-line @next/next/no-img-element -- private, session-authenticated evidence
                            <a key={p.photo_id} href={`/api/v1/photos/${p.photo_id}`} target="_blank" rel="noopener"><img src={`/api/v1/photos/${p.photo_id}`} width={120} height={90} alt={`Bukti umum ${n + 1}`} className="rounded border border-line object-cover w-[120px] h-[90px]" loading="lazy" /></a>
                          ))}</div>
                        )}
                        {i.notes && <p>Catatan: {i.notes}</p>}
                        <p className="text-xs text-muted font-mono">{i.licence_no ?? 'tiada lesen'}{i.lat != null && ` · ${i.lat.toFixed(6)}, ${i.lng!.toFixed(6)} ±${Math.round(i.accuracy_m ?? 0)} m`}</p>
                      </div>
                    </details>
                  </li>
                );
              })}
            </ul>
          </section>
        )}

        {tab === 'laporan' && (
          <section className="flex flex-col gap-2">
            {!reports.length && <p className="rounded-xl border border-dashed border-line p-6 text-center text-muted">Tiada laporan premis tiada dalam senarai.</p>}
            {reports.map((r) => (
              <article key={r.id} className="rounded-xl border border-line bg-surface p-3 flex flex-col gap-2 text-sm">
                <div className="flex flex-wrap items-center gap-2">
                  <strong className="text-base break-words">{r.signboard_name}</strong>
                  <span className="text-xs font-bold px-2 py-0.5 rounded bg-warn-bg text-warn">{STATUS[r.status]}</span>
                  <span className="text-muted sm:ml-auto">{fmt(r.observed_at)} · {r.officer_name}</span>
                </div>
                {r.notes && <p>{r.notes}</p>}
                {r.status_reason && <p className="text-muted">Status: {r.status_reason}</p>}
                {r.lat != null && <p className="font-mono text-xs"><a className="underline" href={`https://www.google.com/maps?q=${r.lat},${r.lng}`} target="_blank" rel="noopener">{r.lat.toFixed(6)}, {r.lng!.toFixed(6)}</a></p>}
                <div className="flex flex-wrap gap-2">{r.photo_ids.map((id, n) => (
                  // eslint-disable-next-line @next/next/no-img-element -- private, session-authenticated evidence
                  <a key={id} href={`/api/v1/photos/${id}`} target="_blank" rel="noopener"><img src={`/api/v1/photos/${id}`} width={120} height={90} alt={`Gambar ${n + 1}: ${r.signboard_name}`} className="rounded border border-line object-cover w-[120px] h-[90px]" loading="lazy" /></a>
                ))}</div>
                {can(session.role, 'reports:manage') && r.status !== 'ditutup' && <ReportActions id={r.id} status={r.status} />}
              </article>
            ))}
          </section>
        )}

        {tab === 'pin' && (
          <section className="flex flex-col gap-2">
            <p className="text-sm text-muted">Pegawai yang berdiri di hadapan premis mencadangkan lokasi pin yang betul. Terima untuk mengalih pin bagi semua pegawai. Anda tidak boleh menyemak cadangan anda sendiri.</p>
            {!pins.length && <p className="rounded-xl border border-dashed border-line p-6 text-center text-muted">Tiada cadangan lokasi menunggu semakan.</p>}
            {pins.map((p) => (
              <article key={p.id} className="rounded-xl border border-line bg-surface p-3 flex flex-col gap-2 text-sm">
                <div className="flex flex-wrap gap-2 items-center"><strong className="text-base">{p.trade_name}</strong>
                  <span className="text-muted sm:ml-auto">{fmt(p.created_at)} · {p.officer_name}</span></div>
                <p>Alih sejauh <strong className="tabular-nums">{Math.round(p.shift_m)} m</strong> · ketepatan GPS ±{Math.round(p.accuracy_m ?? 0)} m</p>
                <PinActions id={p.id} />
              </article>
            ))}
          </section>
        )}
      </main>
    </>
  );
}
