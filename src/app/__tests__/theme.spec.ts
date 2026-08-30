import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const theme = readFileSync(resolve(process.cwd(), 'src/app/theme.css'), 'utf8')

const paletteConditions = [
  ['light', undefined],
  ['dark', '(prefers-color-scheme: dark)'],
  ['high-contrast light', '(prefers-contrast: more) and (prefers-color-scheme: light)'],
  ['high-contrast dark', '(prefers-contrast: more) and (prefers-color-scheme: dark)'],
] as const

function parsedPalette(condition?: string): Readonly<Record<string, string>> {
  const style = document.createElement('style')
  style.textContent = theme.split('\n').filter((line) => !line.startsWith('@import ')).join('\n')
  document.head.append(style)
  const topLevel = Array.from(style.sheet?.cssRules ?? [])
  const rules = condition === undefined
    ? topLevel
    : Array.from((topLevel.find((rule) => 'conditionText' in rule && (rule as CSSMediaRule).conditionText === condition) as CSSMediaRule | undefined)?.cssRules ?? [])
  const root = rules.find((rule): rule is CSSStyleRule => 'selectorText' in rule && (rule as CSSStyleRule).selectorText === ':root')
  const tokens = Object.fromEntries(Array.from(root?.style ?? []).map((name) => [name, root?.style.getPropertyValue(name).trim() ?? '']))
  style.remove()
  return tokens
}

function contrastRatio(foreground: string, background: string): number {
  const luminance = (hex: string) => {
    const channels = hex.match(/[A-Fa-f\d]{2}/g)?.map((channel) => Number.parseInt(channel, 16) / 255) ?? []
    const [red, green, blue] = channels.map((channel) => channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4)
    return 0.2126 * red + 0.7152 * green + 0.0722 * blue
  }
  const [light, dark] = [luminance(foreground), luminance(background)].sort((left, right) => right - left)
  return (light + 0.05) / (dark + 0.05)
}

describe('Split Unwise theme', () => {
  it('imports Ionic system dark and high-contrast palettes before defining brand cases', () => {
    expect(theme).toContain("@import '@ionic/vue/css/palettes/dark.system.css';")
    expect(theme).toContain("@import '@ionic/vue/css/palettes/high-contrast.system.css';")
    expect(theme).toContain("@import '@ionic/vue/css/palettes/high-contrast-dark.system.css';")
  })

  it('defines separate light, dark, high-contrast-light, and high-contrast-dark brand tokens', () => {
    expect(theme).toContain('--su-surface: #FFFFFF;')
    expect(theme).toMatch(/@media \(prefers-color-scheme: dark\)[\s\S]*--su-surface: #17152A;/)
    expect(theme).toMatch(/@media \(prefers-contrast: more\) and \(prefers-color-scheme: light\)[\s\S]*--su-surface: #FFFFFF;/)
    expect(theme).toMatch(/@media \(prefers-contrast: more\) and \(prefers-color-scheme: dark\)[\s\S]*--su-surface: #000000;/)
  })

  it('declares a complete Ionic primary tuple in every palette mode', () => {
    expect((theme.match(/--ion-color-primary:/g) ?? []).length).toBeGreaterThanOrEqual(4)
    expect((theme.match(/--ion-color-primary-rgb:/g) ?? []).length).toBeGreaterThanOrEqual(4)
    expect((theme.match(/--ion-color-primary-contrast:/g) ?? []).length).toBeGreaterThanOrEqual(4)
    expect((theme.match(/--ion-color-primary-contrast-rgb:/g) ?? []).length).toBeGreaterThanOrEqual(4)
    expect((theme.match(/--ion-color-primary-shade:/g) ?? []).length).toBeGreaterThanOrEqual(4)
    expect((theme.match(/--ion-color-primary-tint:/g) ?? []).length).toBeGreaterThanOrEqual(4)
    expect(theme).toContain('--su-category-fg:')
  })

  it('scopes branded Ionic surfaces to iOS and preserves their RGB companions in every mode', () => {
    expect((theme.match(/:root\.ios \{/g) ?? []).length).toBeGreaterThanOrEqual(4)
    expect((theme.match(/--ion-background-color-rgb:/g) ?? []).length).toBeGreaterThanOrEqual(4)
    expect((theme.match(/--ion-text-color-rgb:/g) ?? []).length).toBeGreaterThanOrEqual(4)
    expect(theme).toContain('--su-surface-rgb: 23, 21, 42;')
    expect(theme).toContain('--su-surface-rgb: 0, 0, 0;')
  })

  it.each(paletteConditions)('%s palette exposes contrast-safe actual token pairs', (_name, condition) => {
    const palette = parsedPalette(condition)
    const pairs = [
      [palette['--su-text'], palette['--su-surface']],
      [palette['--ion-color-primary-contrast'], palette['--ion-color-primary']],
      [palette['--su-divider'], palette['--su-surface']],
      [palette['--su-avatar-fg'], palette['--su-avatar-bg']],
      [palette['--su-owed'], palette['--su-surface']],
      [palette['--su-owing'], palette['--su-surface']],
    ] as const

    expect(Object.values(palette)).not.toContain('')
    pairs.forEach(([foreground, background]) => {
      expect(contrastRatio(foreground, background)).toBeGreaterThanOrEqual(4.5)
    })
  })

  it('keeps standard feedback motion within 140 to 180ms and eliminates it for reduced motion', () => {
    const standardDuration = Number.parseInt(parsedPalette()['--su-motion-fast'], 10)
    const reducedDuration = Number.parseInt(parsedPalette('(prefers-reduced-motion: reduce)')['--su-motion-fast'], 10)

    expect(standardDuration).toBeGreaterThanOrEqual(140)
    expect(standardDuration).toBeLessThanOrEqual(180)
    expect(reducedDuration).toBe(0)
  })
})
