import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const theme = readFileSync(resolve(process.cwd(), 'src/app/theme.css'), 'utf8')

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

  it.each([
    ['light text', '#1D1B2B', '#FFFFFF'], ['light primary', '#FFFFFF', '#694BE8'], ['light divider', '#6A6878', '#FFFFFF'], ['light avatar', '#26207F', '#F0EAFF'], ['light owed', '#18794E', '#FFFFFF'], ['light owing', '#A33A2B', '#FFFFFF'],
    ['dark text', '#F7F5FF', '#17152A'], ['dark primary', '#000000', '#A897FF'], ['dark divider', '#9895A9', '#17152A'], ['dark avatar', '#F0EAFF', '#30295A'], ['dark owed', '#7BE0A8', '#17152A'], ['dark owing', '#FFB4A9', '#17152A'],
    ['high-contrast light text', '#000000', '#FFFFFF'], ['high-contrast light primary', '#FFFFFF', '#3510A0'], ['high-contrast light divider', '#000000', '#FFFFFF'], ['high-contrast light avatar', '#171152', '#E8E0FF'], ['high-contrast light owed', '#005A32', '#FFFFFF'], ['high-contrast light owing', '#8A160D', '#FFFFFF'],
    ['high-contrast dark text', '#FFFFFF', '#000000'], ['high-contrast dark primary', '#000000', '#B7A9FF'], ['high-contrast dark divider', '#FFFFFF', '#000000'], ['high-contrast dark avatar', '#FFFFFF', '#221B4B'], ['high-contrast dark owed', '#8CFFB7', '#000000'], ['high-contrast dark owing', '#FFD0C9', '#000000'],
  ])('%s meets normal-text contrast', (_name, foreground, background) => {
    expect(contrastRatio(foreground, background)).toBeGreaterThanOrEqual(4.5)
  })

  it.each([
    ['light pending', '#FFFFFF', '#694BE8'],
    ['dark pending', '#000000', '#A897FF'],
    ['high-contrast light pending', '#FFFFFF', '#3510A0'],
    ['high-contrast dark pending', '#000000', '#B7A9FF'],
  ])('%s meets normal-text contrast', (_name, foreground, background) => {
    expect(contrastRatio(foreground, background)).toBeGreaterThanOrEqual(4.5)
  })
})
