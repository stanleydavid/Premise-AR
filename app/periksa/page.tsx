import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { getSession } from '@/lib/auth/session';
import { can, ROLE_LABEL } from '@/lib/auth/roles';
import FieldApp from './FieldApp';

export const metadata: Metadata = { title: 'Lapangan' };
export const dynamic = 'force-dynamic';

export default async function FieldPage() {
  const session = await getSession();
  if (!session) redirect('/login?returnTo=%2Fperiksa');
  // Training mode never stores records; it is offered outside production only.
  const trainingEnabled = process.env.APP_ENV !== 'production';
  return (
    <FieldApp
      userId={session.userId}
      displayName={session.displayName}
      roleLabel={ROLE_LABEL[session.role]}
      canInspect={can(session.role, 'inspections:create')}
      canReadAll={can(session.role, 'inspections:read_all')}
      training={{ enabled: trainingEnabled, lat: Number(process.env.TRAINING_LAT ?? 5.6947939), lng: Number(process.env.TRAINING_LNG ?? 115.958221) }}
    />
  );
}
