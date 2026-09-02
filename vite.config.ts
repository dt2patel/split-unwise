import { createReadStream, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, resolve } from 'node:path'
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
        globIgnores: ['**/app-icon-1024.png', '**/*.map', 'ocr/**'],
        maximumFileSizeToCacheInBytes: 2 * 1024 * 1024,
        runtimeCaching: [],
      },
      devOptions: { enabled: false },
    }),
    localReceiptOcrAssets(),
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

function localReceiptOcrAssets(): Plugin {
  const require = createRequire(import.meta.url)
  const tesseractRoot = dirname(require.resolve('tesseract.js/package.json'))
  const coreRoot = resolve(tesseractRoot, '..', 'tesseract.js-core')
  const languageRoot = dirname(require.resolve('@tesseract.js-data/eng/package.json'))
  const coreNames = [
    'tesseract-core-lstm.wasm.js', 'tesseract-core-lstm.wasm',
    'tesseract-core-simd-lstm.wasm.js', 'tesseract-core-simd-lstm.wasm',
    'tesseract-core-relaxedsimd-lstm.wasm.js', 'tesseract-core-relaxedsimd-lstm.wasm',
  ] as const
  const assets = new Map<string, string>([
    ['/ocr/worker.min.js', require.resolve('tesseract.js/dist/worker.min.js')],
    ['/ocr/lang/eng.traineddata.gz', resolve(languageRoot, '4.0.0_best_int', 'eng.traineddata.gz')],
    ...coreNames.map((name) => [`/ocr/core/${name}`, resolve(coreRoot, name)] as const),
  ])

  return {
    name: 'split-unwise-local-receipt-ocr-assets',
    configureServer(server) {
      server.middlewares.use((request, response, next) => {
        const pathname = new URL(request.url ?? '/', 'http://localhost').pathname
        const source = assets.get(pathname)
        if (!source) { next(); return }
        response.statusCode = 200
        response.setHeader('Content-Type', pathname.endsWith('.wasm')
          ? 'application/wasm'
          : pathname.endsWith('.gz')
            ? 'application/gzip'
            : 'text/javascript; charset=utf-8')
        createReadStream(source).on('error', next).pipe(response)
      })
    },
    generateBundle() {
      for (const [path, source] of assets) {
        this.emitFile({ type: 'asset', fileName: path.slice(1), source: readFileSync(source) })
      }
    },
  }
}
