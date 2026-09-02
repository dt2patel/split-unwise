import { describe, expect, it } from 'vitest'
import * as sparkMutations from '../firebaseSparkMutations'
import { buildFirebaseProfile, buildSparkExpenseRecord, buildSparkInvitation, normalizeSparkGroup } from '../firebaseSparkMutations'
import type { ActorSnapshot, CommentAddCommand, CommentDeleteCommand, ExpenseAddCommand, ExpenseDeleteCommand, ExpenseEditCommand, ExpenseRestoreCommand, GroupCurrencyConversionCommand, GroupDefaultSplitCommand, GroupDeleteCommand, GroupMemberRemoveCommand, GroupRestoreCommand, GroupSimplifyDebtsCommand, Member, NotificationItem, NotificationPreferencesCommand, NotificationReadAllCommand, NotificationReadCommand, ProfileUpdateCommand, RecurrenceCancelCommand, RecurrenceMaterializeCommand, SettlementRecordCommand, SettlementVoidCommand } from '../repositories'
import type { OperationIdentity } from '../operationIdentity'

const fill = (bytes: Uint8Array) => bytes.fill(11)

describe('Firebase Spark mutations', () => {
  it('generates bounded materialization operation IDs even for maximum-length template IDs', async () => {
    const templateId = `r${'x'.repeat(127)}`

    const first = await sparkMutations.buildSparkMaterializationOperationId('group-a', templateId, '2026-10-01')
    const replay = await sparkMutations.buildSparkMaterializationOperationId('group-a', templateId, '2026-10-01')
    const nextDate = await sparkMutations.buildSparkMaterializationOperationId('group-a', templateId, '2026-11-01')

    expect(first).toMatch(/^recurrence-[a-f0-9]{64}$/)
    expect(first).toHaveLength(75)
    expect(replay).toBe(first)
    expect(nextDate).not.toBe(first)
  })

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
      kind: 'group', name: 'Chicago Weekend', currency: 'USD',
    })
    expect(normalizeSparkGroup({ operationId: 'friend-12345678-1234-1234-1234-123456789012', kind: 'friendship', name: '  Jordan Lee  ', currency: 'usd' })).toEqual({
      groupId: 'grp-friend-12345678-1234-1234-1234-123456789012',
      kind: 'friendship', name: 'Jordan Lee', currency: 'USD',
    })
    expect(() => normalizeSparkGroup({ operationId: 'bad id', name: 'Trip', currency: 'USD' })).toThrow('operation')
    expect(() => normalizeSparkGroup({ operationId: 'bad-kind-12345678', kind: 'household' as never, name: 'Trip', currency: 'USD' })).toThrow('kind')
  })

  it('persists only an allowlisted built-in cover on a new group', () => {
    const covered = normalizeSparkGroup({
      operationId: 'covered-12345678-1234-1234-1234-123456789012',
      name: 'Chicago Weekend',
      currency: 'usd',
      coverImageUrl: '/covers/group-trip.jpg',
    } as Parameters<typeof normalizeSparkGroup>[0])

    expect(covered).toEqual({
      groupId: 'grp-covered-12345678-1234-1234-1234-123456789012',
      kind: 'group',
      name: 'Chicago Weekend',
      currency: 'USD',
      coverImageUrl: '/covers/group-trip.jpg',
    })
    expect(() => normalizeSparkGroup({
      operationId: 'remote-cover-12345678', name: 'Remote cover', currency: 'USD', coverImageUrl: 'https://example.com/tracker.jpg',
    } as unknown as Parameters<typeof normalizeSparkGroup>[0])).toThrow('cover')
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
    expect(record.activityId).toBe(`activity-${'b'.repeat(48)}`)
    expect(record.expenseDocument).toEqual({
      id: record.expenseId, groupId: 'group-a', operationId: 'expense-operation-1', requestFingerprint: 'a'.repeat(64), resourceToken: 'b'.repeat(48),
      lastOperationId: 'expense-operation-1', lastRequestFingerprint: 'a'.repeat(64), lastResourceToken: 'b'.repeat(48),
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
    expect(record.activityDocument).toEqual({
      groupId: 'group-a', operationId: 'expense-operation-1', kind: 'expense.created',
      subject: { kind: 'expense', id: record.expenseId, label: 'Dinner downtown' },
      actor: { id: 'owner', displayName: 'Owner Account' }, expenseId: record.expenseId, resourceToken: 'b'.repeat(48), revision: 1, createdAt: committedAt,
    })
  })

  it('preserves the reimbursement marker in immutable Spark expense records', () => {
    const command: ExpenseAddCommand = {
      kind: 'expense.add', operationId: 'refund-operation', groupId: 'group-a', description: 'Flight refund', date: '2026-09-01',
      total: { currency: 'USD', minorAmount: 30000 }, payments: [{ participantId: 'owner', money: { currency: 'USD', minorAmount: 30000 } }],
      allocations: [{ participantId: 'friend', money: { currency: 'USD', minorAmount: 30000 } }], category: 'Travel',
      splitMethod: { type: 'exact', allocations: [{ participantId: 'friend', money: { currency: 'USD', minorAmount: 30000 } }] }, reimbursement: true, attachmentRefs: [],
      recurrence: { frequency: 'monthly', anchor: { month: 9, day: 1 }, timeZone: 'America/Chicago' },
    }
    const identity: OperationIdentity = {
      userId: 'owner', operationId: command.operationId, kind: command.kind, groupId: command.groupId,
      requestFingerprint: '7'.repeat(64), resourceId: `operation-${'8'.repeat(48)}`,
    }

    const record = buildSparkExpenseRecord(command, { id: 'owner', displayName: 'Owner Account' }, identity, 'now')

    expect(record.expenseDocument).toMatchObject({ reimbursement: true })
    expect(record.templateDocument).toMatchObject({ reimbursement: true })
  })

  it('rejects Spark expense bundles that cannot be verified by the bounded rules path', () => {
    const base: ExpenseAddCommand = {
      kind: 'expense.add', operationId: 'expense-operation-2', groupId: 'group-a', description: 'Dinner', date: '2026-09-01',
      total: { currency: 'USD', minorAmount: 1000 }, payments: [{ participantId: 'owner', money: { currency: 'USD', minorAmount: 1000 } }],
      allocations: [{ participantId: 'owner', money: { currency: 'USD', minorAmount: 1000 } }], category: 'Food', splitMethod: { type: 'equal', participantIds: ['owner'] }, attachmentRefs: [],
    }
    const identity: OperationIdentity = { userId: 'owner', operationId: base.operationId, kind: 'expense.add', groupId: 'group-a', requestFingerprint: 'c'.repeat(64), resourceId: `operation-${'d'.repeat(48)}` }
    const actor = { id: 'owner', displayName: 'Owner Account' }

    expect(() => buildSparkExpenseRecord({ ...base, attachmentRefs: ['local-receipt:a'] }, actor, identity, 'now')).toThrow(/attachment/i)
    expect(() => buildSparkExpenseRecord(base, actor, { ...identity, userId: 'other' }, 'now')).toThrow(/identity/i)
    expect(() => buildSparkExpenseRecord({
      ...base,
      recurrence: { frequency: 'monthly', anchor: { month: 9, day: 2 }, timeZone: 'UTC' },
    }, actor, identity, 'now')).toThrow(/anchor/i)
    expect(() => buildSparkExpenseRecord({ ...base, allocations: Array.from({ length: 7 }, (_, index) => ({ participantId: `member-${index}`, money: { currency: 'USD' as const, minorAmount: index === 0 ? 1000 : 0 } })), splitMethod: { type: 'exact', allocations: Array.from({ length: 7 }, (_, index) => ({ participantId: `member-${index}`, money: { currency: 'USD' as const, minorAmount: index === 0 ? 1000 : 0 } })) } }, actor, identity, 'now')).toThrow(/six/i)
  })

  it('derives a deterministic active template and links it to the source expense', () => {
    const command: ExpenseAddCommand = {
      kind: 'expense.add', operationId: 'recurring-expense-operation', groupId: 'group-a', description: '  Monthly rent  ', date: '2026-09-01',
      total: { currency: 'USD', minorAmount: 180000 }, payments: [{ participantId: 'owner', money: { currency: 'USD', minorAmount: 180000 } }],
      allocations: [
        { participantId: 'owner', money: { currency: 'USD', minorAmount: 90000 } },
        { participantId: 'friend', money: { currency: 'USD', minorAmount: 90000 } },
      ],
      category: 'Housing', splitMethod: { type: 'equal', participantIds: ['owner', 'friend'] }, attachmentRefs: [],
      recurrence: { frequency: 'monthly', anchor: { month: 9, day: 1 }, timeZone: 'America/Chicago' },
    }
    const identity: OperationIdentity = {
      userId: 'owner', operationId: command.operationId, kind: command.kind, groupId: command.groupId,
      requestFingerprint: 'c'.repeat(64), resourceId: `operation-${'d'.repeat(48)}`,
    }
    const actor = { id: 'owner', displayName: 'Owner Account' }

    const record = buildSparkExpenseRecord(command, actor, identity, 'now')

    expect(record.templateId).toBe(`recurring-${'d'.repeat(48)}`)
    expect(record.expenseDocument).toMatchObject({
      recurrence: command.recurrence,
      recurringTemplateId: `recurring-${'d'.repeat(48)}`,
    })
    expect(record.templateDocument).toEqual({
      id: `recurring-${'d'.repeat(48)}`, groupId: 'group-a', sourceExpenseId: `expense-${'d'.repeat(48)}`,
      operationId: command.operationId, requestFingerprint: 'c'.repeat(64), resourceToken: 'd'.repeat(48),
      lastOperationId: command.operationId, lastRequestFingerprint: 'c'.repeat(64), lastResourceToken: 'd'.repeat(48),
      status: 'active', description: 'Monthly rent', total: { currency: 'USD', minorAmount: 180000 },
      payments: [{ participantId: 'owner', money: { currency: 'USD', minorAmount: 180000 } }],
      allocations: [
        { participantId: 'owner', money: { currency: 'USD', minorAmount: 90000 } },
        { participantId: 'friend', money: { currency: 'USD', minorAmount: 90000 } },
      ],
      payerIds: ['owner'], participantIds: ['owner', 'friend'], involvedMemberIds: ['friend', 'owner'],
      category: 'Housing', splitMethod: { type: 'exact', allocations: [
        { participantId: 'owner', money: { currency: 'USD', minorAmount: 90000 } },
        { participantId: 'friend', money: { currency: 'USD', minorAmount: 90000 } },
      ] },
      recurrence: command.recurrence, anchorDate: '2026-09-01', nextDate: '2026-10-01', revision: 1,
      createdAt: 'now', createdBy: actor, updatedAt: 'now', updatedBy: actor,
    })
  })

  it('preserves the series creator as occurrence author when another active member materializes it', () => {
    const templateId = `recurring-${'d'.repeat(48)}`
    const template = {
      id: templateId, groupId: 'group-a', sourceExpenseId: `expense-${'d'.repeat(48)}`,
      operationId: 'recurring-expense-operation', requestFingerprint: 'c'.repeat(64), resourceToken: 'd'.repeat(48),
      lastOperationId: 'recurring-expense-operation', lastRequestFingerprint: 'c'.repeat(64), lastResourceToken: 'd'.repeat(48),
      status: 'active', description: 'Monthly rent', total: { currency: 'USD', minorAmount: 180000 },
      payments: [{ participantId: 'owner', money: { currency: 'USD', minorAmount: 180000 } }],
      allocations: [{ participantId: 'owner', money: { currency: 'USD', minorAmount: 90000 } }, { participantId: 'friend', money: { currency: 'USD', minorAmount: 90000 } }],
      payerIds: ['owner'], participantIds: ['owner', 'friend'], involvedMemberIds: ['friend', 'owner'],
      category: 'Housing', splitMethod: { type: 'exact', allocations: [
        { participantId: 'owner', money: { currency: 'USD', minorAmount: 90000 } },
        { participantId: 'friend', money: { currency: 'USD', minorAmount: 90000 } },
      ] }, reimbursement: true,
      recurrence: { frequency: 'monthly', anchor: { month: 9, day: 1 }, timeZone: 'America/Chicago' },
      anchorDate: '2026-09-01', nextDate: '2026-10-01', revision: 1,
      createdBy: { id: 'owner', displayName: 'Owner Account' }, updatedAt: 'created', updatedBy: { id: 'owner', displayName: 'Owner Account' },
    } as const
    const command: RecurrenceMaterializeCommand = {
      kind: 'recurrence.materialize', operationId: 'materialize-rent-october', groupId: 'group-a', templateId, occurrenceDate: '2026-10-01',
    }
    const identity: OperationIdentity = {
      userId: 'friend', operationId: command.operationId, kind: command.kind, groupId: command.groupId,
      requestFingerprint: 'e'.repeat(64), resourceId: `operation-${'f'.repeat(48)}`,
    }
    const actor = { id: 'friend', displayName: 'Friend Account' }
    const committedAt = { kind: 'committed-at' }

    const record = sparkMutations.buildSparkRecurrenceMaterializationRecord(command, template, { actor, canManage: false }, identity, committedAt)

    expect(record.occurrenceId).toBe(`${templateId.startsWith('recurring-') ? 'occ_' : ''}${templateId}_2026-10-01`)
    expect(record.occurrenceDocument).toMatchObject({ reimbursement: true })
    expect(record.occurrenceDocument).toMatchObject({
      id: `occ_${templateId}_2026-10-01`, date: '2026-10-01', recurringTemplateId: templateId,
      operationId: command.operationId, resourceToken: 'f'.repeat(48),
      createdBy: template.createdBy, updatedBy: actor, revision: 1,
      payerIds: ['owner'], participantIds: ['owner', 'friend'], involvedMemberIds: ['friend', 'owner'],
    })
    expect(record.templateDocument).toMatchObject({
      id: templateId, status: 'active', nextDate: '2026-11-01', revision: 2,
      lastOccurrenceId: `occ_${templateId}_2026-10-01`, lastOccurrenceDate: '2026-10-01',
      lastOperationId: command.operationId, lastResourceToken: 'f'.repeat(48), updatedBy: actor,
    })
    expect(record.activityDocument).toMatchObject({
      operationId: command.operationId, kind: 'expense.created', expenseId: `occ_${templateId}_2026-10-01`, actor,
    })
  })

  it('allows an ordinary active member to materialize another creator series', () => {
    const templateId = `recurring-${'d'.repeat(48)}`
    const template = recurringTemplateRecord(templateId)
    const command: RecurrenceMaterializeCommand = {
      kind: 'recurrence.materialize', operationId: 'materialize-rent-october-denied', groupId: 'group-a', templateId, occurrenceDate: '2026-10-01',
    }
    const actor = { id: 'friend', displayName: 'Friend Account' }
    const identity: OperationIdentity = {
      userId: actor.id, operationId: command.operationId, kind: command.kind, groupId: command.groupId,
      requestFingerprint: 'a'.repeat(64), resourceId: `operation-${'b'.repeat(48)}`,
    }

    expect(sparkMutations.buildSparkRecurrenceMaterializationRecord(
      command, template, { actor, canManage: false }, identity, 'now',
    )).toMatchObject({
      occurrenceDocument: { createdBy: template.createdBy, updatedBy: actor },
      templateDocument: { createdBy: template.createdBy, updatedBy: actor, revision: 2 },
    })
  })

  it('cancels only the expected active template revision', () => {
    const templateId = 'recurring-rent'
    const template = {
      id: templateId, groupId: 'group-a', sourceExpenseId: 'expense-rent', status: 'active', description: 'Rent',
      total: { currency: 'USD', minorAmount: 1000 }, payments: [{ participantId: 'owner', money: { currency: 'USD', minorAmount: 1000 } }],
      allocations: [{ participantId: 'owner', money: { currency: 'USD', minorAmount: 1000 } }], category: 'Housing', reimbursement: true,
      splitMethod: { type: 'equal', participantIds: ['owner'] }, recurrence: { frequency: 'monthly', anchor: { month: 9, day: 1 }, timeZone: 'UTC' },
      anchorDate: '2026-09-01', nextDate: '2026-10-01', revision: 2, createdBy: { id: 'owner', displayName: 'Owner' },
    } as const
    const command: RecurrenceCancelCommand = { kind: 'recurrence.cancel', operationId: 'cancel-rent', groupId: 'group-a', templateId, expectedRevision: 2 }
    const identity: OperationIdentity = {
      userId: 'owner', operationId: command.operationId, kind: command.kind, groupId: command.groupId,
      requestFingerprint: '1'.repeat(64), resourceId: `operation-${'2'.repeat(48)}`,
    }

    const cancelled = sparkMutations.buildSparkRecurrenceCancellationRecord(command, template, { actor: { id: 'owner', displayName: 'Owner' }, canManage: false }, identity, 'now')

    expect(cancelled).toMatchObject({ status: 'cancelled', revision: 3, lastOperationId: 'cancel-rent', lastResourceToken: '2'.repeat(48), updatedAt: 'now' })
    expect(() => sparkMutations.buildSparkRecurrenceCancellationRecord({ ...command, expectedRevision: 1 }, template, { actor: { id: 'owner', displayName: 'Owner' }, canManage: false }, identity, 'now')).toThrow(/changed remotely/i)
    const memberIdentity = { ...identity, userId: 'friend', operationId: 'cancel-rent-member' }
    expect(sparkMutations.buildSparkRecurrenceCancellationRecord(
      { ...command, operationId: memberIdentity.operationId }, template,
      { actor: { id: 'friend', displayName: 'Friend' }, canManage: false }, memberIdentity, 'now',
    )).toMatchObject({ status: 'cancelled', revision: 3, updatedBy: { id: 'friend', displayName: 'Friend' } })
  })

  it('updates future template fields only from the latest generated occurrence', () => {
    const templateId = 'recurring-rent'
    const occurrenceId = `occ_${templateId}_2026-10-01`
    const template = {
      id: templateId, groupId: 'group-a', sourceExpenseId: 'expense-rent', status: 'active', description: 'Rent',
      total: { currency: 'USD', minorAmount: 1000 }, payments: [{ participantId: 'owner', money: { currency: 'USD', minorAmount: 1000 } }],
      allocations: [{ participantId: 'owner', money: { currency: 'USD', minorAmount: 1000 } }], category: 'Housing', reimbursement: true,
      splitMethod: { type: 'equal', participantIds: ['owner'] }, recurrence: { frequency: 'monthly', anchor: { month: 9, day: 1 }, timeZone: 'UTC' },
      anchorDate: '2026-09-01', nextDate: '2026-11-01', revision: 2, createdBy: { id: 'owner', displayName: 'Owner' },
      lastOccurrenceId: occurrenceId, lastOccurrenceDate: '2026-10-01',
    } as const
    const command: ExpenseEditCommand = {
      kind: 'expense.edit', operationId: 'edit-future-rent', groupId: 'group-a', expenseId: occurrenceId, expectedRevision: 1,
      draft: {
        groupId: 'group-a', description: 'Rent plus parking', date: '2026-10-15', total: { currency: 'USD', minorAmount: 1200 },
        payments: [{ participantId: 'owner', money: { currency: 'USD', minorAmount: 1200 } }],
        allocations: [{ participantId: 'owner', money: { currency: 'USD', minorAmount: 1200 } }], category: 'Housing',
        splitMethod: { type: 'equal', participantIds: ['owner'] }, attachmentRefs: [],
        recurrence: { frequency: 'fortnightly', anchor: { month: 10, day: 15 }, timeZone: 'UTC' }, occurrenceEditScope: 'future',
      },
    }
    const identity: OperationIdentity = {
      userId: 'owner', operationId: command.operationId, kind: command.kind, groupId: command.groupId,
      requestFingerprint: '3'.repeat(64), resourceId: `operation-${'4'.repeat(48)}`,
    }

    const changed = sparkMutations.buildSparkFutureRecurringTemplateRecord(command, { id: occurrenceId, recurringTemplateId: templateId }, template, { actor: { id: 'owner', displayName: 'Owner' }, canManage: false }, identity, 'now')

    expect(changed).toMatchObject({
      description: 'Rent plus parking', total: { currency: 'USD', minorAmount: 1200 }, recurrence: command.draft.recurrence,
      anchorDate: '2026-10-15', nextDate: '2026-10-29', revision: 3, lastOperationId: command.operationId, updatedBy: { id: 'owner' },
    })
    expect(changed).not.toHaveProperty('reimbursement')
    expect(() => sparkMutations.buildSparkFutureRecurringTemplateRecord(
      { ...command, expenseId: 'expense-rent' }, { id: 'expense-rent', recurringTemplateId: templateId }, template,
      { actor: { id: 'owner', displayName: 'Owner' }, canManage: false }, identity, 'now',
    )).toThrow(/latest/i)
    const memberCommand = { ...command, operationId: 'edit-future-rent-member' }
    const memberIdentity = { ...identity, userId: 'friend', operationId: memberCommand.operationId }
    expect(sparkMutations.buildSparkFutureRecurringTemplateRecord(
      memberCommand, { id: occurrenceId, recurringTemplateId: templateId }, template,
      { actor: { id: 'friend', displayName: 'Friend' }, canManage: false }, memberIdentity, 'now',
    )).toMatchObject({ description: 'Rent plus parking', revision: 3, updatedBy: { id: 'friend', displayName: 'Friend' } })
  })

  it('builds replay-bound edit and soft-delete records while preserving every prior revision', () => {
    const addCommand: ExpenseAddCommand = {
      kind: 'expense.add', operationId: 'create-expense', groupId: 'group-a', description: 'Original dinner', date: '2026-09-01',
      total: { currency: 'USD', minorAmount: 4200 }, payments: [{ participantId: 'owner', money: { currency: 'USD', minorAmount: 4200 } }],
      allocations: [{ participantId: 'owner', money: { currency: 'USD', minorAmount: 1800 } }, { participantId: 'friend', money: { currency: 'USD', minorAmount: 2400 } }],
      category: 'Food', splitMethod: { type: 'exact', allocations: [{ participantId: 'owner', money: { currency: 'USD', minorAmount: 1800 } }, { participantId: 'friend', money: { currency: 'USD', minorAmount: 2400 } }] },
      notes: 'Original note', attachmentRefs: [],
    }
    const creator: ActorSnapshot = { id: 'owner', displayName: 'Owner Account' }
    const createdAt = { kind: 'created-at', toDate: () => new Date('2026-09-01T10:00:00.000Z') }
    const creationIdentity: OperationIdentity = { userId: 'owner', operationId: addCommand.operationId, kind: 'expense.add', groupId: 'group-a', requestFingerprint: 'a'.repeat(64), resourceId: `operation-${'b'.repeat(48)}` }
    const current = buildSparkExpenseRecord(addCommand, creator, creationIdentity, createdAt).expenseDocument
    const editCommand: ExpenseEditCommand = {
      kind: 'expense.edit', operationId: 'edit-expense', groupId: 'group-a', expenseId: String(current.id), expectedRevision: 1,
      draft: {
        groupId: 'group-a', description: 'Updated dinner', date: '2026-09-02', total: { currency: 'USD', minorAmount: 5000 },
        payments: [{ participantId: 'owner', money: { currency: 'USD', minorAmount: 5000 } }],
        allocations: [{ participantId: 'owner', money: { currency: 'USD', minorAmount: 2500 } }, { participantId: 'friend', money: { currency: 'USD', minorAmount: 2500 } }],
        category: 'Dining', splitMethod: { type: 'equal', participantIds: ['owner', 'friend'] }, attachmentRefs: [],
      },
    }
    const editIdentity: OperationIdentity = { userId: 'owner', operationId: editCommand.operationId, kind: 'expense.edit', groupId: 'group-a', requestFingerprint: 'c'.repeat(64), resourceId: `operation-${'d'.repeat(48)}` }
    const updatedAt = { kind: 'updated-at', toDate: () => new Date('2026-09-02T10:00:00.000Z') }
    const buildMutation = (sparkMutations as unknown as { buildSparkExpenseMutationRecord: SparkMutationBuilder }).buildSparkExpenseMutationRecord

    const edit = buildMutation(editCommand, current, current, { actor: creator, canManage: false }, editIdentity, updatedAt)

    expect(edit.revisionId).toBe('d'.repeat(48))
    expect(edit.headDocument).toMatchObject({
      id: current.id, description: current.description, revision: 1, headRevision: 2, headDeleted: false,
      lastOperationId: 'edit-expense', lastRequestFingerprint: 'c'.repeat(64), lastResourceToken: 'd'.repeat(48),
      current: { id: current.id, description: 'Updated dinner', revision: 2 },
    })
    expect(edit.revisionDocument).toMatchObject({
      groupId: 'group-a', expenseId: current.id, revision: 2, operationId: 'edit-expense', action: 'updated',
      actor: creator, createdAt: updatedAt,
    })
    expect(edit.revisionDocument.expense).toMatchObject({
      id: current.id, groupId: 'group-a', operationId: 'create-expense', requestFingerprint: 'a'.repeat(64), resourceToken: 'b'.repeat(48),
      lastOperationId: 'edit-expense', lastRequestFingerprint: 'c'.repeat(64), lastResourceToken: 'd'.repeat(48),
      description: 'Updated dinner', total: { currency: 'USD', minorAmount: 5000 }, splitType: 'equal',
      splitMethod: { type: 'exact', allocations: editCommand.draft.allocations }, createdAt, createdBy: creator, updatedAt, updatedBy: creator, revision: 2,
    })
    expect(edit.revisionDocument.expense).not.toHaveProperty('notes')
    expect(edit.activityId).toBe(`activity-${'d'.repeat(48)}`)
    expect(edit.activityDocument).toEqual({
      groupId: 'group-a', operationId: 'edit-expense', kind: 'expense.updated',
      subject: { kind: 'expense', id: current.id, label: 'Updated dinner' },
      actor: creator, expenseId: current.id, resourceToken: 'd'.repeat(48), revision: 2, createdAt: updatedAt,
    })

    const deleteCommand: ExpenseDeleteCommand = { kind: 'expense.delete', operationId: 'delete-expense', groupId: 'group-a', expenseId: String(current.id), expectedRevision: 2 }
    const deleteIdentity: OperationIdentity = { userId: 'owner', operationId: deleteCommand.operationId, kind: 'expense.delete', groupId: 'group-a', requestFingerprint: 'e'.repeat(64), resourceId: `operation-${'f'.repeat(48)}` }
    const deletedAt = { kind: 'deleted-at', toDate: () => new Date('2026-09-03T10:00:00.000Z') }
    const editedExpense = edit.revisionDocument.expense as Readonly<Record<string, unknown>>
    const removed = buildMutation(deleteCommand, edit.headDocument, editedExpense, { actor: creator, canManage: false }, deleteIdentity, deletedAt)

    expect(removed.headDocument).toMatchObject({
      description: current.description, revision: 1, headRevision: 3, headDeleted: true,
      lastOperationId: 'delete-expense', lastRequestFingerprint: 'e'.repeat(64), lastResourceToken: 'f'.repeat(48),
      current: { description: 'Updated dinner', revision: 3, deletedAt },
    })
    expect(removed.revisionDocument).toMatchObject({ revision: 3, operationId: 'delete-expense', action: 'deleted', actor: creator, createdAt: deletedAt })
    expect(removed.revisionDocument.expense).toMatchObject({
      lastOperationId: 'delete-expense', lastRequestFingerprint: 'e'.repeat(64), lastResourceToken: 'f'.repeat(48),
      description: 'Updated dinner', revision: 3, updatedAt: deletedAt, updatedBy: creator, deletedAt,
    })
    expect(removed.activityId).toBe(`activity-${'f'.repeat(48)}`)
    expect(removed.activityDocument).toEqual({
      groupId: 'group-a', operationId: 'delete-expense', kind: 'expense.deleted',
      subject: { kind: 'expense', id: current.id, label: 'Updated dinner' },
      actor: creator, expenseId: current.id, resourceToken: 'f'.repeat(48), revision: 3, createdAt: deletedAt,
    })

    const restoreCommand: ExpenseRestoreCommand = { kind: 'expense.restore', operationId: 'restore-expense', groupId: 'group-a', expenseId: String(current.id), expectedRevision: 3 }
    const restoreIdentity: OperationIdentity = { userId: 'owner', operationId: restoreCommand.operationId, kind: restoreCommand.kind, groupId: 'group-a', requestFingerprint: '1'.repeat(64), resourceId: `operation-${'2'.repeat(48)}` }
    const restoredAt = { kind: 'restored-at', toDate: () => new Date('2026-09-04T10:00:00.000Z') }
    const restored = buildMutation(restoreCommand, removed.headDocument, removed.revisionDocument.expense, { actor: creator, canManage: false }, restoreIdentity, restoredAt)

    expect(restored.headDocument).toMatchObject({
      headRevision: 4, headDeleted: false,
      lastOperationId: 'restore-expense', lastRequestFingerprint: '1'.repeat(64), lastResourceToken: '2'.repeat(48),
      current: { description: 'Updated dinner', revision: 4, updatedAt: restoredAt, updatedBy: creator },
    })
    expect((restored.headDocument.current as Record<string, unknown>).deletedAt).toBeUndefined()
    expect(restored.revisionDocument).toMatchObject({ revision: 4, operationId: 'restore-expense', action: 'restored', actor: creator, createdAt: restoredAt })
    expect(restored.revisionDocument.expense.deletedAt).toBeUndefined()
    expect(restored.activityDocument).toEqual({
      groupId: 'group-a', operationId: 'restore-expense', kind: 'expense.restored',
      subject: { kind: 'expense', id: current.id, label: 'Updated dinner' },
      actor: creator, expenseId: current.id, resourceToken: '2'.repeat(48), revision: 4, createdAt: restoredAt,
    })
  })

  it('rejects stale mutations while allowing another active member to construct an attributed audit record', () => {
    const add: ExpenseAddCommand = {
      kind: 'expense.add', operationId: 'create-owned', groupId: 'group-a', description: 'Owned expense', date: '2026-09-01',
      total: { currency: 'USD', minorAmount: 1000 }, payments: [{ participantId: 'owner', money: { currency: 'USD', minorAmount: 1000 } }],
      allocations: [{ participantId: 'owner', money: { currency: 'USD', minorAmount: 1000 } }], category: 'Food',
      splitMethod: { type: 'equal', participantIds: ['owner'] }, attachmentRefs: [],
    }
    const creator = { id: 'owner', displayName: 'Owner Account' }
    const current = buildSparkExpenseRecord(add, creator, { userId: 'owner', operationId: add.operationId, kind: 'expense.add', groupId: 'group-a', requestFingerprint: '1'.repeat(64), resourceId: `operation-${'2'.repeat(48)}` }, { toDate: () => new Date('2026-09-01T10:00:00.000Z') }).expenseDocument
    const stale: ExpenseDeleteCommand = { kind: 'expense.delete', operationId: 'stale-delete', groupId: 'group-a', expenseId: String(current.id), expectedRevision: 2 }
    const friendCommand: ExpenseDeleteCommand = { ...stale, operationId: 'friend-delete', expectedRevision: 1 }
    const buildMutation = (sparkMutations as unknown as { buildSparkExpenseMutationRecord: SparkMutationBuilder }).buildSparkExpenseMutationRecord

    expect(() => buildMutation(stale, current, current, { actor: creator, canManage: false }, { userId: 'owner', operationId: stale.operationId, kind: stale.kind, groupId: 'group-a', requestFingerprint: '3'.repeat(64), resourceId: `operation-${'4'.repeat(48)}` }, 'deleted')).toThrow(/changed remotely/i)
    const collaborator = buildMutation(friendCommand, current, current, { actor: { id: 'friend', displayName: 'Friend Account' }, canManage: false }, { userId: 'friend', operationId: friendCommand.operationId, kind: friendCommand.kind, groupId: 'group-a', requestFingerprint: '5'.repeat(64), resourceId: `operation-${'6'.repeat(48)}` }, 'deleted')
    expect(collaborator.revisionDocument).toMatchObject({
      action: 'deleted', actor: { id: 'friend', displayName: 'Friend Account' },
      expense: { createdBy: creator, updatedBy: { id: 'friend', displayName: 'Friend Account' } },
    })
    expect(() => buildMutation({ ...friendCommand, operationId: 'manager-delete' }, current, current, { actor: { id: 'manager', displayName: 'Manager Account' }, canManage: true }, { userId: 'manager', operationId: 'manager-delete', kind: friendCommand.kind, groupId: 'group-a', requestFingerprint: '7'.repeat(64), resourceId: `operation-${'8'.repeat(48)}` }, 'deleted')).not.toThrow()
  })

  it('builds replay-bound Spark comments and companion activity records', () => {
    const command: CommentAddCommand = {
      kind: 'comment.add', operationId: 'comment-add', groupId: 'group-a', expenseId: 'expense-a', body: '  Dessert was worth it.  ', attachmentRefs: [],
    }
    const actor = { id: 'friend', displayName: 'Friend Account' }
    const identity: OperationIdentity = { userId: 'friend', operationId: command.operationId, kind: command.kind, groupId: command.groupId, requestFingerprint: 'a'.repeat(64), resourceId: `operation-${'b'.repeat(48)}` }
    const createdAt = { kind: 'comment-created' }
    const buildComment = (sparkMutations as unknown as { buildSparkCommentRecord: SparkCommentBuilder }).buildSparkCommentRecord

    const record = buildComment(command, actor, identity, createdAt)

    expect(record.commentId).toBe(`comment-${'b'.repeat(48)}`)
    expect(record.activityId).toBe(`activity-${'b'.repeat(48)}`)
    expect(record.commentDocument).toEqual({
      groupId: 'group-a', expenseId: 'expense-a', operationId: 'comment-add', requestFingerprint: 'a'.repeat(64), resourceToken: 'b'.repeat(48),
      lastOperationId: 'comment-add', lastRequestFingerprint: 'a'.repeat(64), lastResourceToken: 'b'.repeat(48),
      author: actor, body: 'Dessert was worth it.', attachmentRefs: [], createdAt,
    })
    expect(record.activityDocument).toEqual({
      groupId: 'group-a', operationId: 'comment-add', kind: 'comment.added', subject: { kind: 'comment', id: record.commentId, label: 'Dessert was worth it.' },
      actor, expenseId: 'expense-a', commentId: record.commentId, createdAt,
    })
    expect(() => buildComment({ ...command, operationId: 'with-file', attachmentRefs: ['asset-a'] }, actor, { ...identity, operationId: 'with-file' }, createdAt)).toThrow(/attachment/i)
  })

  it('builds author-only replay-bound Spark comment soft deletes', () => {
    const add: CommentAddCommand = { kind: 'comment.add', operationId: 'comment-add', groupId: 'group-a', expenseId: 'expense-a', body: 'Delete this', attachmentRefs: [] }
    const author = { id: 'friend', displayName: 'Friend Account' }
    const addIdentity: OperationIdentity = { userId: 'friend', operationId: add.operationId, kind: add.kind, groupId: add.groupId, requestFingerprint: 'c'.repeat(64), resourceId: `operation-${'d'.repeat(48)}` }
    const buildComment = (sparkMutations as unknown as { buildSparkCommentRecord: SparkCommentBuilder }).buildSparkCommentRecord
    const current = buildComment(add, author, addIdentity, { kind: 'created' }).commentDocument
    const command: CommentDeleteCommand = { kind: 'comment.delete', operationId: 'comment-delete', groupId: 'group-a', expenseId: 'expense-a', commentId: `comment-${'d'.repeat(48)}` }
    const identity: OperationIdentity = { userId: 'friend', operationId: command.operationId, kind: command.kind, groupId: command.groupId, requestFingerprint: 'e'.repeat(64), resourceId: `operation-${'f'.repeat(48)}` }
    const deletedAt = { kind: 'comment-deleted' }
    const buildDelete = (sparkMutations as unknown as { buildSparkCommentDeleteRecord: SparkCommentDeleteBuilder }).buildSparkCommentDeleteRecord

    const removed = buildDelete(command, current, author, identity, deletedAt)

    expect(removed.commentDocument).toEqual({
      ...current, lastOperationId: 'comment-delete', lastRequestFingerprint: 'e'.repeat(64), lastResourceToken: 'f'.repeat(48), deletedAt,
    })
    expect(removed.activityId).toBe(`activity-${'f'.repeat(48)}`)
    expect(removed.activityDocument).toMatchObject({ operationId: 'comment-delete', kind: 'comment.deleted', actor: author, expenseId: 'expense-a', commentId: command.commentId, createdAt: deletedAt })
    expect(() => buildDelete(command, current, { id: 'owner', displayName: 'Owner Account' }, { ...identity, userId: 'owner' }, deletedAt)).toThrow(/author/i)
  })

  it('builds a replay-bound confirmed settlement and immutable payment activity', () => {
    const command: SettlementRecordCommand = {
      kind: 'settlement.record', operationId: 'settlement-record', groupId: 'group-a', expectedBalanceRevision: 4,
      basis: { kind: 'simplified', senderId: 'friend', recipientId: 'owner', currency: 'USD', debtMinor: 2400 },
      money: { currency: 'USD', minorAmount: 1800 }, method: 'bank-transfer', occurredOn: '2026-09-01',
      note: '  September rent  ', outsidePaymentConfirmed: true,
    }
    const actor = { id: 'friend', displayName: 'Friend Account' }
    const identity: OperationIdentity = {
      userId: actor.id, operationId: command.operationId, kind: command.kind, groupId: command.groupId,
      requestFingerprint: '1'.repeat(64), resourceId: `operation-${'2'.repeat(48)}`,
    }
    const committedAt = { kind: 'settlement-created', toDate: () => new Date('2026-09-01T18:00:00.000Z') }
    const buildSettlement = (sparkMutations as unknown as { buildSparkSettlementRecord: SparkSettlementBuilder }).buildSparkSettlementRecord

    const record = buildSettlement(command, actor, identity, committedAt)

    expect(record.settlementId).toBe(`settlement-${'2'.repeat(48)}`)
    expect(record.settlementDocument).toEqual({
      settlementId: record.settlementId, groupId: 'group-a', operationId: command.operationId,
      requestFingerprint: '1'.repeat(64), resourceToken: '2'.repeat(48),
      lastOperationId: command.operationId, lastRequestFingerprint: '1'.repeat(64), lastResourceToken: '2'.repeat(48),
      senderId: 'friend', recipientId: 'owner', money: { currency: 'USD', minorAmount: 1800 }, basis: command.basis,
      method: 'bank-transfer', occurredOn: '2026-09-01', note: 'September rent', outsidePaymentConfirmed: true,
      createdBy: actor, createdAt: committedAt, revision: 1,
    })
    expect(record.activityId).toBe(`activity-${'2'.repeat(48)}`)
    expect(record.activityDocument).toEqual({
      groupId: 'group-a', operationId: command.operationId, kind: 'settlement.created',
      subject: { kind: 'settlement', id: record.settlementId, label: 'Payment recorded' },
      actor, settlementId: record.settlementId, createdAt: committedAt,
    })
  })

  it('builds the only allowed settlement transition as an authorized revision-two void', () => {
    const recordCommand: SettlementRecordCommand = {
      kind: 'settlement.record', operationId: 'settlement-record', groupId: 'group-a', expectedBalanceRevision: 4,
      basis: { kind: 'pairwise', senderId: 'friend', recipientId: 'owner', currency: 'USD', debtMinor: 2400 },
      money: { currency: 'USD', minorAmount: 1800 }, method: 'cash', occurredOn: '2026-09-01', outsidePaymentConfirmed: true,
    }
    const creator = { id: 'friend', displayName: 'Friend Account' }
    const buildSettlement = (sparkMutations as unknown as { buildSparkSettlementRecord: SparkSettlementBuilder }).buildSparkSettlementRecord
    const current = buildSettlement(recordCommand, creator, {
      userId: creator.id, operationId: recordCommand.operationId, kind: recordCommand.kind, groupId: recordCommand.groupId,
      requestFingerprint: '3'.repeat(64), resourceId: `operation-${'4'.repeat(48)}`,
    }, { toDate: () => new Date('2026-09-01T18:00:00.000Z') }).settlementDocument
    const command: SettlementVoidCommand = {
      kind: 'settlement.void', operationId: 'settlement-void', groupId: 'group-a', settlementId: String(current.settlementId),
      expectedRevision: 1, expectedBalanceRevision: 5, reason: '  Entered twice by mistake.  ',
    }
    const identity: OperationIdentity = {
      userId: creator.id, operationId: command.operationId, kind: command.kind, groupId: command.groupId,
      requestFingerprint: '5'.repeat(64), resourceId: `operation-${'6'.repeat(48)}`,
    }
    const committedAt = { kind: 'settlement-voided', toDate: () => new Date('2026-09-02T18:00:00.000Z') }
    const buildVoid = (sparkMutations as unknown as { buildSparkSettlementVoidRecord: SparkSettlementVoidBuilder }).buildSparkSettlementVoidRecord

    const record = buildVoid(command, current, { actor: creator, canManage: false }, identity, committedAt)

    expect(record.settlementDocument).toEqual({
      ...current, lastOperationId: command.operationId, lastRequestFingerprint: '5'.repeat(64), lastResourceToken: '6'.repeat(48), revision: 2,
      void: { operationId: command.operationId, reason: 'Entered twice by mistake.', actor: creator, createdAt: committedAt, revision: 2 },
    })
    expect(record.activityDocument).toEqual({
      groupId: 'group-a', operationId: command.operationId, kind: 'settlement.voided',
      subject: { kind: 'settlement', id: command.settlementId, label: 'Payment voided' },
      actor: creator, settlementId: command.settlementId, createdAt: committedAt,
    })
    expect(() => buildVoid({ ...command, operationId: 'stale', expectedRevision: 2 }, current, { actor: creator, canManage: false }, { ...identity, operationId: 'stale' }, committedAt)).toThrow(/changed remotely/i)
    expect(() => buildVoid(command, current, { actor: { id: 'owner', displayName: 'Owner Account' }, canManage: false }, { ...identity, userId: 'owner' }, committedAt)).toThrow(/author|manager/i)
  })

  it('versions Simplify Debts with immutable activity and an unchanged-plan balance revision', () => {
    const command: GroupSimplifyDebtsCommand = { kind: 'group.simplify-debts', operationId: 'simplify-off', groupId: 'group-a', expectedRevision: 4, simplifyDebtsEnabled: false }
    const actor = { id: 'friend', displayName: 'Friend Account' }
    const identity: OperationIdentity = { userId: actor.id, operationId: command.operationId, kind: command.kind, groupId: command.groupId, requestFingerprint: '1'.repeat(64), resourceId: `operation-${'2'.repeat(48)}` }
    const defaultSplit = { type: 'shares' as const, participantIds: ['owner', 'friend'], shares: { owner: 2, friend: 1 } }
    const current = { schemaVersion: 1, groupId: 'group-a', revision: 4, defaultSplit, simplifyDebtsEnabled: true, updatedAt: 'old' }
    const pairwise = [{ fromParticipantId: 'friend', toParticipantId: 'owner', money: { currency: 'USD', minorAmount: 500 } }]
    const simplified = [{ fromParticipantId: 'friend', toParticipantId: 'owner', money: { currency: 'USD', minorAmount: 500 } }]
    const balance = { groupId: 'group-a', balanceRevision: 7, simplifyDebtsEnabled: true, pairwise, simplified }
    const committedAt = { kind: 'settings-updated' }
    const buildSettings = (sparkMutations as unknown as { buildSparkGroupSettingsRecord: SparkGroupSettingsBuilder }).buildSparkGroupSettingsRecord

    const record = buildSettings(command, current, balance, groupMembers, actor, identity, committedAt)

    expect(record.settingsDocument).toEqual({
      schemaVersion: 1, groupId: 'group-a', revision: 5, defaultSplit, simplifyDebtsEnabled: false,
      lastCommandKind: 'group.simplify-debts', lastOperationId: command.operationId,
      lastRequestFingerprint: '1'.repeat(64), lastResourceToken: '2'.repeat(48), updatedAt: committedAt, updatedBy: actor,
    })
    expect(record.balanceDocument).toEqual({ groupId: 'group-a', balanceRevision: 8, simplifyDebtsEnabled: false, pairwise, simplified })
    expect(record.activityId).toBe(`activity-${'2'.repeat(48)}`)
    expect(record.activityDocument).toEqual({
      groupId: 'group-a', operationId: command.operationId, kind: 'group.event',
      subject: { kind: 'group', id: 'group-a', label: 'Simplify debts disabled' }, actor, createdAt: committedAt,
    })
    expect(() => buildSettings({ ...command, operationId: 'stale', expectedRevision: 3 }, current, balance, groupMembers, actor, { ...identity, operationId: 'stale' }, committedAt)).toThrow(/changed remotely/i)
  })

  it('lets only a manager save or clear a validated Pro default split without changing balances', () => {
    const command: GroupDefaultSplitCommand = {
      kind: 'group.default-split', operationId: 'default-percentage', groupId: 'group-a', expectedRevision: 1,
      defaultSplit: { type: 'percentage', participantIds: ['owner', 'friend'], percentages: { owner: 60, friend: 40 } },
    }
    const actor = { id: 'owner', displayName: 'Owner Account' }
    const identity: OperationIdentity = { userId: actor.id, operationId: command.operationId, kind: command.kind, groupId: command.groupId, requestFingerprint: '3'.repeat(64), resourceId: `operation-${'4'.repeat(48)}` }
    const current = { schemaVersion: 1, groupId: 'group-a', revision: 1, simplifyDebtsEnabled: false, updatedAt: 'old' }
    const committedAt = { kind: 'default-updated' }
    const buildSettings = (sparkMutations as unknown as { buildSparkGroupSettingsRecord: SparkGroupSettingsBuilder }).buildSparkGroupSettingsRecord

    const saved = buildSettings(command, current, undefined, groupMembers, actor, identity, committedAt)

    expect(saved.settingsDocument).toEqual({
      schemaVersion: 1, groupId: 'group-a', revision: 2, defaultSplit: command.defaultSplit, simplifyDebtsEnabled: false,
      lastCommandKind: 'group.default-split', lastOperationId: command.operationId,
      lastRequestFingerprint: '3'.repeat(64), lastResourceToken: '4'.repeat(48), updatedAt: committedAt, updatedBy: actor,
    })
    expect(saved.balanceDocument).toBeUndefined()
    expect(saved.activityDocument).toMatchObject({ kind: 'group.event', subject: { kind: 'group', id: 'group-a', label: 'Default split updated' }, actor })
    expect(() => buildSettings(command, current, undefined, groupMembers, { id: 'friend', displayName: 'Friend Account' }, { ...identity, userId: 'friend' }, committedAt)).toThrow(/manager/i)

    const clear = { ...command, operationId: 'default-clear', expectedRevision: 2, defaultSplit: null }
    const cleared = buildSettings(clear, saved.settingsDocument, undefined, groupMembers, actor, { ...identity, operationId: clear.operationId, requestFingerprint: '5'.repeat(64), resourceId: `operation-${'6'.repeat(48)}` }, committedAt)
    expect(cleared.settingsDocument).not.toHaveProperty('defaultSplit')
    expect(cleared.activityDocument).toMatchObject({ subject: { label: 'Default split cleared' } })
  })

  it('versions one manager-only applied conversion with a server cutoff and balance invalidation', () => {
    const command: GroupCurrencyConversionCommand = {
      kind: 'group.currency-conversion', operationId: 'convert-usd-eur', groupId: 'group-a', expectedRevision: 4, targetCurrency: 'EUR',
      rates: [{ baseCurrency: 'USD', quoteCurrency: 'EUR', numerator: 86_237, denominator: 100_000, authority: 'ECB', effectiveDate: '2026-08-29', observedAt: '2026-09-01T11:59:00.000Z' }],
    }
    const actor = { id: 'owner', displayName: 'Owner Account' }
    const identity: OperationIdentity = { userId: actor.id, operationId: command.operationId, kind: command.kind, groupId: command.groupId, requestFingerprint: '9'.repeat(64), resourceId: `operation-${'a'.repeat(48)}` }
    const current = { schemaVersion: 1, groupId: 'group-a', revision: 4, simplifyDebtsEnabled: true, updatedAt: 'old' }
    const pairwise = [{ fromParticipantId: 'friend', toParticipantId: 'owner', money: { currency: 'USD', minorAmount: 500 } }]
    const simplified = [{ fromParticipantId: 'friend', toParticipantId: 'owner', money: { currency: 'USD', minorAmount: 500 } }]
    const balance = { groupId: 'group-a', balanceRevision: 7, simplifyDebtsEnabled: true, pairwise, simplified }
    const committedAt = { kind: 'currency-converted' }
    const buildSettings = (sparkMutations as unknown as { buildSparkGroupSettingsRecord: SparkGroupSettingsBuilder }).buildSparkGroupSettingsRecord

    const record = buildSettings(command, current, balance, groupMembers, actor, identity, committedAt)

    expect(record.settingsDocument).toEqual({
      schemaVersion: 1, groupId: 'group-a', revision: 5, simplifyDebtsEnabled: true,
      currencyConversion: { schemaVersion: 1, operationId: command.operationId, targetCurrency: 'EUR', convertedAt: committedAt },
      lastCommandKind: command.kind, lastOperationId: command.operationId, lastRequestFingerprint: '9'.repeat(64), lastResourceToken: 'a'.repeat(48),
      updatedAt: committedAt, updatedBy: actor,
    })
    expect(record.balanceDocument).toEqual({ groupId: 'group-a', balanceRevision: 8, simplifyDebtsEnabled: true, pairwise, simplified })
    expect(record.currencyConversionId).toBe(`conversion-${'a'.repeat(48)}`)
    expect(record.currencyConversionDocument).toEqual({
      schemaVersion: 1, groupId: 'group-a', operationId: command.operationId, targetCurrency: 'EUR', convertedAt: committedAt,
      sourceCurrencies: ['USD'],
    })
    expect(record.currencyRateDocuments).toEqual([{ id: 'USD', document: {
      schemaVersion: 1, groupId: 'group-a', conversionId: `conversion-${'a'.repeat(48)}`, operationId: command.operationId,
      ...command.rates[0],
    } }])
    expect(record.activityDocument).toMatchObject({ kind: 'group.event', subject: { kind: 'group', id: 'group-a', label: 'Currencies converted to EUR' }, actor })
    expect(() => buildSettings(command, current, balance, groupMembers, { id: 'friend', displayName: 'Friend Account' }, { ...identity, userId: 'friend' }, committedAt)).toThrow(/manager/i)
  })

  it('builds one replay-bound safe member removal bundle and clears a now-invalid default', () => {
    const command: GroupMemberRemoveCommand = { kind: 'group.member-remove', operationId: 'remove-friend', groupId: 'group-a', targetMemberId: 'friend' }
    const identity: OperationIdentity = {
      userId: 'owner', operationId: command.operationId, kind: command.kind, groupId: command.groupId,
      requestFingerprint: '7'.repeat(64), resourceId: `operation-${'8'.repeat(48)}`,
    }
    const committedAt = { kind: 'member-removed' }
    const group = { id: 'group-a', kind: 'group', name: 'Group A', currency: 'USD', memberIds: ['owner', 'friend'], createdByUid: 'owner', createdAt: 'created', updatedAt: 'old' }
    const target = {
      status: 'active', role: 'member', canManage: false, displayName: 'Friend Account', initials: 'FA', avatarUrl: null,
      paymentHandles: { paypal: 'friend.payments', venmo: 'friend-payments' }, invitationId: 'invite-a', joinedAt: 'joined',
    }
    const settings = { schemaVersion: 1, groupId: 'group-a', revision: 3, simplifyDebtsEnabled: true, defaultSplit: { type: 'equal', participantIds: ['owner', 'friend'] } }
    const buildRemoval = (sparkMutations as unknown as { buildSparkMemberRemovalRecord: SparkMemberRemovalBuilder }).buildSparkMemberRemovalRecord

    const record = buildRemoval(command, group, target, settings, {
      actor: { id: 'owner', displayName: 'Owner Account', initials: 'OA', isCurrentUser: true, canManage: true, role: 'owner' },
      target: { id: 'friend', displayName: 'Friend Account', initials: 'FA', isCurrentUser: false, canManage: false, role: 'member' },
    }, {}, identity, committedAt)

    expect(record.groupDocument).toEqual({
      ...group, memberIds: ['owner'], updatedAt: committedAt,
      lastMembershipCommandKind: command.kind, lastMembershipOperationId: command.operationId,
      lastMembershipRequestFingerprint: identity.requestFingerprint, lastMembershipResourceToken: '8'.repeat(48), lastRemovedMemberId: 'friend',
    })
    expect(record.memberDocument).toEqual({
      status: 'removed', role: 'member', canManage: false, displayName: 'Friend Account', initials: 'FA', avatarUrl: null,
      invitationId: 'invite-a', joinedAt: 'joined', removedByUid: 'owner', removedAt: committedAt,
      lastCommandKind: command.kind, lastOperationId: command.operationId,
      lastRequestFingerprint: identity.requestFingerprint, lastResourceToken: '8'.repeat(48),
    })
    expect(record.projectionPatch).toEqual({ status: 'removed', removedAt: committedAt, removedByUid: 'owner', updatedAt: committedAt })
    expect(record.settingsDocument).toEqual({
      schemaVersion: 1, groupId: 'group-a', revision: 4, simplifyDebtsEnabled: true,
      lastCommandKind: command.kind, lastOperationId: command.operationId,
      lastRequestFingerprint: identity.requestFingerprint, lastResourceToken: '8'.repeat(48), updatedAt: committedAt,
      updatedBy: { id: 'owner', displayName: 'Owner Account' },
    })
    expect(record.activityDocument).toEqual({
      groupId: 'group-a', operationId: command.operationId, kind: 'membership.changed',
      subject: { kind: 'membership', id: 'friend', label: 'Friend Account removed' },
      actor: { id: 'owner', displayName: 'Owner Account' }, createdAt: committedAt,
    })
    expect(() => buildRemoval(command, group, target, settings, {
      actor: { id: 'owner', displayName: 'Owner Account', initials: 'OA', isCurrentUser: true, canManage: true, role: 'owner' },
      target: { id: 'friend', displayName: 'Friend Account', initials: 'FA', isCurrentUser: false, canManage: false, role: 'member' },
    }, { activeExpenseCount: 1 }, identity, committedAt)).toThrow(/expense first/i)
  })

  it('soft-deletes and restores a group without changing any ledger fields', () => {
    const manager: Member = { id: 'owner', displayName: 'Owner Account', initials: 'OA', isCurrentUser: true, canManage: true, role: 'owner' }
    const original = { id: 'group-a', kind: 'group', name: 'Group A', currency: 'USD', memberIds: ['owner', 'friend'], createdByUid: 'owner', createdAt: 'created', updatedAt: 'old' }
    const deletedAt = { kind: 'deleted-at' }
    const deleteCommand: GroupDeleteCommand = { kind: 'group.delete', operationId: 'delete-group-a', groupId: 'group-a' }
    const deleteIdentity: OperationIdentity = { userId: 'owner', operationId: deleteCommand.operationId, kind: deleteCommand.kind, groupId: deleteCommand.groupId, requestFingerprint: '9'.repeat(64), resourceId: `operation-${'a'.repeat(48)}` }
    const buildLifecycle = (sparkMutations as unknown as { buildSparkGroupLifecycleRecord: SparkGroupLifecycleBuilder }).buildSparkGroupLifecycleRecord

    const deleted = buildLifecycle(deleteCommand, original, manager, deleteIdentity, deletedAt)
    expect(deleted.groupDocument).toEqual({
      ...original, status: 'deleted', deletedAt, deletedBy: { id: 'owner', displayName: 'Owner Account' }, updatedAt: deletedAt,
      lastLifecycleCommandKind: deleteCommand.kind, lastLifecycleOperationId: deleteCommand.operationId,
      lastLifecycleRequestFingerprint: deleteIdentity.requestFingerprint, lastLifecycleResourceToken: 'a'.repeat(48),
    })
    expect(deleted.activityDocument).toMatchObject({ kind: 'group.deleted', subject: { kind: 'group', id: 'group-a', label: 'Group A' } })

    const restoreCommand: GroupRestoreCommand = { kind: 'group.restore', operationId: 'restore-group-a', groupId: 'group-a' }
    const restoreIdentity: OperationIdentity = { userId: 'owner', operationId: restoreCommand.operationId, kind: restoreCommand.kind, groupId: restoreCommand.groupId, requestFingerprint: 'b'.repeat(64), resourceId: `operation-${'c'.repeat(48)}` }
    const restoredAt = { kind: 'restored-at' }
    const restored = buildLifecycle(restoreCommand, deleted.groupDocument, manager, restoreIdentity, restoredAt)
    expect(restored.groupDocument).toEqual({
      ...original, status: 'active', updatedAt: restoredAt,
      lastLifecycleCommandKind: restoreCommand.kind, lastLifecycleOperationId: restoreCommand.operationId,
      lastLifecycleRequestFingerprint: restoreIdentity.requestFingerprint, lastLifecycleResourceToken: 'c'.repeat(48),
    })
    expect(restored.groupDocument).not.toHaveProperty('deletedAt')
    expect(restored.groupDocument).not.toHaveProperty('deletedBy')
    expect(restored.activityDocument).toMatchObject({ kind: 'group.restored', subject: { kind: 'group', id: 'group-a', label: 'Group A' } })
  })

  it('versions profile payment handles for the private profile and active membership snapshots', () => {
    const command: ProfileUpdateCommand = {
      kind: 'profile.update', operationId: 'profile-rename', displayName: '  Maya Rivera  ',
      paymentHandles: { paypal: 'maya.payments', venmo: 'maya-payments' },
    }
    const identity: OperationIdentity = { userId: 'maya-p', operationId: command.operationId, kind: command.kind, groupId: null, requestFingerprint: 'a'.repeat(64), resourceId: `operation-${'b'.repeat(48)}` }
    const createdAt = { kind: 'created' }
    const committedAt = { kind: 'updated' }
    const buildProfile = (sparkMutations as unknown as { buildSparkProfileUpdateRecord: SparkProfileUpdateBuilder }).buildSparkProfileUpdateRecord

    const record = buildProfile(command, { displayName: 'Maya P.', initials: 'MP', avatarUrl: null, createdAt }, identity, committedAt)

    expect(record.profileDocument).toEqual({
      displayName: 'Maya Rivera', initials: 'MR', avatarUrl: null,
      paymentHandles: { paypal: 'maya.payments', venmo: 'maya-payments' },
      createdAt, updatedAt: committedAt,
      lastCommandKind: 'profile.update', lastOperationId: command.operationId,
      lastRequestFingerprint: 'a'.repeat(64), lastResourceToken: 'b'.repeat(48),
    })
    expect(record.memberPatch).toEqual({
      displayName: 'Maya Rivera', initials: 'MR', avatarUrl: null,
      paymentHandles: { paypal: 'maya.payments', venmo: 'maya-payments' },
    })
  })

  it('creates and advances replay-bound notification preferences without inventing delivery state', () => {
    const first: NotificationPreferencesCommand = { kind: 'notification.preferences', operationId: 'preferences-off', preferences: { emailEnabled: false, pushEnabled: true } }
    const firstIdentity: OperationIdentity = { userId: 'maya-p', operationId: first.operationId, kind: first.kind, groupId: null, requestFingerprint: 'c'.repeat(64), resourceId: `operation-${'d'.repeat(48)}` }
    const buildPreferences = (sparkMutations as unknown as { buildSparkNotificationPreferencesRecord: SparkNotificationPreferencesBuilder }).buildSparkNotificationPreferencesRecord

    const created = buildPreferences(first, undefined, firstIdentity, 'first-commit')
    expect(created).toEqual({
      schemaVersion: 1, revision: 1, emailEnabled: false, pushEnabled: true, updatedAt: 'first-commit',
      lastCommandKind: 'notification.preferences', lastOperationId: first.operationId,
      lastRequestFingerprint: 'c'.repeat(64), lastResourceToken: 'd'.repeat(48),
    })

    const second: NotificationPreferencesCommand = { kind: 'notification.preferences', operationId: 'preferences-on', preferences: { emailEnabled: true, pushEnabled: false } }
    const secondIdentity: OperationIdentity = { userId: 'maya-p', operationId: second.operationId, kind: second.kind, groupId: null, requestFingerprint: 'e'.repeat(64), resourceId: `operation-${'f'.repeat(48)}` }
    expect(buildPreferences(second, created, secondIdentity, 'second-commit')).toEqual({
      schemaVersion: 1, revision: 2, emailEnabled: true, pushEnabled: false, updatedAt: 'second-commit',
      lastCommandKind: 'notification.preferences', lastOperationId: second.operationId,
      lastRequestFingerprint: 'e'.repeat(64), lastResourceToken: 'f'.repeat(48),
    })
  })

  it('builds an owner-private notification read receipt bound to the source activity and replay identity', () => {
    const notification: NotificationItem = {
      notificationId: 'activity-source-a', principalId: 'maya-p', groupId: 'group-a', activityId: 'activity-source-a',
      kind: 'expense.created', subject: { kind: 'expense', id: 'expense-a', label: 'Dinner' },
      actor: { id: 'friend', displayName: 'Friend Account' }, createdAt: '2026-09-01T17:30:00.000Z', syncState: 'fresh',
    }
    const command: NotificationReadCommand = { kind: 'notification.read', operationId: 'read-source-a', notificationId: notification.notificationId }
    const identity: OperationIdentity = {
      userId: 'maya-p', operationId: command.operationId, kind: command.kind, groupId: null,
      requestFingerprint: '1'.repeat(64), resourceId: `operation-${'2'.repeat(48)}`,
    }
    const committedAt = { kind: 'read-commit' }
    const buildRead = (sparkMutations as unknown as { buildSparkNotificationReadRecord: SparkNotificationReadBuilder }).buildSparkNotificationReadRecord

    expect(buildRead(command, notification, identity, committedAt)).toEqual({
      receiptId: notification.notificationId,
      receiptDocument: {
        schemaVersion: 1, notificationId: notification.notificationId, groupId: notification.groupId, activityId: notification.activityId,
        sourceCreatedAt: notification.createdAt, readAt: committedAt,
        operationId: command.operationId, requestFingerprint: '1'.repeat(64), resourceToken: '2'.repeat(48),
      },
    })
  })

  it('creates and advances a replay-bound inclusive notification read cursor', () => {
    const first: NotificationReadAllCommand = {
      kind: 'notification.read-all', operationId: 'read-all-a',
      cutoff: { createdAt: '2026-09-01T17:30:00.000Z', id: 'activity-source-a' },
    }
    const firstIdentity: OperationIdentity = {
      userId: 'maya-p', operationId: first.operationId, kind: first.kind, groupId: null,
      requestFingerprint: '3'.repeat(64), resourceId: `operation-${'4'.repeat(48)}`,
    }
    const buildReadAll = (sparkMutations as unknown as { buildSparkNotificationReadAllRecord: SparkNotificationReadAllBuilder }).buildSparkNotificationReadAllRecord

    const created = buildReadAll(first, undefined, firstIdentity, 'first-read-all', ['activity-source-a'])
    expect(created).toEqual({
      schemaVersion: 1, revision: 1, cutoffCreatedAt: first.cutoff.createdAt, cutoffId: first.cutoff.id, updatedAt: 'first-read-all',
      readNotificationIds: ['activity-source-a'],
      lastCommandKind: first.kind, lastOperationId: first.operationId,
      lastRequestFingerprint: '3'.repeat(64), lastResourceToken: '4'.repeat(48),
    })

    const second: NotificationReadAllCommand = {
      kind: 'notification.read-all', operationId: 'read-all-b',
      cutoff: { createdAt: '2026-09-02T08:00:00.000Z', id: 'activity-source-b' },
    }
    expect(buildReadAll(second, created, {
      userId: 'maya-p', operationId: second.operationId, kind: second.kind, groupId: null,
      requestFingerprint: '5'.repeat(64), resourceId: `operation-${'6'.repeat(48)}`,
    }, 'second-read-all', ['activity-source-b'])).toEqual({
      schemaVersion: 1, revision: 2, cutoffCreatedAt: second.cutoff.createdAt, cutoffId: second.cutoff.id, updatedAt: 'second-read-all',
      readNotificationIds: ['activity-source-b'],
      lastCommandKind: second.kind, lastOperationId: second.operationId,
      lastRequestFingerprint: '5'.repeat(64), lastResourceToken: '6'.repeat(48),
    })
  })
})

