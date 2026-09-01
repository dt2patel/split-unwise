import { describe, expect, it } from 'vitest'
import { parseTransactionStatementCsv } from '../transactionImport'

describe('local transaction statement import', () => {
  it('parses quoted debit rows into review-only expense proposals', async () => {
    const result = await parseTransactionStatementCsv([
      'Date,Description,Amount,Currency',
      '2026-08-30,"Dinner, tacos",-42.50,USD',
      '08/29/2026,Coffee shop,-4.75,USD',
    ].join('\n'), { defaultCurrency: 'USD' })

    expect(result.rejections).toEqual([])
    expect(result.proposals).toHaveLength(2)
    expect(result.proposals[0]).toMatchObject({
      date: '2026-08-30', description: 'Dinner, tacos', money: { currency: 'USD', minorAmount: 4250 }, sourceRow: 2,
    })
    expect(result.proposals[0]?.fingerprint).toMatch(/^transaction-v1:[a-f0-9]{64}$/)
    expect(result.proposals[1]).toMatchObject({ date: '2026-08-29', money: { currency: 'USD', minorAmount: 475 } })
    expect(JSON.stringify(result)).not.toMatch(/expense\.add|operationId/i)
  })

  it('supports a positive Debit column while rejecting credits, zero values, and unsupported currencies', async () => {
    const result = await parseTransactionStatementCsv([
      'Date,Merchant,Debit,Credit,Currency',
      '2026-08-30,Hotel,"1,234.56",,USD',
      '2026-08-29,Refund,,9.00,USD',
      '2026-08-28,No charge,0,,USD',
      '2026-08-27,Unknown money,4.00,,ZZZ',
    ].join('\n'), { defaultCurrency: 'USD' })

    expect(result.proposals).toEqual([
      expect.objectContaining({ description: 'Hotel', money: { currency: 'USD', minorAmount: 123456 } }),
    ])
    expect(result.rejections.map(({ reason }) => reason)).toEqual([
      expect.stringMatching(/credit|refund/i),
      expect.stringMatching(/greater than zero/i),
      expect.stringMatching(/unsupported/i),
    ])
  })

  it('deduplicates normalized transactions within a statement with a stable fingerprint', async () => {
    const result = await parseTransactionStatementCsv([
      'Date,Description,Amount,Currency',
      '2026-08-30,Corner  Store,-12.00,USD',
      '08/30/2026, corner store ,-12,USD',
    ].join('\n'), { defaultCurrency: 'USD' })

    expect(result.proposals).toHaveLength(1)
    expect(result.rejections).toEqual([{ sourceRow: 3, reason: 'Duplicate transaction in this statement.' }])
  })

  it('fails closed for malformed CSV, ambiguous headers, and oversized statements', async () => {
    await expect(parseTransactionStatementCsv('Date,Description,Amount\n"2026-08-30,Dinner,-10', { defaultCurrency: 'USD' })).rejects.toThrow(/CSV/i)
    await expect(parseTransactionStatementCsv('Date,Description,Amount,Debit\n2026-08-30,Dinner,-10,10', { defaultCurrency: 'USD' })).rejects.toThrow(/Amount.*Debit/i)
    await expect(parseTransactionStatementCsv('Date,Description,Amount\n2026-08-30,Dinner,-10', { defaultCurrency: 'USD', maxBytes: 8 })).rejects.toThrow(/too large/i)
  })
})
