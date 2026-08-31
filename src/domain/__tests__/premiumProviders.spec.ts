import { describe, expect, it } from 'vitest'
import { createFxPreview, getPremiumProviderStates } from '../premiumProviders'

describe('premium provider boundaries', () => {
  it('keeps transaction import unavailable without emitting ledger commands', () => {
    const states = getPremiumProviderStates()

    expect(states.import).toEqual({ status: 'unavailable', reason: 'provider-not-configured', proposals: [] })
    expect(JSON.stringify(states.import)).not.toMatch(/expense\.add|command/i)
  })

  it('keeps live FX unavailable until an authoritative source is configured', () => {
    expect(getPremiumProviderStates().fx).toEqual({ status: 'unavailable', reason: 'provider-not-configured' })
  })

  it('creates a separately labelled FX preview with authority and timestamp without mutating stored money', () => {
    const stored = { currency: 'USD' as const, minorAmount: 1250 }
    const preview = createFxPreview(stored, {
      baseCurrency: 'USD', quoteCurrency: 'EUR', numerator: 9, denominator: 10,
      authority: 'Example Central Bank', observedAt: '2026-08-31T12:00:00.000Z',
    })

    expect(stored).toEqual({ currency: 'USD', minorAmount: 1250 })
    expect(preview).toEqual({
      source: { currency: 'USD', minorAmount: 1250 }, converted: { currency: 'EUR', minorAmount: 1125 },
      authority: 'Example Central Bank', observedAt: '2026-08-31T12:00:00.000Z', kind: 'preview',
    })
  })
})
