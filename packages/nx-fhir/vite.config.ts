import { defineConfig } from 'vite';
import { nxViteTsPaths } from '@nx/vite/plugins/nx-tsconfig-paths.plugin';
import { nxCopyAssetsPlugin } from '@nx/vite/plugins/nx-copy-assets.plugin';

export default defineConfig(() => ({
  root: __dirname,
  cacheDir: '../../node_modules/.vite/packages/nx-fhir',
  plugins: [nxViteTsPaths(), nxCopyAssetsPlugin(['*.md'])],
  // Uncomment this if you are using workers.
  // worker: {
  //  plugins: [ nxViteTsPaths() ],
  // },
  test: {
    name: 'nx-fhir',
    globals: true,
    environment: 'node',
    include: ['src/**/*.{test,spec}.{js,mjs,cjs,ts,mts,cts,jsx,tsx}'],
    exclude: ['src/**/*.e2e.{test,spec}.{js,mjs,cjs,ts,mts,cts,jsx,tsx}', 'src/**/files/**'],
    reporters: ['default'],
    coverage: {
      reportsDirectory: '../../coverage/packages/nx-fhir',
      provider: 'v8' as const,
      exclude: ['src/**/files/**'],
    }
  },
}));
