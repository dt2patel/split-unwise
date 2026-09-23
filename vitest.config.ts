import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'
import vue from '@vitejs/plugin-vue'

export default defineConfig({
  plugins: [vue()],
  resolve: {
    // vite-plugin-pwa only provides this virtual module in real builds.
    alias: { 'virtual:pwa-register': fileURLToPath(new URL('./src/tests/pwaRegisterStub.ts', import.meta.url)) },
  },
  test: {
    environment: 'jsdom',
    setupFiles: ['./src/tests/setup.ts'],
  },
})
