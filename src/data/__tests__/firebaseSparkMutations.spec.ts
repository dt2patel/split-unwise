import { describe, expect, it } from 'vitest'
import { buildFirebaseProfile, buildSparkExpenseRecord, buildSparkInvitation, normalizeSparkGroup } from '../firebaseSparkMutations'
import type { ExpenseAddCommand } from '../repositories'
import type { OperationIdentity } from '../operationIdentity'

const fill = (bytes: Uint8Array) => bytes.fill(11)

describe('Firebase Spark mutations', () => {
  it('derives a bounded public profile from the authenticated Firebase identity', () => {
    expect(buildFirebaseProfile({ uid: 'user-a', displayName: '  Maya   Patel  ', email: 'maya@example.com', photoURL: null })).toEqual({
      displayName: 'Maya Patel', initials: 'MP', avatarUrl: null,
    })
    expect(buildFirebaseProfile({ uid: 'user-b', displayName: null, email: 'friend.name@example.com', photoURL: null })).toEqual({
      displayName: 'friend.name', initials: 'F', avatarUrl: null,
    })
  })

  it('normalizes a supported group and derives a replay-stable strict ID', () => {
    expect(normalizeSparkGroup({ operationId: 'group-12345678-1234-1234-1234-123456789012', name: '  Chicago Weekend  ', currency: 'usd' })).toEqual({
      groupId: 'grp-group-12345678-1234-1234-1234-123456789012',
      name: 'Chicago Weekend', currency: 'USD',
    })
    expect(() => normalizeSparkGroup({ operationId: 'bad id', name: 'Trip', currency: 'USD' })).toThrow('operation')
  })

  it('makes the SHA-256 capability document ID match the private fragment token', async () => {
    const invitation = await buildSparkInvitation({ groupId: 'group-a', canonicalOrigin: 'https://split-unwise-aditya.web.app', random: fill, now: new Date('2026-09-01T00:00:00.000Z') })
    expect(invitation.capability).toBe('firebase-client')
    expect(invitation.invitationId).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(invitation.link).toBe('https://split-unwise-aditya.web.app/invite/join#token=CwsLCwsLCwsLCwsLCwsLCwsLCwsLCwsLCwsLCwsLCws')
    expect(invitation.expiresAt).toBe('2026-09-08T00:00:00.000Z')
  })

  it('normalizes every client split into one immutable exact-allocation Spark expense record', () => {
    const command: ExpenseAddCommand = {
      kind: 'expense.add', operationId: 'expense-operation-1', groupId: 'group-a', description: '  Dinner   downtown ', date: '2026-09-01',
      total: { currency: 'USD', minorAmount: 4200 },
      payments: [{ participantId: 'owner', money: { currency: 'USD', minorAmount: 4200 } }],
      allocations: [
        { participantId: 'owner', money: { currency: 'USD', minorAmount: 1800 } },
        { participantId: 'friend', money: { currency: 'USD', minorAmount: 2400 } },
      ],
      category: 'Food', splitMethod: { type: 'percentage', participantIds: ['owner', 'friend'], percentages: { owner: 42.8571428571, friend: 57.1428571429 } },
      notes: '  Team dinner  ', attachmentRefs: [],
    }
    const identity: OperationIdentity = {
      userId: 'owner', operationId: command.operationId, kind: 'expense.add', groupId: 'group-a', requestFingerprint: 'a'.repeat(64),
      resourceId: `operation-${'b'.repeat(48)}`,
    }
    const committedAt = { kind: 'server-timestamp' }

    const record = buildSparkExpenseRecord(command, { id: 'owner', displayName: 'Owner Account' }, identity, committedAt)

    expect(record.expenseId).toBe(`expense-${'b'.repeat(48)}`)
    expect(record.expenseDocument).toEqual({
      id: record.expenseId, groupId: 'group-a', operationId: 'expense-operation-1', requestFingerprint: 'a'.repeat(64), resourceToken: 'b'.repeat(48),
      description: 'Dinner downtown', date: '2026-09-01', total: { currency: 'USD', minorAmount: 4200 },
      payments: [{ participantId: 'owner', money: { currency: 'USD', minorAmount: 4200 } }],
      allocations: [
        { participantId: 'owner', money: { currency: 'USD', minorAmount: 1800 } },
        { participantId: 'friend', money: { currency: 'USD', minorAmount: 2400 } },
      ],
      payerIds: ['owner'], participantIds: ['owner', 'friend'], involvedMemberIds: ['friend', 'owner'],
      category: 'Food', splitType: 'percentage', splitMethod: { type: 'exact', allocations: [
        { participantId: 'owner', money: { currency: 'USD', minorAmount: 1800 } },
        { participantId: 'friend', money: { currency: 'USD', minorAmount: 2400 } },
      ] }, notes: 'Team dinner', attachmentRefs: [],
      createdAt: committedAt, createdBy: { id: 'owner', displayName: 'Owner Account' }, updatedAt: committedAt, updatedBy: { id: 'owner', displayName: 'Owner Account' }, revision: 1,
    })
  })

  it('rejects Spark expense bundles that cannot be verified by the bounded rules path', () => {
    const base: ExpenseAddCommand = {
      kind: 'expense.add', operationId: 'expense-operation-2', groupId: 'group-a', description: 'Dinner', date: '2026-09-01',
      total: { currency: 'USD', minorAmount: 1000 }, payments: [{ participantId: 'owner', money: { currency: 'USD', minorAmount: 1000 } }],
      allocations: [{ participantId: 'owner', money: { currency: 'USD', minorAmount: 1000 } }], category: 'Food', splitMethod: { type: 'equal', participantIds: ['owner'] }, attachmentRefs: [],
    }
    const identity: OperationIdentity = { userId: 'owner', operationId: base.operationId, kind: 'expense.add', groupId: 'group-a', requestFingerprint: 'c'.repeat(64), resourceId: `operation-${'d'.repeat(48)}` }
    const actor = { id: 'owner', displayName: 'Owner Account' }

    expect(() => buildSparkExpenseRecord({ ...base, recurrence: { frequency: 'monthly', anchor: { month: 9, day: 1 }, timeZone: 'America/Chicago' } }, actor, identity, 'now')).toThrow(/recurring/i)
    expect(() => buildSparkExpenseRecord({ ...base, attachmentRefs: ['local-receipt:a'] }, actor, identity, 'now')).toThrow(/attachment/i)
    expect(() => buildSparkExpenseRecord(base, actor, { ...identity, userId: 'other' }, 'now')).toThrow(/identity/i)
    expect(() => buildSparkExpenseRecord({ ...base, allocations: Array.from({ length: 7 }, (_, index) => ({ participantId: `member-${index}`, money: { currency: 'USD' as const, minorAmount: index === 0 ? 1000 : 0 } })), splitMethod: { type: 'exact', allocations: Array.from({ length: 7 }, (_, index) => ({ participantId: `member-${index}`, money: { currency: 'USD' as const, minorAmount: index === 0 ? 1000 : 0 } })) } }, actor, identity, 'now')).toThrow(/six/i)
  })
})
