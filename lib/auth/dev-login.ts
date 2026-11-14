/**
 * Demo sign-in for development and field trials without a DBKK ID client.
 * Only when DEV_LOGIN_ENABLED=true AND APP_ENV is not production.
 */
export function devLoginEnabled(env: Record<string, string | undefined> = process.env) {
  return env.DEV_LOGIN_ENABLED === 'true' && env.APP_ENV !== 'production';
}
