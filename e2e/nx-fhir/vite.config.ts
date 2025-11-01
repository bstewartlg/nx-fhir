import { defineConfig } from 'vite';
import { nxViteTsPaths } from '@nx/vite/plugins/nx-tsconfig-paths.plugin';

export default defineConfig(() => ({
  root: __dirname,
  cacheDir: '../../node_modules/.vite/e2e/nx-fhir',
  plugins: [nxViteTsPaths()],
  test: {
    name: 'nx-fhir-e2e',
    watch: false,
    globals: true,
    environment: 'node',
    include: ['tests/**/*.e2e.{test,spec}.{js,mjs,cjs,ts,mts,cts,jsx,tsx}'],
    reporters: ['default'],
    coverage: {
      reportsDirectory: '../../coverage/e2e/nx-fhir',
      provider: 'v8' as const,
    },
  },
}));
