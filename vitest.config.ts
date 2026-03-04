import { defineConfig } from 'vitest/config';

// Root vitest config scopes VS Code test explorer to unit test projects only.
// E2e tests require Java 17+ and Maven — run them via `bun run e2e`.
export default defineConfig({
  test: {
    projects: ['packages/*/vite.config.ts'],
  },
});
