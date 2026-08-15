import { defineConfig } from 'vite';

export default defineConfig(() => ({
  root: import.meta.dirname,
  cacheDir: '../../node_modules/.vite/e2e/nx-fhir',
  resolve: { tsconfigPaths: true },
  test: {
    name: 'nx-fhir-e2e',
    watch: false,
    // The e2e specs each create workspaces and spawn heavy child process trees;
    // running the files concurrently would contend for CPU and interleave logs
    fileParallelism: false,
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
