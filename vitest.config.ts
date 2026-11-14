import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';

// Load .env.test / .env.local the way Next.js does, so DB integration tests use the same Postgres.
for (const file of ['.env.test', '.env.local']) {
  const path = fileURLToPath(new URL(`./${file}`, import.meta.url));
  if (existsSync(path)) process.loadEnvFile(path);
}

export default defineConfig({
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./', import.meta.url)),
      'server-only': fileURLToPath(new URL('./tests/stubs/server-only.ts', import.meta.url)),
    },
  },
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    testTimeout: 30_000,
    fileParallelism: false,
  },
});
