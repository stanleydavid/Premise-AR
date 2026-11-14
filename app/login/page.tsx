import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { getSession } from '@/lib/auth/session';
import { sanitizeReturnTo } from '@/lib/auth/return-to';
import { devLoginEnabled } from '@/lib/auth/dev-login';
import { SUPPORT_REFERENCE } from '@/lib/observability/ids';
import { homeFor } from '@/lib/auth/home';

export const metadata: Metadata = { title: 'Log masuk' };
export const dynamic = 'force-dynamic';

const MESSAGES: Record<string, { title: string; body: string }> = {
  'earthid-unavailable': { title: 'DBKK ID tidak dapat dihubungi', body: 'Cuba lagi sebentar. Jika berterusan, hubungi Unit ICT DBKK.' },
  'earthid-failed': { title: 'Log masuk tidak selesai', body: 'Sesi log masuk tamat atau dibatalkan. Cuba log masuk semula.' },
  'not-registered': { title: 'Akaun anda belum didaftarkan', body: 'Minta pentadbir Semak Premis mendaftarkan anda (nama, peranan dan e-mel atau No. KP), kemudian log masuk semula.' },
  'earthid-conflict': { title: 'Akaun sudah dipautkan kepada identiti lain', body: 'Akaun pegawai ini telah dipautkan kepada akaun DBKK ID yang lain. Hubungi pentadbir.' },
  disabled: { title: 'Akaun dinyahaktifkan', body: 'Hubungi pentadbir Semak Premis jika ini satu kesilapan.' },
  server: { title: 'Ralat sistem', body: 'Sila cuba lagi. Jika berterusan, berikan rujukan sokongan di bawah kepada Unit ICT.' },
};

type Props = { searchParams: Promise<Record<string, string | string[] | undefined>> };

export default async function LoginPage({ searchParams }: Props) {
  const params = await searchParams;
  const one = (k: string) => (typeof params[k] === 'string' ? (params[k] as string) : undefined);
  const requested = one('returnTo') ? sanitizeReturnTo(one('returnTo'), '') : '';
  const session = await getSession().catch(() => null);
  if (session) redirect(requested || homeFor(session.role));

  const error = one('error');
  const message = error ? MESSAGES[error] ?? MESSAGES['earthid-failed'] : null;
  const ref = one('ref');
  const supportRef = ref && SUPPORT_REFERENCE.test(ref) ? ref : null;
  const now = new Intl.DateTimeFormat('ms-MY', { timeZone: 'Asia/Kuala_Lumpur', dateStyle: 'medium', timeStyle: 'short' }).format(new Date());

  return (
    <main className="min-h-dvh px-5 py-10 flex justify-center" style={{ paddingTop: 'max(40px, env(safe-area-inset-top))' }}>
      <div className="w-full max-w-md flex flex-col gap-6">
        <div>
          <p className="text-xs font-bold tracking-widest uppercase text-accent">Dewan Bandaraya Kota Kinabalu</p>
          <h1 className="text-3xl font-bold leading-tight mt-1">Semak Premis</h1>
          <p className="text-muted mt-2">Semakan lesen dan pematuhan premis di lapangan, untuk pegawai penguat kuasa.</p>
        </div>

        {one('signedOut') && !message && (
          <p role="status" className="rounded-xl bg-ok-bg px-4 py-3 text-sm">Anda telah log keluar.</p>
        )}
        {message && (
          <div role="alert" className="rounded-xl bg-bad-bg px-4 py-3 text-sm flex flex-col gap-1">
            <strong className="text-bad">{message.title}</strong>
            <span>{message.body}</span>
            {supportRef && <span className="font-mono text-xs mt-1">Rujukan sokongan: {supportRef} · {now}</span>}
          </div>
        )}

        <a href={requested ? `/api/auth/login?returnTo=${encodeURIComponent(requested)}` : '/api/auth/login'}
          className="flex items-center justify-center min-h-[52px] rounded-xl bg-accent text-accent-fg font-semibold">
          Log masuk dengan DBKK ID
        </a>
        <p className="text-sm text-muted">Gunakan akaun DBKK ID anda. Kali pertama, akaun anda dipautkan secara automatik jika pentadbir telah mendaftarkan anda.</p>

        {devLoginEnabled() && (
          <section aria-labelledby="dev-h" className="rounded-xl border border-dashed border-line p-4 flex flex-col gap-3">
            <h2 id="dev-h" className="text-sm font-bold">Log masuk demo (bukan produksi)</h2>
            <p className="text-xs text-muted">Hanya untuk ujian. Dimatikan apabila APP_ENV=production.</p>
            <div className="grid grid-cols-3 gap-2">
              {[['pegawai', 'Pegawai'], ['penyelia', 'Penyelia'], ['pentadbir', 'Pentadbir']].map(([key, label]) => (
                <form key={key} method="post" action="/api/auth/dev-login">
                  <input type="hidden" name="email" value={`${key}@demo.invalid`} />
                  <button type="submit" className="w-full min-h-[44px] rounded-lg border border-line bg-surface text-sm font-semibold">{label}</button>
                </form>
              ))}
            </div>
          </section>
        )}
      </div>
    </main>
  );
}
