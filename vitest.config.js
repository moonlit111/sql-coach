import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'jsdom',
    include: ['tests/**/*.{test,property.test}.js'],
    setupFiles: ['./tests/setup.js'],
    testTimeout: 15000,
  },
});
