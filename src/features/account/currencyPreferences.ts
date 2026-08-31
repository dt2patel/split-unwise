import { CURRENCY_EXPONENTS, assertCurrencyCode, type CurrencyCode } from '../../domain/money'
import { appPrincipalKey, type AppPrincipal } from '../../data/principal'

export interface CurrencyPreferences {
  readonly defaultCurrency: CurrencyCode
  readonly preferredCurrencies: readonly CurrencyCode[]
}

export const SUPPORTED_CURRENCIES = Object.freeze(Object.keys(CURRENCY_EXPONENTS).sort() as CurrencyCode[])
const KEY_PREFIX = 'split-unwise:currency-preferences:v1'
const FALLBACK: CurrencyPreferences = Object.freeze({ defaultCurrency: 'USD', preferredCurrencies: Object.freeze(['USD', 'EUR', 'GBP', 'CAD', 'AUD', 'JPY'] as CurrencyCode[]) })

export function validateCurrencyPreferences(value: unknown): CurrencyPreferences {
  if (!isRecord(value) || typeof value.defaultCurrency !== 'string' || !Array.isArray(value.preferredCurrencies)) throw new Error('Currency preferences are invalid')
  assertCurrencyCode(value.defaultCurrency)
  const preferred = value.preferredCurrencies.map((currency) => {
    if (typeof currency !== 'string' || currency !== currency.toUpperCase()) throw new Error('Preferred currencies must use uppercase ISO codes')
    assertCurrencyCode(currency)
    return currency
  })
  if (new Set(preferred).size !== preferred.length) throw new Error('Preferred currencies must be unique')
  if (!preferred.includes(value.defaultCurrency)) throw new Error('Preferred currencies must include the default')
  if (preferred.length < 1 || preferred.length > SUPPORTED_CURRENCIES.length) throw new Error('Preferred currency count is invalid')
  return { defaultCurrency: value.defaultCurrency, preferredCurrencies: Object.freeze([...preferred]) }
}

export function loadCurrencyPreferences(principal: AppPrincipal, storage: Pick<Storage, 'getItem'> | undefined = browserStorage()): CurrencyPreferences {
  try {
    const raw = storage?.getItem(keyFor(principal))
    if (!raw) return cloneFallback()
    return validateCurrencyPreferences(JSON.parse(raw))
  } catch { return cloneFallback() }
}

export function saveCurrencyPreferences(principal: AppPrincipal, value: CurrencyPreferences, storage: Pick<Storage, 'setItem'> | undefined = browserStorage()): CurrencyPreferences {
  const validated = validateCurrencyPreferences(value)
  storage?.setItem(keyFor(principal), JSON.stringify(validated))
  return validated
}

export function currencyPickerOrder(preferences: CurrencyPreferences): readonly CurrencyCode[] {
  const validated = validateCurrencyPreferences(preferences)
  return [...validated.preferredCurrencies, ...SUPPORTED_CURRENCIES.filter((currency) => !validated.preferredCurrencies.includes(currency))]
}

export function clearCurrencyPreferences(principal: AppPrincipal, storage: Pick<Storage, 'removeItem'> | undefined = browserStorage()): void {
  storage?.removeItem(keyFor(principal))
}

function keyFor(principal: AppPrincipal): string { return `${KEY_PREFIX}:${encodeURIComponent(appPrincipalKey(principal))}` }
function cloneFallback(): CurrencyPreferences { return { defaultCurrency: FALLBACK.defaultCurrency, preferredCurrencies: [...FALLBACK.preferredCurrencies] } }
function browserStorage(): Storage | undefined { try { return typeof localStorage === 'undefined' ? undefined : localStorage } catch { return undefined } }
function isRecord(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === 'object' && !Array.isArray(value) }
