export default function NotFound() {
  return (
    <main className="min-h-dvh grid place-items-center px-5">
      <div className="max-w-md flex flex-col gap-3">
        <h1 className="text-2xl font-bold">Halaman tidak dijumpai</h1>
        <p className="text-muted">Pautan mungkin salah atau halaman telah dialihkan.</p>
        <a href="/periksa" className="text-accent font-semibold underline">Kembali ke paparan lapangan</a>
      </div>
    </main>
  );
}
