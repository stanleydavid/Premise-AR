import type { AppSession } from '@/lib/auth/session';
import { can, ROLE_LABEL } from '@/lib/auth/roles';

/** Header for the office pages (records, administration). The field view has its own HUD. */
export default function AppHeader({ session, current }: { session: AppSession; current: 'semakan' | 'admin' }) {
  const link = (href: string, label: string, key: string) => (
    <a href={href} aria-current={current === key ? 'page' : undefined}
      className={`px-3 py-2 rounded-lg font-semibold ${current === key ? 'bg-accent text-accent-fg' : 'text-fg hover:bg-surface'}`}>{label}</a>
  );
  return (
    <header className="border-b border-line bg-bg" style={{ paddingTop: 'env(safe-area-inset-top)' }}>
      <div className="max-w-5xl mx-auto px-4 py-3 flex flex-wrap items-center gap-2">
        <a href="/periksa" className="font-bold mr-2">Semak Premis</a>
        <nav aria-label="Utama" className="flex flex-wrap gap-1 text-sm">
          {can(session.role, 'inspections:create') && link('/periksa', 'Lapangan', 'periksa')}
          {link('/semakan', 'Rekod', 'semakan')}
          {can(session.role, 'users:manage') && link('/admin', 'Pentadbiran', 'admin')}
        </nav>
        <div className="ml-auto flex items-center gap-3 text-sm">
          <span className="text-muted">{session.displayName} · {ROLE_LABEL[session.role]}</span>
          <form method="post" action="/api/auth/logout"><button type="submit" className="underline">Log keluar</button></form>
        </div>
      </div>
    </header>
  );
}
