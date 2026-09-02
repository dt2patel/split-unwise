import { describe, expect, it } from 'vitest'
import {
  LOCALE_STORAGE_KEY,
  SUPPORTED_LOCALES,
  createLocaleController,
  readLocalePreference,
  resolveSupportedLocale,
} from '../i18n'

describe('locale controller', () => {
  it('matches an exact regional locale before falling back to a supported base language', () => {
    expect(resolveSupportedLocale(['pt-BR', 'fr-FR'])).toBe('pt-BR')
    expect(resolveSupportedLocale(['fr-CA', 'es-MX'])).toBe('fr')
    expect(resolveSupportedLocale(['ja-JP'])).toBe('en')
  })

  it('falls back to the system preference when persisted storage is invalid or inaccessible', () => {
    expect(readLocalePreference({ getItem: () => 'klingon' })).toBe('system')
    expect(readLocalePreference({ getItem: () => { throw new Error('denied') } })).toBe('system')
  })

  it('persists an explicit preference, updates the document language, and translates interpolation', () => {
    const stored = new Map([[LOCALE_STORAGE_KEY, 'es']])
    const root = document.implementation.createHTMLDocument('Split Unwise')
    const controller = createLocaleController({
      document: root,
      languages: ['de-DE'],
      storage: {
        getItem: (key) => stored.get(key) ?? null,
        setItem: (key, value) => stored.set(key, value),
      },
    })

    expect(controller.locale.value).toBe('es')
    expect(controller.t('auth.loadingGroups', { name: 'Maya' })).toBe('Cargando los grupos de Maya…')
    expect(root.documentElement.lang).toBe('es')

    controller.setPreference('pt-PT')

    expect(controller.preference.value).toBe('pt-PT')
    expect(controller.locale.value).toBe('pt-PT')
    expect(stored.get(LOCALE_STORAGE_KEY)).toBe('pt-PT')
    expect(root.documentElement.lang).toBe('pt-PT')
  })

  it('exposes the official initial Splitwise locale set and follows the device when set to system', () => {
    const stored = new Map([[LOCALE_STORAGE_KEY, 'nl']])
    const controller = createLocaleController({
      document,
      languages: ['it-IT'],
      storage: {
        getItem: (key) => stored.get(key) ?? null,
        setItem: (key, value) => stored.set(key, value),
      },
    })

    expect(SUPPORTED_LOCALES).toEqual(['en', 'es', 'de', 'nl', 'fr', 'it', 'pt-BR', 'pt-PT'])
    controller.setPreference('system')
    expect(controller.locale.value).toBe('it')
    expect(stored.get(LOCALE_STORAGE_KEY)).toBe('system')
  })
})
