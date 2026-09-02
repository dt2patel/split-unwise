import { describe, expect, it } from 'vitest'
import {
  DELETED_ACCOUNT_INITIALS,
  DELETED_ACCOUNT_NAME,
  anonymizeSharedDocument,
  buildAccountDeletionTombstone,
  buildDeletedMemberDocument,
  buildDeletionGroupContinuity,
  buildDeletionRecurringTemplate,
  buildDeletionSettings,
} from '../accountDeletion'

const profile = {
  displayName: 'Owner Name', initials: 'ON', avatarUrl: 'https://example.com/owner.png',
  createdAt: 'created', updatedAt: 'before', lastCommandKind: 'profile.update', lastOperationId: 'profile-1',
}

describe('account deletion data contract', () => {
  it('builds a non-personal retry tombstone without retaining the former profile', () => {
    expect(buildAccountDeletionTombstone(profile, {
      uid: 'owner', deletionId: 'account-delete-12345678', groupIds: ['group-b', 'group-a', 'group-a'],
      phase: 'deleting', committedAt: 'now',
    })).toEqual({
      displayName: DELETED_ACCOUNT_NAME, initials: DELETED_ACCOUNT_INITIALS, avatarUrl: null,
      createdAt: 'created', updatedAt: 'now', deletionRequestedAt: 'now',
      deletionStatus: 'deleting', deletionId: 'account-delete-12345678', deletionGroupIds: ['group-a', 'group-b'],
    })
  })

  it('resumes only the same deletion identity and preserves the original request time', () => {
    const deleting = buildAccountDeletionTombstone(profile, {
      uid: 'owner', deletionId: 'account-delete-12345678', groupIds: ['group-a'], phase: 'deleting', committedAt: 'requested',
    })
    expect(buildAccountDeletionTombstone(deleting, {
      uid: 'owner', deletionId: 'account-delete-12345678', groupIds: ['group-a'], phase: 'prepared', committedAt: 'prepared',
    })).toMatchObject({ deletionStatus: 'prepared', deletionRequestedAt: 'requested', updatedAt: 'prepared' })
    expect(() => buildAccountDeletionTombstone(deleting, {
      uid: 'owner', deletionId: 'different-deletion', groupIds: ['group-a'], phase: 'deleting', committedAt: 'later',
    })).toThrow('deletion identity')
  })

  it('rewrites only the deleted uid actor snapshots inside an expense head', () => {
    const expense = {
      id: 'expense-a', total: { currency: 'USD', minorAmount: 4200 },
      createdBy: { id: 'owner', displayName: 'Owner Name' }, updatedBy: { id: 'friend', displayName: 'Friend' },
      current: {
        id: 'expense-a', total: { currency: 'USD', minorAmount: 4200 },
        createdBy: { id: 'owner', displayName: 'Owner Name' }, updatedBy: { id: 'owner', displayName: 'Owner Name' },
      },
    }

    const result = anonymizeSharedDocument('expense', expense, 'owner')

    expect(result).toEqual({
      ...expense,
      createdBy: { id: 'owner', displayName: DELETED_ACCOUNT_NAME },
      current: {
        ...expense.current,
        createdBy: { id: 'owner', displayName: DELETED_ACCOUNT_NAME },
        updatedBy: { id: 'owner', displayName: DELETED_ACCOUNT_NAME },
      },
    })
    expect(anonymizeSharedDocument('expense', result!, 'owner')).toBeUndefined()
  })

  it('anonymizes revision, activity, settlement, group, recurring, and settings actor paths', () => {
    const actor = { id: 'owner', displayName: 'Owner Name' }
    const friend = { id: 'friend', displayName: 'Friend' }
    expect(anonymizeSharedDocument('revision', { actor, expense: { createdBy: actor, updatedBy: friend }, amount: 10 }, 'owner')).toEqual({
      actor: { id: 'owner', displayName: DELETED_ACCOUNT_NAME },
      expense: { createdBy: { id: 'owner', displayName: DELETED_ACCOUNT_NAME }, updatedBy: friend }, amount: 10,
    })
    expect(anonymizeSharedDocument('activity', { actor, subject: { label: 'Dinner' } }, 'owner')).toMatchObject({ actor: { displayName: DELETED_ACCOUNT_NAME } })
    expect(anonymizeSharedDocument('settlement', { createdBy: actor, void: { actor, reason: 'duplicate' }, money: { minorAmount: 10 } }, 'owner')).toMatchObject({
      createdBy: { displayName: DELETED_ACCOUNT_NAME }, void: { actor: { displayName: DELETED_ACCOUNT_NAME }, reason: 'duplicate' },
    })
    expect(anonymizeSharedDocument('group', { deletedBy: actor, name: 'Trip' }, 'owner')).toMatchObject({ deletedBy: { displayName: DELETED_ACCOUNT_NAME } })
    expect(anonymizeSharedDocument('recurring', { createdBy: actor, updatedBy: friend }, 'owner')).toMatchObject({ createdBy: { displayName: DELETED_ACCOUNT_NAME }, updatedBy: friend })
    expect(anonymizeSharedDocument('settings', { updatedBy: actor, revision: 3 }, 'owner')).toMatchObject({ updatedBy: { displayName: DELETED_ACCOUNT_NAME }, revision: 3 })
  })

  it('redacts only comments authored by the deleted uid', () => {
    const authored = { author: { id: 'owner', displayName: 'Owner Name' }, body: 'Call me at 555-0100', attachmentRefs: ['receipt-a'], createdAt: 'created' }
    expect(anonymizeSharedDocument('comment', authored, 'owner')).toEqual({
      ...authored,
      author: { id: 'owner', displayName: DELETED_ACCOUNT_NAME },
      body: 'Comment removed with deleted account', attachmentRefs: [],
    })
    expect(anonymizeSharedDocument('comment', { ...authored, author: { id: 'friend', displayName: 'Friend' } }, 'owner')).toBeUndefined()
  })

  it('marks the member anonymous and removed while retaining its tombstone document', () => {
    expect(buildDeletedMemberDocument({
      status: 'active', role: 'owner', canManage: true, displayName: 'Owner Name', initials: 'ON',
      avatarUrl: 'https://example.com/owner.png', paymentHandles: { paypal: 'owner.payments', venmo: 'owner-payments' }, joinedAt: 'joined',
    }, 'owner', 'account-delete-12345678', 'now')).toEqual({
      status: 'removed', role: 'member', canManage: false, displayName: DELETED_ACCOUNT_NAME,
      initials: DELETED_ACCOUNT_INITIALS, avatarUrl: null, joinedAt: 'joined', accountStatus: 'deleted',
      accountDeletionId: 'account-delete-12345678', accountDeletedAt: 'now',
    })
  })

  it('promotes the first remaining member and transfers group ownership', () => {
    const group = { id: 'group-a', memberIds: ['owner', 'friend', 'manager'], createdByUid: 'owner', updatedAt: 'before' }
    const members = [
      { id: 'owner', status: 'active', role: 'owner', canManage: true, displayName: 'Owner Name', initials: 'ON', avatarUrl: null, joinedAt: 'joined' },
      { id: 'friend', status: 'active', role: 'member', canManage: false, displayName: 'Friend', initials: 'F', avatarUrl: null, joinedAt: 'joined' },
      { id: 'manager', status: 'active', role: 'member', canManage: true, displayName: 'Manager', initials: 'M', avatarUrl: null, joinedAt: 'joined' },
    ]

    expect(buildDeletionGroupContinuity(group, members, 'owner', 'account-delete-12345678', 'now')).toEqual({
      group: {
        ...group, memberIds: ['friend', 'manager'], createdByUid: 'friend', updatedAt: 'now',
        lastAccountDeletionId: 'account-delete-12345678', lastDeletedAccountUid: 'owner',
      },
      deletedMember: {
        status: 'removed', role: 'member', canManage: false, displayName: DELETED_ACCOUNT_NAME,
        initials: DELETED_ACCOUNT_INITIALS, avatarUrl: null, accountStatus: 'deleted',
        joinedAt: 'joined', accountDeletionId: 'account-delete-12345678', accountDeletedAt: 'now',
      },
      promotedMember: {
        ...members[1], role: 'owner', canManage: true,
        accountDeletionPromotionId: 'account-delete-12345678', accountDeletionPromotedAt: 'now',
      },
    })
  })

  it('soft-deletes an owner-only group while retaining its ledger', () => {
    const group = { id: 'group-a', memberIds: ['owner'], createdByUid: 'owner', name: 'Solo', updatedAt: 'before' }
    const owner = { id: 'owner', status: 'active', role: 'owner', canManage: true, displayName: 'Owner Name', initials: 'ON', avatarUrl: null, joinedAt: 'joined' }
    expect(buildDeletionGroupContinuity(group, [owner], 'owner', 'account-delete-12345678', 'now').group).toMatchObject({
      status: 'deleted', deletedAt: 'now', deletedBy: { id: 'owner', displayName: DELETED_ACCOUNT_NAME }, memberIds: [],
    })
  })

  it('anonymizes an existing group deletion actor during continuity', () => {
    const group = {
      id: 'group-a', memberIds: ['owner', 'friend'], createdByUid: 'friend', status: 'deleted', deletedAt: 'before',
      deletedBy: { id: 'owner', displayName: 'Owner Name' }, updatedAt: 'before',
    }
    const members = [
      { id: 'owner', status: 'active', role: 'member', canManage: false, displayName: 'Owner Name', initials: 'ON', avatarUrl: null },
      { id: 'friend', status: 'active', role: 'owner', canManage: true, displayName: 'Friend', initials: 'F', avatarUrl: null },
    ]
    expect(buildDeletionGroupContinuity(group, members, 'owner', 'account-delete-12345678', 'now').group).toMatchObject({
      status: 'deleted', deletedAt: 'before', deletedBy: { id: 'owner', displayName: DELETED_ACCOUNT_NAME }, memberIds: ['friend'],
    })
  })

  it('cancels only active recurrence involving the deleted uid', () => {
    const template = {
      status: 'active', revision: 3, involvedMemberIds: ['friend', 'owner'],
      createdBy: { id: 'friend', displayName: 'Friend' }, updatedBy: { id: 'owner', displayName: 'Owner Name' },
      total: { currency: 'USD', minorAmount: 1000 },
    }
    expect(buildDeletionRecurringTemplate(template, 'owner', 'account-delete-12345678', 'now')).toEqual({
      ...template, status: 'cancelled', revision: 4, updatedAt: 'now',
      updatedBy: { id: 'owner', displayName: DELETED_ACCOUNT_NAME },
      accountDeletionId: 'account-delete-12345678', accountDeletedUid: 'owner',
    })
    expect(buildDeletionRecurringTemplate({ ...template, involvedMemberIds: ['friend'] }, 'owner', 'account-delete-12345678', 'now')).toEqual({
      ...template,
      involvedMemberIds: ['friend'],
      updatedBy: { id: 'owner', displayName: DELETED_ACCOUNT_NAME },
    })
  })

  it('anonymizes an inactive recurrence actor without changing its schedule or revision', () => {
    const template = {
      status: 'cancelled', revision: 4, involvedMemberIds: ['friend'],
      createdBy: { id: 'owner', displayName: 'Owner Name' }, updatedBy: { id: 'friend', displayName: 'Friend' }, nextDate: '2026-10-01',
    }
    expect(buildDeletionRecurringTemplate(template, 'owner', 'account-delete-12345678', 'now')).toEqual({
      ...template, createdBy: { id: 'owner', displayName: DELETED_ACCOUNT_NAME },
    })
  })

  it('clears only a default split involving the deleted uid', () => {
    const settings = {
      schemaVersion: 1, groupId: 'group-a', revision: 2,
      defaultSplit: { type: 'equal', participantIds: ['owner', 'friend'] },
      simplifyDebtsEnabled: true, updatedAt: 'before', updatedBy: { id: 'friend', displayName: 'Friend' },
    }
    expect(buildDeletionSettings(settings, 'owner', 'account-delete-12345678', 'now')).toEqual({
      schemaVersion: 1, groupId: 'group-a', revision: 3, simplifyDebtsEnabled: true,
      updatedAt: 'now', updatedBy: { id: 'owner', displayName: DELETED_ACCOUNT_NAME },
      accountDeletionId: 'account-delete-12345678', accountDeletedUid: 'owner',
    })
    expect(buildDeletionSettings({ ...settings, defaultSplit: { type: 'equal', participantIds: ['friend'] } }, 'owner', 'account-delete-12345678', 'now')).toBeUndefined()
  })
})