const groupMembers: readonly Member[] = [
  { id: 'owner', displayName: 'Owner Account', initials: 'OA', isCurrentUser: true, canManage: true },
  { id: 'friend', displayName: 'Friend Account', initials: 'FA', isCurrentUser: false, canManage: false },
]

type SparkMutationBuilder = (
  command: ExpenseEditCommand | ExpenseDeleteCommand | ExpenseRestoreCommand,
  head: Readonly<Record<string, unknown>>,
  current: Readonly<Record<string, unknown>>,
  authorization: { readonly actor: ActorSnapshot; readonly canManage: boolean },
  identity: OperationIdentity,
  committedAt: unknown,
) => {
  readonly headDocument: Readonly<Record<string, unknown>>
  readonly revisionId: string
  readonly revisionDocument: Readonly<Record<string, unknown>> & { readonly expense: Readonly<Record<string, unknown>> }
  readonly activityId: string
  readonly activityDocument: Readonly<Record<string, unknown>>
}

type SparkCommentBuilder = (
  command: CommentAddCommand,
  actor: ActorSnapshot,
  identity: OperationIdentity,
  committedAt: unknown,
) => {
  readonly commentId: string
  readonly commentDocument: Readonly<Record<string, unknown>>
  readonly activityId: string
  readonly activityDocument: Readonly<Record<string, unknown>>
}

