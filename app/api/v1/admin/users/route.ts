import { jsonBody, ok, route } from '@/lib/http/api';
import { UserCreate, createUser, listUsers } from '@/lib/domain/admin';

export const dynamic = 'force-dynamic';

export const GET = route('users:manage', async ({ ids }) => ok({ users: await listUsers() }, ids));
export const POST = route('users:manage', async ({ request, session, ids }) =>
  ok(await createUser(session, UserCreate.parse(await jsonBody(request)), ids), ids, 201));
