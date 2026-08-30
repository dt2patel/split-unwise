const ZERO_DECIMAL_CURRENCIES = new Set([
  'BIF', 'CLP', 'DJF', 'GNF', 'JPY', 'KMF', 'KRW', 'PYG', 'RWF', 'UGX', 'VND', 'VUV', 'XAF', 'XOF', 'XPF',
])

const THREE_DECIMAL_CURRENCIES = new Set(['BHD', 'IQD', 'JOD', 'KWD', 'LYD', 'OMR', 'TND'])

export function currencyExponent(currency: string): number {
  const normalizedCurrency = currency.toUpperCase()
  if (ZERO_DECIMAL_CURRENCIES.has(normalizedCurrency)) return 0
  if (THREE_DECIMAL_CURRENCIES.has(normalizedCurrency)) return 3
  return 2
}

/** Converts a decimal string/number using half-away-from-zero rounding. */
export function toMinorUnits(value: number | string, currency: string): number {
  const source = typeof value === 'number' ? String(value) : value.trim()
  const match = /^([+-]?)(\d+)(?:\.(\d*))?$/.exec(source)
  if (!match) throw new Error(`Invalid decimal money value: ${value}`)

  const [, sign, wholePart, fractionPart = ''] = match
  const exponent = currencyExponent(currency)
  const whole = Number(wholePart)
  const fraction = fractionPart.slice(0, exponent).padEnd(exponent, '0')
  const scale = 10 ** exponent
  let minorAmount = whole * scale + (fraction === '' ? 0 : Number(fraction))

  if (fractionPart.length > exponent && fractionPart[exponent] >= '5') minorAmount += 1
  if (!Number.isSafeInteger(minorAmount)) throw new Error('Money value exceeds safe integer range')
  return sign === '-' ? -minorAmount : minorAmount
}

/** Renders minor units exactly, without passing through binary floating point. */
export function fromMinorUnits(minorAmount: number, currency: string): string {
  if (!Number.isSafeInteger(minorAmount)) throw new Error('Money value must be a safe integer')

  const exponent = currencyExponent(currency)
  const sign = minorAmount < 0 ? '-' : ''
  const magnitude = Math.abs(minorAmount)
  if (exponent === 0) return `${sign}${magnitude}`

  const scale = 10 ** exponent
  const whole = Math.floor(magnitude / scale)
  const fraction = String(magnitude % scale).padStart(exponent, '0')
  return `${sign}${whole}.${fraction}`
}
