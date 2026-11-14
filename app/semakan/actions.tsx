'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';

/** POST/PATCH JSON to our API; returns an error message in Malay, or null on success. */
async function call(url: string, method: string, body: unknown): Promise<string | null> {
  try {
    const res = await fetch(url, { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    if (res.ok) return null;
    const data = await res.json().catch(() => ({}));
    const ref = data.support_reference ? ` Rujukan: ${data.support_reference}` : '';
    const map: Record<string, string> = {
      PIN_REVIEW_OWN_SUGGESTION: 'Anda tidak boleh menyemak cadangan anda sendiri.',
      PIN_CORRECTION_ALREADY_REVIEWED: 'Cadangan ini telah disemak oleh penyelia lain.',
      REPORT_CLOSED: 'Laporan ini telah ditutup.',
      VALIDATION_FAILED: 'Sebab perlu sekurang-kurangnya 3 aksara.',
      UNAUTHENTICATED: 'Sesi tamat. Log masuk semula.',
    };
    return (map[data.error] ?? `Tidak berjaya (${data.error ?? res.status}).`) + ref;
  } catch {
    return 'Tiada talian. Cuba lagi.';
  }
}

export function PinActions({ id }: { id: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const decide = async (decision: 'diterima' | 'ditolak') => {
    setBusy(true); setError(null);
    const err = await call(`/api/v1/pin-corrections/${id}/review`, 'POST', { decision });
    setBusy(false);
    if (err) setError(err); else router.refresh();
  };
  return (
    <div className="flex flex-wrap items-center gap-2">
      <button type="button" disabled={busy} onClick={() => decide('diterima')} className="min-h-[40px] px-3 rounded-lg bg-accent text-accent-fg font-semibold disabled:opacity-60">{busy ? 'Menyimpan…' : 'Terima dan alih pin'}</button>
      <button type="button" disabled={busy} onClick={() => decide('ditolak')} className="min-h-[40px] px-3 rounded-lg border border-line font-semibold disabled:opacity-60">Tolak</button>
      {error && <p role="alert" className="text-bad text-sm w-full">{error}</p>}
    </div>
  );
}

export function ReportActions({ id, status }: { id: string; status: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    setBusy(true); setError(null);
    const err = await call(`/api/v1/unlisted-reports/${id}`, 'PATCH', { status: form.get('status'), reason: String(form.get('reason') ?? '') });
    setBusy(false);
    if (err) setError(err); else router.refresh();
  };
  return (
    <form onSubmit={submit} className="flex flex-wrap items-end gap-2">
      <label className="flex flex-col text-xs font-semibold text-muted">Status baharu
        <select name="status" defaultValue={status === 'baru' ? 'disiasat' : 'ditutup'} className="mt-1 min-h-[40px] rounded-lg border border-line bg-surface text-fg px-2">
          <option value="disiasat">Disiasat</option><option value="ditutup">Ditutup</option>
        </select></label>
      <label className="flex flex-col text-xs font-semibold text-muted grow min-w-[12rem]">Sebab / tindakan
        <input name="reason" required minLength={3} maxLength={500} autoComplete="off" className="mt-1 min-h-[40px] rounded-lg border border-line bg-surface text-fg px-2" placeholder="Contoh: notis dikeluarkan, rujukan N123" /></label>
      <button type="submit" disabled={busy} className="min-h-[40px] px-3 rounded-lg bg-accent text-accent-fg font-semibold disabled:opacity-60">{busy ? 'Menyimpan…' : 'Kemas kini'}</button>
      {error && <p role="alert" className="text-bad text-sm w-full">{error}</p>}
    </form>
  );
}
