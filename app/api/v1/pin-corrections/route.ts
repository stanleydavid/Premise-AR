import { ok, route } from '@/lib/http/api';
import { listPinCorrections } from '@/lib/domain/inspections';

export const dynamic = 'force-dynamic';

export const GET = route('pins:review', async ({ ids }) => ok({ pin_corrections: await listPinCorrections() }, ids));
