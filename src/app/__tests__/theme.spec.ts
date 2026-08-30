import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const theme = readFileSync(resolve(process.cwd(), 'src/app/theme.css'), 'utf8')

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
})
