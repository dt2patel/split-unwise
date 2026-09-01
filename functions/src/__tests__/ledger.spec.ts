import { describe, expect, it } from 'vitest'
import { assertSplitMatchesAllocations, computeLedgerBalancePlans, parseExecuteCommandRequest, validateLedgerExpense } from '@split-unwise/shared'
import { deriveInvitationToken, deterministicUuid } from '../services.js'
import { nextOccurrence } from '../ledger.js'

describe('strict shared ledger protocol', () => {
  const command = {
    kind: 'expense.add' as const,
    operationId: 'expense-12345678-1234-1234-1234-123456789012',
    groupId: 'group-a',
    description: 'Dinner',
    date: '2026-08-31',
    total: { currency: 'USD' as const, minorAmount: 1000 },
    payments: [{ participantId: 'owner', money: { currency: 'USD' as const, minorAmount: 1000 } }],
    allocations: [
      { participantId: 'owner', money: { currency: 'USD' as const, minorAmount: 500 } },
      { participantId: 'member', money: { currency: 'USD' as const, minorAmount: 500 } },
    ],
    category: 'Dining',
    splitMethod: { type: 'equal' as const, participantIds: ['owner', 'member'] },
    attachmentRefs: [],
  }

  it('strictly rejects unknown fields and malformed money before a Firestore call', () => {
    expect(() => parseExecuteCommandRequest({ schemaVersion: 1, command: { ...command, surprise: true } })).toThrow()
    expect(() => parseExecuteCommandRequest({ schemaVersion: 1, command: { ...command, total: { currency: 'USD', minorAmount: Number.MAX_SAFE_INTEGER + 1 } } })).toThrow()
    expect(() => validateLedgerExpense({ ...command, id: 'expense' })).not.toThrow()
    expect(() => validateLedgerExpense({ ...command, id: 'expense', total: { currency: 'USD', minorAmount: 0 }, payments: [{ participantId: 'owner', money: { currency: 'USD', minorAmount: 0 } }], allocations: [{ participantId: 'owner', money: { currency: 'USD', minorAmount: 0 } }] })).toThrow('positive')
  })

  it('rejects allocation totals or split intent that do not exactly match', () => {
    expect(() => validateLedgerExpense({ ...command, id: 'expense', allocations: [{ participantId: 'member', money: { currency: 'USD', minorAmount: 999 } }] })).toThrow('equal its total')
    expect(() => assertSplitMatchesAllocations(command.total, command.splitMethod, [{ participantId: 'owner', money: { currency: 'USD', minorAmount: 400 } }, { participantId: 'member', money: { currency: 'USD', minorAmount: 600 } }])).toThrow('selected split')
  })

  it('preserves exact balance arithmetic across a payment', () => {
    const plans = computeLedgerBalancePlans([{ id: 'expense', total: command.total, payments: command.payments, allocations: command.allocations }], [{ id: 'settlement', senderId: 'member', recipientId: 'owner', money: { currency: 'USD', minorAmount: 200 } }])
    expect(plans.simplified).toEqual([{ fromParticipantId: 'member', toParticipantId: 'owner', money: { currency: 'USD', minorAmount: 300 } }])
  })

  it('handles month-end, leap-year, weekly, and fortnightly recurrence deterministically', () => {
    expect(nextOccurrence('2024-01-31', { frequency: 'monthly', anchor: { month: 1, day: 31 }, timeZone: 'America/Chicago' })).toBe('2024-02-29')
    expect(nextOccurrence('2024-02-29', { frequency: 'yearly', anchor: { month: 2, day: 29 }, timeZone: 'America/Chicago' })).toBe('2025-02-28')
    expect(nextOccurrence('2026-03-08', { frequency: 'weekly', anchor: { month: 3, day: 8 }, timeZone: 'America/Chicago' })).toBe('2026-03-15')
    expect(nextOccurrence('2026-03-08', { frequency: 'fortnightly', anchor: { month: 3, day: 8 }, timeZone: 'America/Chicago' })).toBe('2026-03-22')
  })

  it('derives replayable 256-bit invite capabilities without storing the raw token', () => {
    const first = deriveInvitationToken('a-secret-that-is-definitely-at-least-thirty-two-bytes', 'owner', 'operation-a')
    expect(first).toHaveLength(43)
    expect(deriveInvitationToken('a-secret-that-is-definitely-at-least-thirty-two-bytes', 'owner', 'operation-a')).toBe(first)
    expect(deriveInvitationToken('a-secret-that-is-definitely-at-least-thirty-two-bytes', 'owner', 'operation-b')).not.toBe(first)
    expect(deterministicUuid('template', '2026-08-31')).toMatch(/^[0-9a-f-]{36}$/)
  })

  it('accepts only a strict versioned debt-simplification command', () => {
    const request = {
      schemaVersion: 1,
      command: { kind: 'group.simplify-debts', operationId: 'simplify-off', groupId: 'group-a', expectedRevision: 3, simplifyDebtsEnabled: false },
    }
    expect(() => parseExecuteCommandRequest(request)).not.toThrow()
    expect(() => parseExecuteCommandRequest({ ...request, command: { ...request.command, privateState: true } })).toThrow()
  })

  it('accepts only a strict member-removal command with a target distinct from the actor', () => {
    const request = {
      schemaVersion: 1,
      command: { kind: 'group.member-remove', operationId: 'remove-member', groupId: 'group-a', targetMemberId: 'member' },
    }
    expect(() => parseExecuteCommandRequest(request)).not.toThrow()
    expect(() => parseExecuteCommandRequest({ ...request, command: { ...request.command, targetMemberId: '' } })).toThrow()
    expect(() => parseExecuteCommandRequest({ ...request, command: { ...request.command, privateState: true } })).toThrow()
  })

  it.each(['group.delete', 'group.restore'] as const)('accepts only a strict %s lifecycle command', (kind) => {
    const request = { schemaVersion: 1, command: { kind, operationId: `${kind}-operation`, groupId: 'group-a' } }
    expect(() => parseExecuteCommandRequest(request)).not.toThrow()
    expect(() => parseExecuteCommandRequest({ ...request, command: { ...request.command, privateState: true } })).toThrow()
  })
})
