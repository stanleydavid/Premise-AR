import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';

/**
 * Every /api/v1 handler must go through route('<permission>', …). This pins the permission of each
 * endpoint so a refactor cannot silently loosen one (e.g. import or user admin becoming officer-level).
 */
const EXPECTED: Record<string, Record<string, string | null>> = {
  'me': { GET: null },
  'rules': { GET: 'premises:read' },
  'premises/nearby': { GET: 'premises:read' },
  'premises/[id]/pin-corrections': { POST: 'pins:suggest' },
  'photos': { POST: 'inspections:create' },
  'photos/[id]': { GET: 'premises:read' },
  'inspections': { POST: 'inspections:create', GET: 'inspections:read_own' },
  'unlisted-reports': { POST: 'reports:create', GET: 'reports:create' },
  'unlisted-reports/[id]': { PATCH: 'reports:manage' },
  'pin-corrections': { GET: 'pins:review' },
  'pin-corrections/[id]/review': { POST: 'pins:review' },
  'admin/users': { GET: 'users:manage', POST: 'users:manage' },
  'admin/users/[id]': { PATCH: 'users:manage' },
  'admin/import': { POST: 'premises:import' },
};

function routes(dir: string, base = ''): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) return routes(full, base ? `${base}/${name}` : name);
    return name === 'route.ts' ? [base] : [];
  });
}

describe('API v1 permissions', () => {
  const root = path.resolve('app/api/v1');
  const found = routes(root);
  it('covers every route and nothing else', () => {
    expect(found.sort()).toEqual(Object.keys(EXPECTED).sort());
  });
  for (const r of Object.keys(EXPECTED)) {
    it(`${r}`, () => {
      const src = readFileSync(path.join(root, r, 'route.ts'), 'utf8');
      const handlers = [...src.matchAll(/export const (GET|POST|PATCH|PUT|DELETE) = route(?:<[^>]+>)?\((null|'([a-z_:]+)')/g)]
        .map((m) => [m[1], m[3] ?? null]);
      expect(Object.fromEntries(handlers)).toEqual(EXPECTED[r]);
      expect(src).not.toMatch(/export (async )?function (GET|POST|PATCH|PUT|DELETE)/);   // no handler bypasses route()
    });
  }
});