type SparkCommentRecord = ReturnType<SparkCommentBuilder>

function recurringTemplateRecord(templateId: string): Readonly<Record<string, unknown>> {
  return {
    id: templateId, groupId: 'group-a', sourceExpenseId: `expense-${'d'.repeat(48)}`,
    operationId: 'recurring-expense-operation', requestFingerprint: 'c'.repeat(64), resourceToken: 'd'.repeat(48),
    lastOperationId: 'recurring-expense-operation', lastRequestFingerprint: 'c'.repeat(64), lastResourceToken: 'd'.repeat(48),
    status: 'active', description: 'Monthly rent', total: { currency: 'USD', minorAmount: 180000 },
    payments: [{ participantId: 'owner', money: { currency: 'USD', minorAmount: 180000 } }],
    allocations: [{ participantId: 'owner', money: { currency: 'USD', minorAmount: 90000 } }, { participantId: 'friend', money: { currency: 'USD', minorAmount: 90000 } }],
    payerIds: ['owner'], participantIds: ['owner', 'friend'], involvedMemberIds: ['friend', 'owner'],
    category: 'Housing', splitMethod: { type: 'exact', allocations: [
      { participantId: 'owner', money: { currency: 'USD', minorAmount: 90000 } },
      { participantId: 'friend', money: { currency: 'USD', minorAmount: 90000 } },
    ] },
    recurrence: { frequency: 'monthly', anchor: { month: 9, day: 1 }, timeZone: 'America/Chicago' },
    anchorDate: '2026-09-01', nextDate: '2026-10-01', revision: 1,
    createdBy: { id: 'owner', displayName: 'Owner Account' }, updatedAt: 'created', updatedBy: { id: 'owner', displayName: 'Owner Account' },
  }
}

