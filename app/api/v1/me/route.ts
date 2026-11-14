import { ok, route } from '@/lib/http/api';
import { can, ROLE_LABEL } from '@/lib/auth/roles';

export const dynamic = 'force-dynamic';

export const GET = route(null, async ({ session, ids }) => ok({
  user_id: session.userId, display_name: session.displayName, role: session.role, role_label: ROLE_LABEL[session.role],
  can: {
    inspect: can(session.role, 'inspections:create'), read_all: can(session.role, 'inspections:read_all'),
    review_pins: can(session.role, 'pins:review'), manage_reports: can(session.role, 'reports:manage'),
    manage_users: can(session.role, 'users:manage'), import: can(session.role, 'premises:import'),
  },
}, ids));
