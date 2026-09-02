import { describe, expect, it } from 'vitest'
import {
  createAccountDeletionPreparer,
  type AccountDeletionCommitEvent,
  type AccountDeletionDocument,
  type AccountDeletionFirestorePort,
  type AccountDeletionListRequest,
  type AccountDeletionMutation,
} from '../firebaseAccountDeletion'

describe('Firebase account deletion preparation', () => {
  it('orders shared anonymization before continuity and private cleanup', async () => {
    const port = deletionPort()

    const result = await createAccountDeletionPreparer(port)({ uid: 'owner', email: 'owner@example.com' })

    expect(port.events).toEqual([
      'profile:deleting',
      'group:group-a:history',
      'group:group-a:continuity',
      'invitations:delete',
      'private:delete',
      'profile:prepared',
    ])
    expect(result).toMatchObject({ deletionId: 'account-delete-12345678', phase: 'prepared', groupsProcessed: 1 })
    expect(port.data('groups/group-a/expenses/expense-a')).toMatchObject({
      total: { currency: 'USD', minorAmount: 4200 },
      createdBy: { id: 'owner', displayName: 'Deleted user' },
    })
    expect(port.data('groups/group-a')).toMatchObject({ memberIds: ['friend'], createdByUid: 'friend' })
    expect(port.data('groups/group-a/members/owner')).toMatchObject({ status: 'removed', accountStatus: 'deleted', displayName: 'Deleted user' })
    expect(port.has('users/owner/groups/group-a')).toBe(false)
    expect(port.has('users/owner/settings/notifications')).toBe(false)
    expect(port.has('invitations/invitation-a')).toBe(false)
  })

  it('resumes after a committed history batch without duplicating semantic changes', async () => {
    const port = deletionPort()
    port.failOnceAfter = 'group:group-a:history'
    const prepare = createAccountDeletionPreparer(port)

    await expect(prepare({ uid: 'owner', email: 'owner@example.com' })).rejects.toThrow('simulated interruption')
    expect(port.events).toEqual(['profile:deleting', 'group:group-a:history'])
    expect(port.data('users/owner')).toMatchObject({ deletionStatus: 'deleting' })

    const result = await prepare({ uid: 'owner', email: 'owner@example.com' })

    expect(result.phase).toBe('prepared')
    expect(port.events).toEqual([
      'profile:deleting',
      'group:group-a:history',
      'group:group-a:continuity',
      'invitations:delete',
      'private:delete',
      'profile:prepared',
    ])
    expect(port.data('groups/group-a/expenses/expense-a')).toMatchObject({
      createdBy: { id: 'owner', displayName: 'Deleted user' },
    })
    expect(port.data('users/owner')).toMatchObject({ deletionStatus: 'prepared', deletionId: 'account-delete-12345678' })
  })
})

class MemoryDeletionPort implements AccountDeletionFirestorePort {
  readonly events: AccountDeletionCommitEvent[] = []
  failOnceAfter?: AccountDeletionCommitEvent
  private readonly documents = new Map<string, Readonly<Record<string, unknown>>>()

  constructor(fixtures: Readonly<Record<string, Readonly<Record<string, unknown>>>>) {
    for (const [path, data] of Object.entries(fixtures)) this.documents.set(path, structuredClone(data))
  }

  serverTimestamp(): unknown { return 'now' }
  createDeletionId(): string { return 'account-delete-12345678' }
  async get(path: string): Promise<AccountDeletionDocument | undefined> {
    const data = this.documents.get(path)
    return data ? { id: path.split('/').at(-1)!, path, data: structuredClone(data) } : undefined
  }
  async list(request: AccountDeletionListRequest): Promise<readonly AccountDeletionDocument[]> {
    const prefix = `${request.collectionPath}/`
    const expectedSegments = request.collectionPath.split('/').length + 1
    return [...this.documents.entries()]
      .filter(([path, data]) => path.startsWith(prefix)
        && path.split('/').length === expectedSegments
        && request.filters.every(({ field, value }) => data[field] === value))
      .map(([path, data]) => ({ id: path.slice(prefix.length), path, data: structuredClone(data) }))
      .filter(({ id }) => request.startAfter === undefined || id > request.startAfter)
      .sort((left, right) => left.id.localeCompare(right.id))
      .slice(0, request.limit)
  }
  async commit(event: AccountDeletionCommitEvent, mutations: readonly AccountDeletionMutation[]): Promise<void> {
    for (const mutation of mutations) {
      if (mutation.kind === 'delete') this.documents.delete(mutation.path)
      else this.documents.set(mutation.path, structuredClone(mutation.data))
    }
    this.events.push(event)
    if (this.failOnceAfter === event) {
      this.failOnceAfter = undefined
      throw new Error('simulated interruption')
    }
  }
  has(path: string): boolean { return this.documents.has(path) }
  data(path: string): Readonly<Record<string, unknown>> | undefined { return this.documents.get(path) }
}

function deletionPort(): MemoryDeletionPort {
  const owner = { id: 'owner', displayName: 'Owner Name' }
  const friend = { id: 'friend', displayName: 'Friend' }
  return new MemoryDeletionPort({
    'users/owner': { displayName: 'Owner Name', initials: 'ON', avatarUrl: null, createdAt: 'created', updatedAt: 'before' },
    'users/owner/groups/group-a': { groupId: 'group-a', status: 'active', contextLabel: 'Friend', joinedAt: 'joined', updatedAt: 'before' },
    'users/owner/settings/notifications': { emailEnabled: true, pushEnabled: true },
    'groups/group-a': { id: 'group-a', kind: 'friendship', name: 'Shared', currency: 'USD', memberIds: ['owner', 'friend'], createdByUid: 'owner', createdAt: 'created', updatedAt: 'before' },
    'groups/group-a/members/owner': { status: 'active', role: 'owner', canManage: true, displayName: 'Owner Name', initials: 'ON', avatarUrl: null, joinedAt: 'joined' },
    'groups/group-a/members/friend': { status: 'active', role: 'member', canManage: false, displayName: 'Friend', initials: 'F', avatarUrl: null, joinedAt: 'joined' },
    'groups/group-a/expenses/expense-a': { id: 'expense-a', total: { currency: 'USD', minorAmount: 4200 }, createdBy: owner, updatedBy: friend },
    'groups/group-a/expenses/expense-a/revisions/revision-a': { actor: owner, expense: { createdBy: owner, updatedBy: friend }, revision: 1 },
    'groups/group-a/activity/activity-a': { actor: owner, subject: { kind: 'expense', id: 'expense-a', label: 'Dinner' } },
    'groups/group-a/comments/comment-a': { author: owner, body: 'Private note', attachmentRefs: ['receipt-a'] },
    'groups/group-a/settlements/settlement-a': { createdBy: owner, payerId: 'owner', payeeId: 'friend', money: { currency: 'USD', minorAmount: 1000 } },
    'groups/group-a/recurringTemplates/recurring-a': { status: 'active', revision: 1, involvedMemberIds: ['owner', 'friend'], createdBy: owner, updatedBy: owner },
    'groups/group-a/settings/defaults': { schemaVersion: 1, groupId: 'group-a', revision: 1, defaultSplit: { type: 'equal', participantIds: ['owner', 'friend'] }, simplifyDebtsEnabled: true, updatedAt: 'before', updatedBy: owner },
    'users/friend/groups/group-a': { groupId: 'group-a', status: 'active', contextLabel: 'Owner Name', joinedAt: 'joined', updatedAt: 'before' },
    'invitations/invitation-a': { createdByUid: 'owner', targetEmail: 'friend@example.com', status: 'active' },
  })
}
