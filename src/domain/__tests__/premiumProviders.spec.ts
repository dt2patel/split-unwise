import { describe, expect, it, vi } from 'vitest'
import { createFxPreview, fetchReferenceRate, getPremiumProviderStates } from '../premiumProviders'

describe('premium provider boundaries', () => {
  it('keeps transaction import unavailable without emitting ledger commands', () => {
    const states = getPremiumProviderStates()

    expect(states.import).toEqual({ status: 'unavailable', reason: 'provider-not-configured', proposals: [] })
    expect(JSON.stringify(states.import)).not.toMatch(/expense\.add|command/i)
  })

  it('advertises reference conversion separately from transaction import', () => {
    expect(getPremiumProviderStates().fx).toEqual({
      status: 'available',
      authority: 'European Central Bank via Frankfurter',
      capability: 'reference-preview',
    })
  })

  it('creates a separately labelled FX preview with authority and timestamp without mutating stored money', () => {
    const stored = { currency: 'USD' as const, minorAmount: 1250 }
    const preview = createFxPreview(stored, {
      baseCurrency: 'USD', quoteCurrency: 'EUR', numerator: 9, denominator: 10,
      authority: 'Example Central Bank', effectiveDate: '2026-08-29', observedAt: '2026-08-31T12:00:00.000Z',
    })

    expect(stored).toEqual({ currency: 'USD', minorAmount: 1250 })
    expect(preview).toEqual({
      source: { currency: 'USD', minorAmount: 1250 }, converted: { currency: 'EUR', minorAmount: 1125 },
      authority: 'Example Central Bank', effectiveDate: '2026-08-29', observedAt: '2026-08-31T12:00:00.000Z', kind: 'preview',
    })
  })

  it('rejects normalized-looking but impossible FX timestamps', () => {
    expect(() => createFxPreview({ currency: 'USD', minorAmount: 100 }, {
      baseCurrency: 'USD', quoteCurrency: 'EUR', numerator: 1, denominator: 1,
      authority: 'Example Central Bank', effectiveDate: '2026-02-28', observedAt: '2026-02-30T12:00:00.000Z',
    })).toThrow('timestamp')
  })

  it('accounts for different ISO currency exponents without changing the stored amount', () => {
    const stored = { currency: 'USD' as const, minorAmount: 1250 }
    const preview = createFxPreview(stored, {
      baseCurrency: 'USD', quoteCurrency: 'JPY', numerator: 150, denominator: 1,
      authority: 'European Central Bank via Frankfurter', observedAt: '2026-08-31T12:00:00.000Z',
      effectiveDate: '2026-08-31',
    })

    expect(stored).toEqual({ currency: 'USD', minorAmount: 1250 })
    expect(preview.converted).toEqual({ currency: 'JPY', minorAmount: 1875 })
  })

  it('fetches and verifies an ECB reference rate through the narrow provider boundary', async () => {
    const providerFetch = vi.fn(async () => new Response(JSON.stringify({
      date: '2026-08-29', base: 'USD', quote: 'EUR', rate: 0.86237,
    }), { status: 200, headers: { 'content-type': 'application/json' } }))

    await expect(fetchReferenceRate('USD', 'EUR', {
      fetch: providerFetch,
      now: () => new Date('2026-08-31T12:34:56.789Z'),
    })).resolves.toEqual({
      baseCurrency: 'USD', quoteCurrency: 'EUR', numerator: 86237, denominator: 100000,
      authority: 'European Central Bank via Frankfurter', effectiveDate: '2026-08-29',
      observedAt: '2026-08-31T12:34:56.789Z',
    })
    expect(providerFetch).toHaveBeenCalledWith(
      'https://api.frankfurter.dev/v2/rate/USD/EUR?providers=ECB',
      expect.objectContaining({ headers: { Accept: 'application/json' } }),
    )
  })

  it.each([
    [{ date: '2026-02-30', base: 'USD', quote: 'EUR', rate: 0.86 }, 'effective date'],
    [{ date: '2026-08-31', base: 'USD', quote: 'GBP', rate: 0.86 }, 'currency pair'],
    [{ date: '2026-08-31', base: 'USD', quote: 'EUR', rate: 0 }, 'positive rate'],
  ])('rejects unverified provider payloads without producing a preview', async (payload, expected) => {
    const providerFetch = vi.fn(async () => new Response(JSON.stringify(payload), { status: 200 }))
    await expect(fetchReferenceRate('USD', 'EUR', { fetch: providerFetch })).rejects.toThrow(expected)
  })
})
