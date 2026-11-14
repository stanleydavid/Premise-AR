'use client';

/** Friendly 500 for a page that failed to render: no internals, a digest the support team can trace, a way out. */
export default function ErrorPage({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  const when = new Intl.DateTimeFormat('ms-MY', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date());
  return (
    <main className="min-h-dvh grid place-items-center px-5">
      <div role="alert" className="max-w-md flex flex-col gap-3">
        <h1 className="text-2xl font-bold">Halaman ini gagal dimuatkan</h1>
        <p className="text-muted">Rekod semakan yang belum dihantar masih selamat dalam telefon ini. Cuba lagi.</p>
        {error.digest && <p className="font-mono text-xs">Rujukan: {error.digest} · {when}</p>}
        <div className="flex gap-3">
          <button type="button" onClick={reset} className="min-h-[44px] px-4 rounded-lg bg-accent text-accent-fg font-semibold">Cuba lagi</button>
          <a href="/periksa" className="min-h-[44px] px-4 rounded-lg border border-line grid place-items-center font-semibold">Ke paparan lapangan</a>
        </div>
      </div>
    </main>
  );
}
