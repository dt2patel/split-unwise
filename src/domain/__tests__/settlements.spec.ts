import { describe, expect, it } from 'vitest'
import type { Expense, SettlementTransfer } from '../model'
import { computeBalancePlans } from '../balances'

const usd = (minorAmount: number) => ({ currency: 'USD' as const, minorAmount })
const eur = (minorAmount: number) => ({ currency: 'EUR' as const, minorAmount })

function expense(
  id: string,
  payerId: string,
  participantId: string,
  money: ReturnType<typeof usd> | ReturnType<typeof eur>,
): Expense {
  return {
    id,
    description: id,
    date: '2026-08-31',
    total: money,
    payments: [{ participantId: payerId, money }],
    allocations: [{ participantId, money }],
  }
}

describe('settlement-aware balance plans', () => {
  it('keeps a simplified-basis payment as an audited raw pairwise cycle while reducing the simplified debt', () => {
    const expenses = [
      expense('a-owes-b', 'b', 'a', usd(100)),
      expense('b-owes-c', 'c', 'b', usd(100)),
    ]
    const settlement: SettlementTransfer = {
      id: 'payment-a-c',
      senderId: 'a',
      recipientId: 'c',
      money: usd(40),
    }

    expect(computeBalancePlans(expenses, [settlement])).toEqual({
      pairwise: [
        { fromParticipantId: 'a', toParticipantId: 'b', money: usd(100) },
        { fromParticipantId: 'c', toParticipantId: 'a', money: usd(40) },
        { fromParticipantId: 'b', toParticipantId: 'c', money: usd(100) },
      ],
      simplified: [
        { fromParticipantId: 'a', toParticipantId: 'c', money: usd(60) },
      ],
    })
  })

  it('excludes voided settlements and never nets one currency against another', () => {
    const expenses = [
      expense('usd-a-owes-b', 'b', 'a', usd(100)),
      expense('eur-b-owes-a', 'a', 'b', eur(80)),
    ]
    const settlements: readonly SettlementTransfer[] = [
      { id: 'voided-usd', senderId: 'a', recipientId: 'b', money: usd(60), voided: true },
      { id: 'saved-eur', senderId: 'b', recipientId: 'a', money: eur(30) },
    ]

    expect(computeBalancePlans(expenses, settlements)).toEqual({
      pairwise: [
        { fromParticipantId: 'b', toParticipantId: 'a', money: eur(50) },
        { fromParticipantId: 'a', toParticipantId: 'b', money: usd(100) },
      ],
      simplified: [
        { fromParticipantId: 'b', toParticipantId: 'a', money: eur(50) },
        { fromParticipantId: 'a', toParticipantId: 'b', money: usd(100) },
      ],
    })
  })
})
