'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';

const ROLE_LABEL = { pegawai: 'Pegawai', penyelia: 'Penyelia', pentadbir: 'Pentadbir' } as const;
type Role = keyof typeof ROLE_LABEL;
const ERRORS: Record<string, string> = {
  USER_EXISTS: 'Pegawai dengan e-mel, No. KP atau No. staf ini sudah didaftarkan.',
  IC_INVALID: 'No. KP mesti 12 digit.',
  NRIC_HMAC_SECRET_NOT_CONFIGURED: 'Pendaftaran melalui No. KP belum dikonfigurasi pada pelayan (NRIC_HMAC_SECRET).',
  LAST_ADMINISTRATOR: 'Ini pentadbir aktif terakhir. Lantik pentadbir lain dahulu.',
  CANNOT_CHANGE_OWN_ACCESS: 'Anda tidak boleh menukar akses anda sendiri.',
  VALIDATION_FAILED: 'Semak semula maklumat yang dimasukkan.',
  UNAUTHENTICATED: 'Sesi tamat. Log masuk semula.',
};

async function send(url: string, method: string, body: unknown) {
  try {
    const res = await fetch(url, { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    const data = await res.json().catch(() => ({}));
    if (res.ok) return { ok: true as const, data: data.data };
    return { ok: false as const, error: (ERRORS[data.error] ?? `Tidak berjaya (${data.error ?? res.status}).`) + (data.support_reference ? ` Rujukan: ${data.support_reference}` : '') };
  } catch {
    return { ok: false as const, error: 'Tiada talian. Cuba lagi.' };
  }
}

export function NewUserForm() {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const submit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const formEl = e.currentTarget;
    const f = new FormData(formEl);
    const body = Object.fromEntries([...f.entries()].filter(([, v]) => String(v).trim() !== '').map(([k, v]) => [k, String(v).trim()]));
    if (!body.email && !body.ic) { setMsg({ ok: false, text: 'Masukkan e-mel atau No. KP supaya akaun boleh dipautkan kepada DBKK ID.' }); return; }
    setBusy(true); setMsg(null);
    const r = await send('/api/v1/admin/users', 'POST', body);
    setBusy(false);
    if (!r.ok) { setMsg({ ok: false, text: r.error }); return; }
    formEl.reset(); setMsg({ ok: true, text: `${body.display_name} didaftarkan.` }); router.refresh();
  };
  const input = 'mt-1 min-h-[42px] rounded-lg border border-line bg-surface text-fg px-2 w-full';
  return (
    <form onSubmit={submit} className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5 items-end rounded-xl border border-line p-3">
      <label className="text-xs font-semibold text-muted lg:col-span-2">Nama penuh<input name="display_name" required minLength={2} maxLength={120} autoComplete="off" className={input} /></label>
      <label className="text-xs font-semibold text-muted">Peranan
        <select name="role" defaultValue="pegawai" className={input}>{Object.entries(ROLE_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></label>
      <label className="text-xs font-semibold text-muted">E-mel rasmi<input name="email" type="email" autoComplete="off" spellCheck={false} className={input} /></label>
      <label className="text-xs font-semibold text-muted">No. KP (tidak disimpan)<input name="ic" inputMode="numeric" autoComplete="off" spellCheck={false} placeholder="900101-12-1234" className={input} /></label>
      <label className="text-xs font-semibold text-muted">No. staf (pilihan)<input name="staff_no" autoComplete="off" spellCheck={false} className={input} /></label>
      <button type="submit" disabled={busy} className="min-h-[42px] rounded-lg bg-accent text-accent-fg font-semibold disabled:opacity-60 sm:col-span-2 lg:col-span-1">{busy ? 'Mendaftar…' : 'Daftar pegawai'}</button>
      {msg && <p role={msg.ok ? 'status' : 'alert'} className={`text-sm sm:col-span-2 lg:col-span-5 ${msg.ok ? 'text-ok' : 'text-bad'}`}>{msg.text}</p>}
    </form>
  );
}

export function UserRow({ user, self }: { user: { id: string; display_name: string; role: Role; active: boolean; email: string | null; staff_no: string | null; linked: boolean; has_ic: boolean }; self: boolean }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const update = async (patch: { role?: Role; active?: boolean }) => {
    setBusy(true); setError(null);
    const r = await send(`/api/v1/admin/users/${user.id}`, 'PATCH', patch);
    setBusy(false);
    if (!r.ok) setError(r.error); else router.refresh();
  };
  return (
    <tr className="border-t border-line align-top">
      <td className="p-2 min-w-[10rem]"><strong className="break-words">{user.display_name}</strong>{self && <span className="text-muted"> (anda)</span>}
        <span className="block text-xs text-muted break-all">{[user.email, user.has_ic ? 'No. KP didaftarkan' : null, user.staff_no].filter(Boolean).join(' · ')}</span>
        {error && <span role="alert" className="block text-xs text-bad mt-1">{error}</span>}</td>
      <td className="p-2 whitespace-nowrap">{user.linked ? <span className="text-ok font-semibold">DBKK ID dipautkan</span> : <span className="text-muted">Menunggu log masuk pertama</span>}</td>
      <td className="p-2">
        <select aria-label={`Peranan ${user.display_name}`} value={user.role} disabled={self || busy} onChange={(e) => update({ role: e.target.value as Role })}
          className="min-h-[38px] rounded-lg border border-line bg-surface text-fg px-2">
          {Object.entries(ROLE_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
        </select></td>
      <td className="p-2 whitespace-nowrap">
        <button type="button" disabled={self || busy} onClick={() => update({ active: !user.active })}
          aria-label={`${user.active ? 'Nyahaktifkan' : 'Aktifkan'} ${user.display_name}`}
          className={`min-h-[38px] px-3 rounded-lg border font-semibold disabled:opacity-50 ${user.active ? 'border-line' : 'border-bad text-bad'}`}>
          {user.active ? 'Aktif' : 'Tidak aktif'}</button></td>
    </tr>
  );
}

type Report = { rows: number; valid: number; errors: Array<{ line: number; field: string; message: string }>; created?: number; updated?: number };

export function ImportForm() {
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState<null | 'check' | 'import'>(null);
  const [report, setReport] = useState<Report | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [checked, setChecked] = useState(false);
  const run = async (dryRun: boolean) => {
    if (!file) return;
    setBusy(dryRun ? 'check' : 'import'); setError(null);
    try {
      const res = await fetch(`/api/v1/admin/import${dryRun ? '?dry_run=true' : ''}`, { method: 'POST', headers: { 'content-type': 'text/csv' }, body: await file.text() });
      const data = await res.json().catch(() => ({}));
      if (data.data) { setReport(data.data); setChecked(dryRun && !data.data.errors.length); }
      else setError(data.error === 'IMPORT_COLUMNS_MISSING' ? `Lajur tiada: ${(data.missing ?? []).join(', ')}` : `Tidak berjaya (${data.error ?? res.status}).${data.support_reference ? ` Rujukan: ${data.support_reference}` : ''}`);
    } catch { setError('Tiada talian. Cuba lagi.'); } finally { setBusy(null); }
  };
  return (
    <div className="flex flex-col gap-3 rounded-xl border border-line p-3">
      <label className="text-sm font-semibold">Fail CSV
        <input type="file" accept=".csv,text/csv" className="block mt-1 text-sm" onChange={(e) => { setFile(e.target.files?.[0] ?? null); setReport(null); setChecked(false); }} /></label>
      <div className="flex flex-wrap gap-2">
        <button type="button" disabled={!file || !!busy} onClick={() => run(true)} className="min-h-[42px] px-4 rounded-lg border border-line font-semibold disabled:opacity-50">{busy === 'check' ? 'Menyemak…' : 'Semak fail'}</button>
        <button type="button" disabled={!checked || !!busy} onClick={() => run(false)} className="min-h-[42px] px-4 rounded-lg bg-accent text-accent-fg font-semibold disabled:opacity-50">{busy === 'import' ? 'Mengimport…' : 'Import'}</button>
      </div>
      <div role="status" aria-live="polite" className="text-sm">
        {error && <p className="text-bad">{error}</p>}
        {report && (report.errors.length
          ? <div className="flex flex-col gap-1"><p className="text-bad font-semibold">{report.errors.length} ralat dalam {report.rows} baris. Tiada data ditulis.</p>
              <ul className="max-h-60 overflow-auto font-mono text-xs flex flex-col gap-0.5">{report.errors.map((e, i) => <li key={i}>Baris {e.line} · {e.field}: {e.message}</li>)}</ul></div>
          : report.created !== undefined
            ? <p className="text-ok font-semibold">Import selesai: {report.created} premis baharu, {report.updated} dikemas kini.</p>
            : <p className="text-ok font-semibold">{report.valid} baris sah. Tekan Import untuk menulis data.</p>)}
      </div>
    </div>
  );
}
