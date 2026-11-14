import { ok, route } from '@/lib/http/api';
import { ruleSet } from '@/lib/domain/premises';

export const dynamic = 'force-dynamic';

/** Licence types and their compliance checklist (cached on the phone for offline use). */
export const GET = route('premises:read', async ({ ids }) => ok(await ruleSet(), ids));
