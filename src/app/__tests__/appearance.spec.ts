import { describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { APPEARANCE_STORAGE_KEY, CHROME_COLORS, bootstrapAppearance, readAppearancePreference } from '../appearance'

function media(matches = false) {
  const listeners = new Set<() => void>()
  return { matches, addEventListener: vi.fn((_type: string, listener: () => void) => listeners.add(listener)), removeEventListener: vi.fn((_type: string, listener: () => void) => listeners.delete(listener)), emit() { listeners.forEach((listener) => listener()) }, listeners }
}

describe('appearance controller', () => {
  it('falls back to system for invalid or inaccessible storage', () => {
    expect(readAppearancePreference({ getItem: () => 'sepia' })).toBe('system')
    expect(readAppearancePreference({ getItem: () => { throw new Error('denied') } })).toBe('system')
  })

  it('applies forced palettes, listens to OS color only in system, and retains contrast', () => {
    document.head.innerHTML = '<meta name="theme-color" content="#fff">'
    const color = media(true)
    const contrast = media(false)
    const stored = new Map([[APPEARANCE_STORAGE_KEY, 'system']])
    const controller = bootstrapAppearance({
      document,
      storage: { getItem: (key) => stored.get(key) ?? null, setItem: (key, value) => stored.set(key, value) },
      matchMedia: (query) => query.includes('contrast') ? contrast as never : color as never,
    })
    expect(document.documentElement.classList.contains('su-theme-dark')).toBe(true)
    expect(color.listeners.size).toBe(1)

    controller.setPreference('light')
    expect(document.documentElement.classList.contains('su-theme-dark')).toBe(false)
    expect(color.listeners.size).toBe(0)
    contrast.matches = true
    contrast.emit()
    expect(document.documentElement.classList.contains('ion-palette-high-contrast')).toBe(true)
    expect(document.querySelector('meta[name="theme-color"]')?.getAttribute('content')).toBe('#F8F7FF')

    controller.setPreference('dark')
    expect(document.documentElement.classList.contains('ion-palette-high-contrast-dark')).toBe(true)
    expect(document.documentElement.style.colorScheme).toBe('dark')
    expect(document.querySelector('meta[name="theme-color"]')?.getAttribute('content')).toBe('#000000')
    controller.destroy()
    expect(contrast.listeners.size).toBe(0)
  })

  it('paints toolbars and the tab bar with the same chrome color as the status bar in every theme', () => {
    const css = readFileSync(resolve(process.cwd(), 'src/app/theme.css'), 'utf8')
    expect(css).toContain(`:root { --su-chrome: ${CHROME_COLORS.light}; }`)
    expect(css).toContain(`:root.su-theme-dark { --su-chrome: ${CHROME_COLORS.dark}; }`)
    expect(css).toContain(`:root.su-contrast-more.su-theme-dark { --su-chrome: ${CHROME_COLORS.contrastDark}; }`)
    expect(css).toMatch(/--ion-toolbar-background: var\(--su-chrome\)/)
    expect(css).toMatch(/--ion-tab-bar-background: var\(--su-chrome\)/)
    expect(css).toContain('html { background: var(--su-chrome); }')
    expect(css).toMatch(/body \{[^}]*background: var\(--su-chrome\);/)
    const manifest = JSON.parse(readFileSync(resolve(process.cwd(), 'public/manifest.webmanifest'), 'utf8')) as { theme_color: string }
    expect(manifest.theme_color).toBe(CHROME_COLORS.light)
    expect(readFileSync(resolve(process.cwd(), 'index.html'), 'utf8')).toContain(`<meta name="theme-color" content="${CHROME_COLORS.light}" />`)
  })
})
