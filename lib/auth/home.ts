import type { Role } from '@/lib/auth/roles';

/** Where each role lands after sign-in when no specific page was requested. */
export const homeFor = (role: Role) => (role === 'pentadbir' ? '/admin' : '/periksa');
