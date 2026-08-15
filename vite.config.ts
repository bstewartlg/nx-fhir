/// <reference types="vitest/config" />
import { defineConfig } from 'vite';

export default defineConfig({
  test: {
    watch: false,
    projects: [
      'packages/create-nx-fhir/vite.config.mts',
      'packages/nx-fhir/vite.config.mts',
      'e2e/nx-fhir/vite.config.mts'
    ],
  },
});