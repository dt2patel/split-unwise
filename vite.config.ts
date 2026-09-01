import { fileURLToPath, URL } from 'node:url'
import { defineConfig } from 'vite'
import type { Plugin } from 'vite'
import vue from '@vitejs/plugin-vue'
import { VitePWA } from 'vite-plugin-pwa'

const serviceWorkerExcludedPaths = ['/__/', '/api/'] as const

export default defineConfig({
  base: '/',
  server: {
    allowedHosts: ['terminal.local'],
  },
  plugins: [
    vue(),
    VitePWA({
      strategies: 'generateSW',
      registerType: 'prompt',
      injectRegister: false,
      manifest: false,
      workbox: {
        cleanupOutdatedCaches: true,
        clientsClaim: false,
        skipWaiting: false,
        navigateFallback: '/index.html',
        navigateFallbackDenylist: serviceWorkerExcludedPaths.map((prefix) => new RegExp(`^${prefix.replaceAll('/', '\\/')}`)),
        globPatterns: ['**/*.{html,js,css,png,jpg,jpeg,webp,webmanifest,json}'],
        globIgnores: ['**/app-icon-1024.png', '**/*.map'],
        maximumFileSizeToCacheInBytes: 2 * 1024 * 1024,
        runtimeCaching: [],
      },
      devOptions: { enabled: false },
    }),
    buildInfo(),
  ],
  build: {
    sourcemap: false,
  },
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
})

function buildInfo(): Plugin {
  return {
    name: 'split-unwise-build-info',
    apply: 'build',
    generateBundle() {
      this.emitFile({
        type: 'asset',
        fileName: 'build-info.json',
        source: `${JSON.stringify({ app: 'Split Unwise', version: '0.1.0', commit: process.env.VITE_BUILD_COMMIT ?? 'local-development' }, null, 2)}\n`,
      })
    },
  }
}
