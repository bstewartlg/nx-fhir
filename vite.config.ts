/// <reference types="vitest/config" />
import { defineConfig } from 'vite';

export default defineConfig({
  test: {
    watch: false,
    projects: [
      'packages/create-nx-fhir/vite.config.ts',
      'packages/nx-fhir/vite.config.ts',
      'e2e/nx-fhir/vite.config.ts'
    ],
  },
});