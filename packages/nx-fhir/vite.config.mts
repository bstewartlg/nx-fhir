import { defineConfig } from 'vite';

export default defineConfig(() => ({
  root: import.meta.dirname,
  cacheDir: '../../node_modules/.vite/packages/nx-fhir',
  resolve: { tsconfigPaths: true },
  test: {
    name: 'nx-fhir',
    watch: false,
    globals: true,
    environment: 'node',
    include: ['src/**/*.{test,spec}.{js,mjs,cjs,ts,mts,cts,jsx,tsx}'],
    exclude: ['src/**/*.e2e.{test,spec}.{js,mjs,cjs,ts,mts,cts,jsx,tsx}', 'src/**/files/**'],
    reporters: ['default'],
    coverage: {
      reportsDirectory: '../../coverage/packages/nx-fhir',
      provider: 'v8' as const,
      include: ['src/**/*.ts'],
      exclude: ['src/**/files/**', 'src/**/*.spec.ts', 'src/**/*.d.ts'],
      thresholds: {
        statements: 90,
        branches: 90,
        functions: 90,
        lines: 90,
      },
    }
  },
}));
