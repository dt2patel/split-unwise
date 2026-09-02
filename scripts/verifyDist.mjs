import { readdir, readFile, stat } from 'node:fs/promises'
import { resolve, relative } from 'node:path'
import { gzipSync } from 'node:zlib'

const root = resolve(import.meta.dirname, '..')
const dist = resolve(root, 'dist')
const files = await walk(dist)
const names = files.map((path) => relative(dist, path).replaceAll('\\', '/'))
const required = [
  'index.html', 'manifest.webmanifest', 'sw.js', 'build-info.json',
  'icons/icon-192.png', 'icons/icon-512.png', 'icons/icon-maskable-192.png', 'icons/icon-maskable-512.png',
  'ocr/worker.min.js', 'ocr/lang/eng.traineddata.gz',
  'ocr/core/tesseract-core-lstm.wasm.js', 'ocr/core/tesseract-core-lstm.wasm',
  'ocr/core/tesseract-core-simd-lstm.wasm.js', 'ocr/core/tesseract-core-simd-lstm.wasm',
  'ocr/core/tesseract-core-relaxedsimd-lstm.wasm.js', 'ocr/core/tesseract-core-relaxedsimd-lstm.wasm',
]
for (const name of required) requireCondition(names.includes(name), `missing built artifact: ${name}`)
requireCondition(!names.some((name) => name.endsWith('.map')), 'production source maps must not ship')
requireCondition(!names.includes('assets/images/app-icon-1024.png') && !names.includes('app-icon-1024.png'), 'the 1024 source icon must not be shipped or precached')

const manifest = JSON.parse(await readFile(resolve(dist, 'manifest.webmanifest'), 'utf8'))
requireCondition(manifest.id === '/' && manifest.start_url === '/' && manifest.scope === '/' && manifest.display === 'standalone', 'manifest identity/scope is malformed')
for (const icon of manifest.icons ?? []) {
  const path = resolve(dist, String(icon.src).replace(/^\//, ''))
  const [width, height] = pngSize(await readFile(path))
  requireCondition(icon.sizes === `${width}x${height}`, `manifest icon dimensions do not match ${icon.src}`)
}

const serviceWorker = await readFile(resolve(dist, 'sw.js'), 'utf8')
requireCondition(serviceWorker.includes('index.html'), 'service worker is missing the offline app shell')
requireCondition(!serviceWorker.includes('app-icon-1024.png'), 'service worker precaches the source icon')
requireCondition(!serviceWorker.includes('ocr/'), 'service worker must load large OCR assets on demand')
requireCondition(!/background.?sync/i.test(serviceWorker), 'service worker must not own financial background replay')

for (const name of names.filter((name) => name.startsWith('assets/'))) {
  requireCondition(/-[A-Za-z0-9_-]{8,}\.[A-Za-z0-9]+$/.test(name), `asset is not content hashed: ${name}`)
}
for (const path of files.filter((path) => /\.(?:html|js|css|json|webmanifest)$/.test(path))) {
  const text = await readFile(path, 'utf8')
  // Firebase Auth contains generic localhost redirect fallbacks in its vendor
  // bundle. Reject concrete emulator endpoints and our demo project identity,
  // which are evidence of a configured runtime leak rather than dormant SDK
  // capability.
  requireCondition(!/(?:https?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0):(?:5001|8080|8180|9099|9199)\b|demo-split-unwise)/i.test(text), `private or emulator runtime URL leaked into ${relative(dist, path)}`)
}
for (const path of files.filter((path) => path.endsWith('.js') && relative(dist, path).startsWith('assets/'))) {
  const size = (await stat(path)).size
  const compressedSize = gzipSync(await readFile(path), { level: 9 }).length
  // Ionic's Stencil runtime contains dependency cycles that must remain in one
  // natural Vite chunk. Forced max-size vendor partitioning is smaller on disk
  // but fails in JavaScriptCore. Keep a strict transfer budget and a generous
  // raw parse ceiling so mobile delivery stays measurable without breaking the
  // framework graph.
  requireCondition(size <= 1_200_000, `mobile JavaScript chunk exceeds 1.2 MB raw: ${relative(dist, path)} (${size} bytes)`)
  requireCondition(compressedSize <= 300_000, `mobile JavaScript chunk exceeds 300 kB gzip: ${relative(dist, path)} (${compressedSize} bytes)`)
}

process.stdout.write(`Verified ${files.length} production artifacts; shell, icons, cache boundaries, and runtime URLs are clean.\n`)

async function walk(directory) {
  const entries = await readdir(directory, { withFileTypes: true })
  const nested = await Promise.all(entries.map((entry) => entry.isDirectory() ? walk(resolve(directory, entry.name)) : [resolve(directory, entry.name)]))
  return nested.flat()
}

function pngSize(bytes) {
  requireCondition(bytes.subarray(0, 8).toString('hex') === '89504e470d0a1a0a', 'manifest icon is not a PNG')
  return [bytes.readUInt32BE(16), bytes.readUInt32BE(20)]
}

function requireCondition(condition, message) {
  if (!condition) throw new Error(message)
}
