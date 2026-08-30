import { describe, expect, it } from 'vitest'
import { currencyExponent, fromMinorUnits, toMinorUnits } from '../money'

describe('money conversion', () => {
  it('uses ISO exponents with a two-decimal fallback', () => {
    expect(currencyExponent('JPY')).toBe(0)
    expect(currencyExponent('BHD')).toBe(3)
    expect(currencyExponent('USD')).toBe(2)
  })

  it('rounds decimal input half away from zero in the currency minor unit', () => {
    expect(toMinorUnits('1.5', 'JPY')).toBe(2)
    expect(toMinorUnits('1.2345', 'BHD')).toBe(1235)
    expect(toMinorUnits('-1.005', 'USD')).toBe(-101)
  })

  it('renders a minor-unit amount without floating point loss', () => {
    expect(fromMinorUnits(1235, 'BHD')).toBe('1.235')
    expect(fromMinorUnits(-101, 'USD')).toBe('-1.01')
    expect(fromMinorUnits(12, 'JPY')).toBe('12')
  })
})
