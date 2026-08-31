import type { Money } from './model'
import { assertCurrencyCode, type CurrencyCode } from './money'

export interface ProviderUnavailable {
  readonly status: 'unavailable'
  readonly reason: 'provider-not-configured'
}

export interface TransactionImportUnavailable extends ProviderUnavailable {
  /** Unverified provider data can never cross the ledger command boundary. */
  readonly proposals: readonly never[]
}

export interface PremiumProviderStates {
  readonly import: TransactionImportUnavailable
  readonly fx: ProviderUnavailable
}

export interface VerifiedFxRate {
  readonly baseCurrency: CurrencyCode
  readonly quoteCurrency: CurrencyCode
  readonly numerator: number
  readonly denominator: number
  readonly authority: string
  readonly observedAt: string
}

export interface FxPreview {
  readonly kind: 'preview'
  readonly source: Money
  readonly converted: Money
  readonly authority: string
  readonly observedAt: string
}

export function getPremiumProviderStates(): PremiumProviderStates {
  return {
    import: { status: 'unavailable', reason: 'provider-not-configured', proposals: [] },
    fx: { status: 'unavailable', reason: 'provider-not-configured' },
  }
}

/** Creates a derived display preview. The authoritative stored money is copied and never relabelled. */
export function createFxPreview(source: Money, rate: VerifiedFxRate): FxPreview {
  assertCurrencyCode(source.currency)
  assertCurrencyCode(rate.baseCurrency)
  assertCurrencyCode(rate.quoteCurrency)
  if (source.currency !== rate.baseCurrency) throw new Error('FX rate base currency must match the stored money')
  if (!Number.isSafeInteger(source.minorAmount) || source.minorAmount < 0) throw new Error('FX source amount must be a non-negative safe integer')
  if (!Number.isSafeInteger(rate.numerator) || rate.numerator <= 0 || !Number.isSafeInteger(rate.denominator) || rate.denominator <= 0) throw new Error('FX rate must use positive safe-integer terms')
  if (!rate.authority.trim()) throw new Error('FX rate authority is required')
  if (!isIsoInstant(rate.observedAt)) throw new Error('FX rate timestamp must be an ISO instant')
  const numerator = BigInt(source.minorAmount) * BigInt(rate.numerator)
  const denominator = BigInt(rate.denominator)
  const converted = (numerator + denominator / 2n) / denominator
  if (converted > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('FX preview exceeds safe integer range')
  return {
    kind: 'preview',
    source: { ...source },
    converted: { currency: rate.quoteCurrency, minorAmount: Number(converted) },
    authority: rate.authority.trim(),
    observedAt: rate.observedAt,
  }
}

function isIsoInstant(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) && !Number.isNaN(Date.parse(value))
}
