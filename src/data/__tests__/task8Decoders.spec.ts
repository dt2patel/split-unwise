import { describe, expect, it } from 'vitest'
import { DocumentDecodeError, decodeBalanceSnapshot, decodeSettlement } from '../firebaseDecoders'

describe('Task 8 Firebase decoders', () => {
  it('decodes an authoritative versioned balance snapshot and rejects signed or cross-group debt data', () => {
    const raw = {
      groupId: 'lake-house-weekend', balanceRevision: 9, simplifyDebtsEnabled: true,
      pairwise: [{ fromParticipantId: 'taylor-s', toParticipantId: 'maya-p', money: { currency: 'USD', minorAmount: 3825 } }],
      simplified: [{ fromParticipantId: 'taylor-s', toParticipantId: 'maya-p', money: { currency: 'USD', minorAmount: 3625 } }],
    }

    expect(decodeBalanceSnapshot('lake-house-weekend', raw)).toEqual(raw)
    expect(() => decodeBalanceSnapshot('lake-house-weekend', { ...raw, groupId: 'another-group' })).toThrow(DocumentDecodeError)
    expect(() => decodeBalanceSnapshot('lake-house-weekend', { ...raw, pairwise: [{ ...raw.pairwise[0], money: { currency: 'USD', minorAmount: -1 } }] })).toThrow('positive')
  })

  it('decodes immutable saved and voided settlements with exact actor/revision invariants', () => {
    const raw = settlementData()
    expect(decodeSettlement('lake-house-weekend', 'settlement-a', raw)).toMatchObject({
      settlementId: 'settlement-a', revision: 1, createdBy: { id: 'maya-p' }, syncState: 'fresh',
    })
    expect(decodeSettlement('lake-house-weekend', 'settlement-a', {
      ...raw,
      revision: 2,
      void: { operationId: 'void-a', reason: 'Duplicate', actor: { id: 'maya-p', displayName: 'Maya P.' }, createdAt: '2026-08-31T21:00:00.000Z', revision: 2 },
    })).toMatchObject({ revision: 2, void: { revision: 2, reason: 'Duplicate' } })
    expect(() => decodeSettlement('lake-house-weekend', 'settlement-a', { ...raw, revision: 2 })).toThrow('void revision')
    expect(() => decodeSettlement('lake-house-weekend', 'settlement-a', { ...raw, money: { currency: 'EUR', minorAmount: 500 } })).toThrow('basis currency')
  })

  it('rejects a settlement creator who is neither the sender nor the recipient', () => {
    const raw = settlementData()

    expect(() => decodeSettlement('lake-house-weekend', 'settlement-a', {
      ...raw,
      createdBy: { id: 'alex-r', displayName: 'Alex R.' },
    })).toThrow(DocumentDecodeError)
  })
})

function settlementData() {
  return {
    groupId: 'lake-house-weekend', operationId: 'record-a', senderId: 'taylor-s', recipientId: 'maya-p',
    money: { currency: 'USD', minorAmount: 500 },
    basis: { kind: 'simplified', senderId: 'taylor-s', recipientId: 'maya-p', currency: 'USD', debtMinor: 3625 },
    method: 'cash', occurredOn: '2026-08-31', note: 'Paid',
    createdBy: { id: 'maya-p', displayName: 'Maya P.' }, createdAt: '2026-08-31T20:00:00.000Z', revision: 1,
  }
}