type SparkCommentDeleteBuilder = (
  command: CommentDeleteCommand,
  current: Readonly<Record<string, unknown>>,
  actor: ActorSnapshot,
  identity: OperationIdentity,
  committedAt: unknown,
) => SparkCommentRecord

type SparkGroupSettingsBuilder = (
  command: GroupCurrencyConversionCommand | GroupDefaultSplitCommand | GroupSimplifyDebtsCommand,
  current: Readonly<Record<string, unknown>>,
  currentBalance: Readonly<Record<string, unknown>> | undefined,
  members: readonly Member[],
  actor: ActorSnapshot,
  identity: OperationIdentity,
  committedAt: unknown,
) => {
  readonly settingsDocument: Readonly<Record<string, unknown>>
  readonly balanceDocument?: Readonly<Record<string, unknown>>
  readonly currencyConversionId?: string
  readonly currencyConversionDocument?: Readonly<Record<string, unknown>>
  readonly currencyRateDocuments?: readonly { readonly id: string; readonly document: Readonly<Record<string, unknown>> }[]
  readonly activityId: string
  readonly activityDocument: Readonly<Record<string, unknown>>
}

type SparkMemberRemovalBuilder = (
  command: GroupMemberRemoveCommand,
  group: Readonly<Record<string, unknown>>,
  targetMember: Readonly<Record<string, unknown>>,
  settings: Readonly<Record<string, unknown>>,
  authorization: { readonly actor: Member; readonly target: Member },
  references: { readonly activeExpenseCount?: number; readonly activeRecurringCount?: number; readonly activeSettlementCount?: number; readonly balanceCount?: number },
  identity: OperationIdentity,
  committedAt: unknown,
) => {
  readonly groupDocument: Readonly<Record<string, unknown>>
  readonly memberDocument: Readonly<Record<string, unknown>>
  readonly projectionPatch: Readonly<Record<string, unknown>>
  readonly settingsDocument: Readonly<Record<string, unknown>>
  readonly activityId: string
  readonly activityDocument: Readonly<Record<string, unknown>>
}

