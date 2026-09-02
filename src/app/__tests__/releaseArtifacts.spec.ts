// @vitest-environment node
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const root = process.cwd()

describe('PWA and Hosting release contracts', () => {
  it('ships an authored standalone manifest and every required real PNG icon', () => {
    const manifestPath = resolve(root, 'public/manifest.webmanifest')
    expect(existsSync(manifestPath)).toBe(true)
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as Record<string, unknown>
    expect(manifest).toMatchObject({ id: '/', start_url: '/', scope: '/', display: 'standalone', name: 'Split Unwise', short_name: 'Split Unwise' })
    expect(manifest.theme_color).toMatch(/^#[0-9A-Fa-f]{6}$/)
    expect(manifest.background_color).toMatch(/^#[0-9A-Fa-f]{6}$/)
    const icons = manifest.icons as Array<{ src: string; sizes: string; purpose?: string }>
    for (const expected of [
      ['/icons/icon-192.png', 192, 'any'],
      ['/icons/icon-512.png', 512, 'any'],
      ['/icons/icon-maskable-192.png', 192, 'maskable'],
      ['/icons/icon-maskable-512.png', 512, 'maskable'],
    ] as const) {
      expect(icons).toContainEqual(expect.objectContaining({ src: expected[0], sizes: `${expected[1]}x${expected[1]}`, purpose: expected[2] }))
      expect(pngSize(resolve(root, 'public', expected[0].slice(1)))).toEqual([expected[1], expected[1]])
    }
    expect(pngSize(resolve(root, 'public/icons/apple-touch-icon-180.png'))).toEqual([180, 180])
    expect(pngSize(resolve(root, 'public/icons/favicon-32.png'))).toEqual([32, 32])
  })

  it('uses prompt-based Workbox generation with private network paths excluded', () => {
    const vite = readFileSync(resolve(root, 'vite.config.ts'), 'utf8')
    const pwa = readFileSync(resolve(root, 'src/app/pwa.ts'), 'utf8')
    expect(vite).toContain("from 'vite-plugin-pwa'")
    expect(vite).toContain("registerType: 'prompt'")
    expect(vite).toContain('manifest: false')
    expect(vite).toContain('navigateFallbackDenylist')
    expect(vite).not.toContain('codeSplitting')
    for (const path of ['/__/', '/api/', 'app-icon-1024.png']) expect(vite).toContain(path)
    expect(vite).not.toContain('BackgroundSyncPlugin')
    expect(pwa).toContain('import.meta.env.PROD')
    expect(pwa).toContain('Capacitor.isNativePlatform()')
  })

  it('keeps only hashed assets immutable and revalidates shell/update metadata with security headers', () => {
    const firebase = JSON.parse(readFileSync(resolve(root, 'firebase.json'), 'utf8')) as { hosting: { public: string; rewrites: unknown[]; headers: Array<{ source: string; headers: Array<{ key: string; value: string }> }> } }
    expect(firebase.hosting.public).toBe('dist')
    expect(firebase.hosting.rewrites).toContainEqual({ source: '**', destination: '/index.html' })
    const bySource = new Map(firebase.hosting.headers.map((entry) => [entry.source, new Map(entry.headers.map((header) => [header.key, header.value]))]))
    expect(bySource.get('/assets/**')?.get('Cache-Control')).toContain('immutable')
    for (const source of ['/index.html', '/manifest.webmanifest', '/sw.js', '/workbox-*.js', '/registerSW.js', '/startup.js', '/build-info.json', '/icons/**']) {
      expect(bySource.get(source)?.get('Cache-Control')).toContain('no-cache')
    }
    const global = bySource.get('**')
    expect(global?.get('Cache-Control')).toContain('no-cache')
    expect(global?.get('X-Content-Type-Options')).toBe('nosniff')
    expect(global?.get('Cross-Origin-Opener-Policy')).toBe('same-origin-allow-popups')
    expect(global?.get('Content-Security-Policy')).toContain("frame-ancestors 'none'")
    expect(global?.get('Content-Security-Policy')).toContain('https://api.frankfurter.dev')
    expect(global?.get('Content-Security-Policy')).toContain("script-src 'self' 'wasm-unsafe-eval'")
    expect(global?.get('Content-Security-Policy')).not.toMatch(/(?:^|\s)'unsafe-eval'(?:;|\s|$)/)
  })
})

function pngSize(path: string): readonly [number, number] {
  expect(existsSync(path), `${path} should exist`).toBe(true)
  const bytes = readFileSync(path)
  expect(bytes.subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a')
  return [bytes.readUInt32BE(16), bytes.readUInt32BE(20)]
}
