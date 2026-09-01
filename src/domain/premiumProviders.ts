import type { Money } from './model'
import { assertCurrencyCode, currencyExponent, type CurrencyCode } from './money'

const FX_AUTHORITY = 'European Central Bank via Frankfurter'
const FX_ENDPOINT = 'https://api.frankfurter.dev/v2/rate'

export interface ProviderUnavailable {
  readonly status: 'unavailable'
  readonly reason: 'provider-not-configured'
}

export interface TransactionImportUnavailable extends ProviderUnavailable {
  /** Unverified provider data can never cross the ledger command boundary. */
  readonly proposals: readonly never[]
}

export interface ReferencePreviewAvailable {
  readonly status: 'available'
  readonly authority: typeof FX_AUTHORITY
  readonly capability: 'reference-preview'
}

export interface PremiumProviderStates {
  readonly import: TransactionImportUnavailable
  readonly fx: ReferencePreviewAvailable
}

export interface VerifiedFxRate {
  readonly baseCurrency: CurrencyCode
  readonly quoteCurrency: CurrencyCode
  readonly numerator: number
  readonly denominator: number
  readonly authority: string
  readonly effectiveDate: string
  readonly observedAt: string
}

export interface FxPreview {
  readonly kind: 'preview'
  readonly source: Money
  readonly converted: Money
  readonly authority: string
  readonly effectiveDate: string
  readonly observedAt: string
}

export interface ReferenceRateFetchOptions {
  readonly fetch?: (input: string, init?: RequestInit) => Promise<Pick<Response, 'json' | 'ok' | 'status'>>
  readonly now?: () => Date
  readonly signal?: AbortSignal
}

export function getPremiumProviderStates(): PremiumProviderStates {
  return {
    import: { status: 'unavailable', reason: 'provider-not-configured', proposals: [] },
    fx: { status: 'available', authority: FX_AUTHORITY, capability: 'reference-preview' },
  }
}

/** Loads an informational ECB reference rate. It does not create or mutate ledger records. */
export async function fetchReferenceRate(baseCurrency: CurrencyCode, quoteCurrency: CurrencyCode, options: ReferenceRateFetchOptions = {}): Promise<VerifiedFxRate> {
  assertCurrencyCode(baseCurrency)
  assertCurrencyCode(quoteCurrency)
  if (baseCurrency === quoteCurrency) throw new Error('FX reference rate requires two different currencies')
  const request = options.fetch ?? globalThis.fetch
  if (typeof request !== 'function') throw new Error('Reference rate service is unavailable on this device')
  const url = `${FX_ENDPOINT}/${encodeURIComponent(baseCurrency)}/${encodeURIComponent(quoteCurrency)}?providers=ECB`
  let response: Pick<Response, 'json' | 'ok' | 'status'>
  try {
    response = await request(url, { headers: { Accept: 'application/json' }, signal: options.signal })
  } catch (reason) {
    if (isAbortError(reason)) throw reason
    throw new Error('Could not reach the reference rate service', { cause: reason })
  }
  if (!response.ok) throw new Error(`Reference rate service returned ${response.status}`)
  let payload: unknown
  try { payload = await response.json() } catch (reason) { throw new Error('Reference rate service returned invalid JSON', { cause: reason }) }
  if (!isRecord(payload) || payload.base !== baseCurrency || payload.quote !== quoteCurrency) throw new Error('Reference rate response does not match the requested currency pair')
  if (typeof payload.date !== 'string' || !isIsoDate(payload.date)) throw new Error('Reference rate response has an invalid effective date')
  if (typeof payload.rate !== 'number' || !Number.isFinite(payload.rate) || payload.rate <= 0) throw new Error('Reference rate response must contain a positive rate')
  const terms = decimalTerms(payload.rate)
  const observedAt = (options.now ?? (() => new Date()))().toISOString()
  if (!isIsoInstant(observedAt)) throw new Error('Reference rate observation time is invalid')
  return {
    baseCurrency,
    quoteCurrency,
    ...terms,
    authority: FX_AUTHORITY,
    effectiveDate: payload.date,
    observedAt,
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
  if (!isIsoDate(rate.effectiveDate)) throw new Error('FX rate effective date must be an ISO date')
  if (!isIsoInstant(rate.observedAt)) throw new Error('FX rate timestamp must be an ISO instant')
  const numerator = BigInt(source.minorAmount) * BigInt(rate.numerator) * (10n ** BigInt(currencyExponent(rate.quoteCurrency)))
  const denominator = BigInt(rate.denominator) * (10n ** BigInt(currencyExponent(rate.baseCurrency)))
  const converted = (numerator + denominator / 2n) / denominator
  if (converted > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('FX preview exceeds safe integer range')
  return {
    kind: 'preview',
    source: { ...source },
    converted: { currency: rate.quoteCurrency, minorAmount: Number(converted) },
    authority: rate.authority.trim(),
    effectiveDate: rate.effectiveDate,
    observedAt: rate.observedAt,
  }
}

function decimalTerms(value: number): Pick<VerifiedFxRate, 'numerator' | 'denominator'> {
  const match = /^(\d+)(?:\.(\d+))?(?:e([+-]?\d+))?$/i.exec(String(value))
  if (!match) throw new Error('Reference rate cannot be represented safely')
  const digits = BigInt(`${match[1]}${match[2] ?? ''}`)
  const power = Number(match[3] ?? 0) - (match[2]?.length ?? 0)
  let numerator = power >= 0 ? digits * (10n ** BigInt(power)) : digits
  let denominator = power >= 0 ? 1n : 10n ** BigInt(-power)
  const divisor = greatestCommonDivisor(numerator, denominator)
  numerator /= divisor
  denominator /= divisor
  const maximum = BigInt(Number.MAX_SAFE_INTEGER)
  if (numerator > maximum || denominator > maximum) throw new Error('Reference rate cannot be represented safely')
  return { numerator: Number(numerator), denominator: Number(denominator) }
}

function greatestCommonDivisor(left: bigint, right: bigint): bigint {
  while (right !== 0n) [left, right] = [right, left % right]
  return left
}

function isIsoDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false
  const parsed = new Date(`${value}T00:00:00.000Z`)
  return !Number.isNaN(parsed.valueOf()) && parsed.toISOString().slice(0, 10) === value
}

function isIsoInstant(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) return false
  const parsed = new Date(value)
  return !Number.isNaN(parsed.valueOf()) && parsed.toISOString() === value
}

function isRecord(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === 'object' && !Array.isArray(value) }
function isAbortError(reason: unknown): boolean { return reason instanceof DOMException && reason.name === 'AbortError' }