type SparkGroupLifecycleBuilder = (
  command: GroupDeleteCommand | GroupRestoreCommand,
  group: Readonly<Record<string, unknown>>,
  actor: Member,
  identity: OperationIdentity,
  committedAt: unknown,
) => {
  readonly groupDocument: Readonly<Record<string, unknown>>
  readonly activityId: string
  readonly activityDocument: Readonly<Record<string, unknown>>
}

type SparkProfileUpdateBuilder = (
  command: ProfileUpdateCommand,
  current: Readonly<Record<string, unknown>>,
  identity: OperationIdentity,
  committedAt: unknown,
) => {
  readonly profileDocument: Readonly<Record<string, unknown>>
  readonly memberPatch: Readonly<Record<string, unknown>>
}

type SparkNotificationPreferencesBuilder = (
  command: NotificationPreferencesCommand,
  current: Readonly<Record<string, unknown>> | undefined,
  identity: OperationIdentity,
  committedAt: unknown,
) => Readonly<Record<string, unknown>>

type SparkNotificationReadBuilder = (
  command: NotificationReadCommand,
  notification: NotificationItem,
  identity: OperationIdentity,
  committedAt: unknown,
) => {
  readonly receiptId: string
  readonly receiptDocument: Readonly<Record<string, unknown>>
}

type SparkNotificationReadAllBuilder = (
  command: NotificationReadAllCommand,
  current: Readonly<Record<string, unknown>> | undefined,
  identity: OperationIdentity,
  committedAt: unknown,
  readNotificationIds: readonly string[],
) => Readonly<Record<string, unknown>>

type SparkSettlementBuilder = (
  command: SettlementRecordCommand,
  actor: ActorSnapshot,
  identity: OperationIdentity,
  committedAt: unknown,
) => {
  readonly settlementId: string
  readonly settlementDocument: Readonly<Record<string, unknown>>
  readonly activityId: string
  readonly activityDocument: Readonly<Record<string, unknown>>
}

type SparkSettlementVoidBuilder = (
  command: SettlementVoidCommand,
  current: Readonly<Record<string, unknown>>,
  authorization: { readonly actor: ActorSnapshot; readonly canManage: boolean },
  identity: OperationIdentity,
  committedAt: unknown,
) => ReturnType<SparkSettlementBuilder>
