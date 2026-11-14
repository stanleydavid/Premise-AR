/**
 * Business roles (held in app_users, never taken from DBKK ID's coarse roles):
 *   pegawai    field officer: sees nearby premises, records inspections and reports
 *   penyelia   supervisor: everything a pegawai can, plus all officers' records and pin approvals
 *   pentadbir  administrator: registers officers, imports premise and licence data
 */
export const ROLES = ['pegawai', 'penyelia', 'pentadbir'] as const;
export type Role = (typeof ROLES)[number];

export type Permission =
  | 'premises:read' | 'inspections:create' | 'inspections:read_own' | 'inspections:read_all'
  | 'reports:create' | 'reports:manage' | 'pins:suggest' | 'pins:review'
  | 'users:manage' | 'premises:import' | 'health:detail';

const MATRIX: Record<Role, Permission[]> = {
  pegawai: ['premises:read', 'inspections:create', 'inspections:read_own', 'reports:create', 'pins:suggest'],
  penyelia: ['premises:read', 'inspections:create', 'inspections:read_own', 'inspections:read_all', 'reports:create',
    'reports:manage', 'pins:suggest', 'pins:review'],
  pentadbir: ['premises:read', 'inspections:read_own', 'inspections:read_all', 'reports:manage', 'pins:review',
    'users:manage', 'premises:import', 'health:detail'],
};

export const isRole = (value: unknown): value is Role => typeof value === 'string' && (ROLES as readonly string[]).includes(value);
export const can = (role: Role, permission: Permission) => MATRIX[role].includes(permission);
export const ROLE_LABEL: Record<Role, string> = { pegawai: 'Pegawai', penyelia: 'Penyelia', pentadbir: 'Pentadbir' };
