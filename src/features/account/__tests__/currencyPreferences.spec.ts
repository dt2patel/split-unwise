import { describe, expect, it } from 'vitest'
import { currencyPickerOrder, loadCurrencyPreferences, saveCurrencyPreferences, SUPPORTED_CURRENCIES, validateCurrencyPreferences } from '../currencyPreferences'

const principal = { mode: 'firebase', projectId: 'split-unwise', uid: 'maya' } as const

describe('account currency preferences', () => {
  it('requires uppercase, unique ISO codes including the default', () => {
    expect(() => validateCurrencyPreferences({ defaultCurrency: 'usd', preferredCurrencies: ['usd'] })).toThrow()
    expect(() => validateCurrencyPreferences({ defaultCurrency: 'USD', preferredCurrencies: ['USD', 'USD'] })).toThrow('unique')
    expect(() => validateCurrencyPreferences({ defaultCurrency: 'USD', preferredCurrencies: ['EUR'] })).toThrow('include')
    expect(() => validateCurrencyPreferences({ defaultCurrency: 'USD', preferredCurrencies: ['USD', 'ZZZ'] })).toThrow('ISO')
  })

  it('round-trips in principal scope and orders every supported picker option', () => {
    const map = new Map<string, string>()
    const storage = { getItem: (key: string) => map.get(key) ?? null, setItem: (key: string, value: string) => map.set(key, value) }
    saveCurrencyPreferences(principal, { defaultCurrency: 'CAD', preferredCurrencies: ['CAD', 'USD', 'EUR'] }, storage)
    const loaded = loadCurrencyPreferences(principal, storage)
    const ordered = currencyPickerOrder(loaded)
    expect(ordered.slice(0, 3)).toEqual(['CAD', 'USD', 'EUR'])
    expect(new Set(ordered).size).toBe(SUPPORTED_CURRENCIES.length)
    expect(ordered).toHaveLength(SUPPORTED_CURRENCIES.length)
  })
})
