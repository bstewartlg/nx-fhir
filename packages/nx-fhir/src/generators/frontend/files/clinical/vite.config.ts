import { defineConfig } from 'vite';
import { devtools } from '@tanstack/devtools-vite';
import viteReact from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { tanstackRouter } from '@tanstack/router-plugin/vite';

function isPackage(id: string, pkg: string): boolean {
  return id.includes(`/node_modules/${pkg}/`) || id.includes(`\\node_modules\\${pkg}\\`);
}

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [
    devtools(),
    tanstackRouter({
      target: 'react',
      autoCodeSplitting: true,
    }),
    viteReact(),
    tailwindcss(),
  ],
  resolve: {
    tsconfigPaths: true,
  },
  build: {
    rolldownOptions: {
      output: {
        manualChunks(id: string) {
          if (!id.includes('node_modules')) return;
          if (isPackage(id, 'react') || isPackage(id, 'react-dom')) return 'react';
          if (
            isPackage(id, '@tanstack/react-query') ||
            isPackage(id, '@tanstack/react-router') ||
            isPackage(id, '@tanstack/react-table')
          ) {
            return 'tanstack';
          }
          if (isPackage(id, 'radix-ui')) return 'radix';
        },
      },
    },
  },
});
