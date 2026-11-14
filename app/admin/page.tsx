import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { getSession } from '@/lib/auth/session';
import { can } from '@/lib/auth/roles';
import { IMPORT_COLUMNS, listUsers } from '@/lib/domain/admin';
import AppHeader from '@/components/AppHeader';
import { ImportForm, NewUserForm, UserRow } from './forms';

export const metadata: Metadata = { title: 'Pentadbiran' };
export const dynamic = 'force-dynamic';

type User = { id: string; display_name: string; role: 'pegawai' | 'penyelia' | 'pentadbir'; active: boolean; email: string | null;
  staff_no: string | null; linked: boolean; has_ic: boolean };

export default async function AdminPage() {
  const session = await getSession();
  if (!session) redirect('/login?returnTo=%2Fadmin');
  if (!can(session.role, 'users:manage')) redirect('/semakan');
  const users = (await listUsers()) as User[];
  return (
    <>
      <AppHeader session={session} current="admin" />
      <main className="max-w-5xl mx-auto px-4 py-6 flex flex-col gap-8">
        <h1 className="text-2xl font-bold">Pentadbiran</h1>

        <section aria-labelledby="h-users" className="flex flex-col gap-3">
          <h2 id="h-users" className="text-lg font-bold">Pegawai</h2>
          <p className="text-sm text-muted max-w-prose">Daftarkan pegawai sebelum log masuk pertama. Akaun dipautkan kepada DBKK ID secara automatik melalui No. KP yang disahkan MyDigital ID (atau e-mel, jika dibenarkan polisi DBKK).</p>
          <NewUserForm />
          <div className="overflow-x-auto rounded-xl border border-line">
            <table className="w-full text-sm">
              <thead className="bg-surface text-left text-muted">
                <tr><th scope="col" className="p-2">Nama</th><th scope="col" className="p-2">Pautan</th><th scope="col" className="p-2">Peranan</th><th scope="col" className="p-2">Status</th></tr>
              </thead>
              <tbody>
                {users.map((u) => <UserRow key={u.id} user={u} self={u.id === session.userId} />)}
              </tbody>
            </table>
          </div>
        </section>

        <section aria-labelledby="h-import" className="flex flex-col gap-3">
          <h2 id="h-import" className="text-lg font-bold">Import premis dan lesen (CSV)</h2>
          <p className="text-sm text-muted max-w-prose">Fail CSV UTF-8 dengan lajur berikut. Semak dahulu: jika ada baris yang salah, tiada data ditulis dan setiap ralat disenaraikan mengikut baris. Pin yang telah dibetulkan pegawai dikekalkan melainkan import mengalih premis lebih 50 m.</p>
          <p className="font-mono text-xs break-words bg-surface border border-line rounded-lg p-2">{IMPORT_COLUMNS.join(',')}</p>
          <ImportForm />
        </section>
      </main>
    </>
  );
}
