// @vitest-environment node
import { readFileSync } from 'node:fs'
import { initializeTestEnvironment, assertFails, assertSucceeds, type RulesTestEnvironment } from '@firebase/rules-unit-testing'
import { collection, collectionGroup, deleteDoc, doc, getDoc, getDocs, limit, orderBy, query, serverTimestamp, setDoc, Timestamp, updateDoc, where, writeBatch, type Firestore } from 'firebase/firestore'
import { deleteObject, getBytes, ref, uploadBytes } from 'firebase/storage'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

const projectId = 'demo-split-unwise'
const bucketUrl = `gs://${projectId}.appspot.com`
let environment: RulesTestEnvironment
const emulatorEnabled = Boolean(process.env.FIRESTORE_EMULATOR_HOST && process.env.FIREBASE_STORAGE_EMULATOR_HOST)
const emulatorIt = emulatorEnabled ? it : it.skip

beforeAll(async () => {
  if (!emulatorEnabled) return
  environment = await initializeTestEnvironment({
    projectId,
    firestore: { rules: readFileSync(`${process.cwd()}/firestore.rules`, 'utf8') },
    storage: { rules: readFileSync(`${process.cwd()}/storage.rules`, 'utf8') },
  })
})
beforeEach(async () => {
  if (!emulatorEnabled) return
  await environment.clearFirestore()
  await environment.clearStorage()
  await environment.withSecurityRulesDisabled(async (context) => {
    const db = context.firestore()
    await setDoc(doc(db, 'users/active'), { displayName: 'Active Member', initials: 'AM' })
    await setDoc(doc(db, 'users/outsider'), { displayName: 'Outsider', initials: 'O' })
    await setDoc(doc(db, 'users/friend'), { displayName: 'Friend', initials: 'F' })
    await setDoc(doc(db, 'groups/group-a'), { name: 'Group A', currency: 'USD', memberIds: ['active', 'friend', 'removed'] })
    await setDoc(doc(db, 'groups/group-a/members/active'), { status: 'active', canManage: true, displayName: 'Active Member' })
    await setDoc(doc(db, 'groups/group-a/members/friend'), { status: 'active', canManage: false, displayName: 'Friend' })
    await setDoc(doc(db, 'groups/group-a/members/removed'), { status: 'removed' })
    await setDoc(doc(db, 'groups/group-a/settings/defaults'), { schemaVersion: 1, groupId: 'group-a', revision: 1, simplifyDebtsEnabled: true, updatedAt: Timestamp.fromMillis(0) })
    await setDoc(doc(db, 'groups/group-a/balance/current'), { groupId: 'group-a', balanceRevision: 0, simplifyDebtsEnabled: true, pairwise: [], simplified: [] })
    await setDoc(doc(db, 'groups/group-a/expenses/expense-a'), { description: 'Dinner' })
  })
})
afterAll(async () => environment?.cleanup())

describe('Firestore rules in the emulator', () => {
  emulatorIt('lets an authenticated account bootstrap and safely maintain only its own profile', async () => {
    const owner = environment.authenticatedContext('new-owner', { email: 'owner@example.com', email_verified: true }).firestore()
    const attacker = environment.authenticatedContext('attacker', { email: 'attacker@example.com', email_verified: true }).firestore()
    await assertSucceeds(setDoc(doc(owner, 'users/new-owner'), profile('New Owner', 'NO')))
    await assertFails(setDoc(doc(owner, 'users/someone-else'), profile('Someone Else', 'SE')))
    await assertFails(setDoc(doc(attacker, 'users/attacker'), { ...profile('Attacker', 'A'), admin: true }))
    await assertSucceeds(updateDoc(doc(owner, 'users/new-owner'), { displayName: 'Owner Updated', initials: 'OU', updatedAt: serverTimestamp() }))
    await assertFails(updateDoc(doc(owner, 'users/new-owner'), { createdAt: serverTimestamp() }))
  })

  emulatorIt('permits one complete owner-only group bootstrap and rejects partial or forged groups', async () => {
    const owner = environment.authenticatedContext('new-owner').firestore()
    await assertSucceeds(setDoc(doc(owner, 'users/new-owner'), profile('New Owner', 'NO')))
    await assertSucceeds(commitGroupBundle(owner, 'group-new', 'new-owner', 'New Owner', 'NO'))
    await assertSucceeds(getDoc(doc(owner, 'groups/group-new')))
    await assertSucceeds(getDoc(doc(owner, 'groups/group-new/members/new-owner')))
    await assertSucceeds(getDoc(doc(owner, 'users/new-owner/groups/group-new')))

    await assertFails(setDoc(doc(owner, 'groups/group-partial'), group('group-partial', 'new-owner', ['new-owner'])))
    await assertFails(commitGroupBundle(owner, 'group-forged', 'new-owner', 'New Owner', 'NO', ['new-owner', 'victim']))
  })

  emulatorIt('supports a private invitation that adds a second signed-in user atomically', async () => {
    const owner = environment.authenticatedContext('new-owner', { email: 'owner@example.com', email_verified: true }).firestore()
    const invitee = environment.authenticatedContext('invitee', { email: 'friend@example.com', email_verified: true }).firestore()
    await assertSucceeds(setDoc(doc(owner, 'users/new-owner'), profile('New Owner', 'NO')))
    await assertSucceeds(setDoc(doc(invitee, 'users/invitee'), profile('Friendly User', 'FU')))
    await assertSucceeds(commitGroupBundle(owner, 'group-shared', 'new-owner', 'New Owner', 'NO'))

    const invitationId = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQ'
    await assertSucceeds(setDoc(doc(owner, `invitations/${invitationId}`), invitation(invitationId, 'group-shared', 'new-owner')))
    await assertSucceeds(getDoc(doc(invitee, `invitations/${invitationId}`)))
    await assertSucceeds(acceptInvitation(invitee, invitationId, 'group-shared', 'invitee', 'Friendly User', 'FU', ['new-owner', 'invitee']))
    await assertSucceeds(getDoc(doc(invitee, 'groups/group-shared')))
    await assertSucceeds(getDoc(doc(invitee, 'groups/group-shared/members/new-owner')))

    const attacker = environment.authenticatedContext('attacker', { email: 'attacker@example.com', email_verified: true }).firestore()
    await assertSucceeds(setDoc(doc(attacker, 'users/attacker'), profile('Attacker', 'A')))
    await assertFails(setDoc(doc(attacker, 'invitations/not-a-capability'), invitation('not-a-capability', 'group-shared', 'attacker')))
  })

  emulatorIt('allows only self-private and active-member bounded reads', async () => {
    const active = environment.authenticatedContext('active').firestore()
    const outsider = environment.authenticatedContext('outsider').firestore()
    const removed = environment.authenticatedContext('removed').firestore()
    const anonymous = environment.unauthenticatedContext().firestore()
    await assertSucceeds(getDoc(doc(active, 'users/active')))
    await assertFails(getDoc(doc(active, 'users/outsider')))
    await assertSucceeds(getDoc(doc(active, 'groups/group-a/expenses/expense-a')))
    await assertFails(getDoc(doc(outsider, 'groups/group-a/expenses/expense-a')))
    await assertFails(getDoc(doc(removed, 'groups/group-a/expenses/expense-a')))
    await assertFails(getDoc(doc(anonymous, 'groups/group-a')))
    await assertFails(getDocs(collection(active, 'groups/group-a/expenses')))
    await assertSucceeds(getDocs(query(collection(active, 'groups/group-a/expenses'), limit(100))))
  })

  emulatorIt('denies operation ledgers, direct ledger writes, immutable activity writes, unknown paths, and collection-group discovery', async () => {
    const active = environment.authenticatedContext('active').firestore()
    await assertFails(getDoc(doc(active, 'users/active/operations/op-a')))
    await assertFails(setDoc(doc(active, 'groups/group-a/expenses/new-expense'), { description: 'Nope' }))
    await assertFails(setDoc(doc(active, 'groups/group-a/activity/new-activity'), { kind: 'expense.created' }))
    await assertFails(getDoc(doc(active, 'unknown/path')))
    await assertFails(getDocs(query(collection(active, 'groups'), limit(10))))
    await assertFails(getDocs(query(collectionGroup(active, 'expenses'), limit(10))))
  })

  emulatorIt('allows one strictly validated immutable expense record from an active member', async () => {
    const active = environment.authenticatedContext('active').firestore()
    const outsider = environment.authenticatedContext('outsider').firestore()
    await assertSucceeds(setDoc(doc(active, 'groups/group-a/expenses/expense-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'), sparkExpense()))
    await assertSucceeds(getDoc(doc(active, 'groups/group-a/expenses/expense-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa')))

    await assertFails(setDoc(doc(outsider, 'groups/group-a/expenses/expense-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'), sparkExpense('b')))
    await assertFails(setDoc(doc(active, 'groups/group-a/expenses/expense-cccccccccccccccccccccccccccccccccccccccccccccccc'), sparkExpense('c', { allocations: [
      { participantId: 'active', money: { currency: 'USD', minorAmount: 400 } },
      { participantId: 'friend', money: { currency: 'USD', minorAmount: 599 } },
    ] })))
    await assertFails(setDoc(doc(active, 'groups/group-a/expenses/expense-dddddddddddddddddddddddddddddddddddddddddddddddd'), sparkExpense('d', {
      participantIds: ['active', 'removed'], involvedMemberIds: ['active', 'removed'], allocations: [
        { participantId: 'active', money: { currency: 'USD', minorAmount: 400 } },
        { participantId: 'removed', money: { currency: 'USD', minorAmount: 600 } },
      ],
    })))
  })

  emulatorIt('requires an authorized head advance plus an immutable full version and keeps physical deletes denied', async () => {
    const active = environment.authenticatedContext('active').firestore()
    const friend = environment.authenticatedContext('friend').firestore()
    const expense = sparkExpense('e')
    const reference = doc(active, `groups/group-a/expenses/${expense.id}`)
    await assertSucceeds(setDoc(reference, expense))
    await assertFails(updateDoc(reference, { description: 'Changed outside the audit bundle' }))
    const beforeEdit = (await getDoc(reference)).data()!
    const editToken = 'f'.repeat(48)
    const editedExpense = {
      ...beforeEdit, description: 'Audited change', lastOperationId: 'edit-operation-f', lastRequestFingerprint: 'f'.repeat(64), lastResourceToken: editToken,
      updatedAt: serverTimestamp(), updatedBy: { id: 'active', displayName: 'Active Member' }, revision: 2,
    }
    await assertSucceeds(commitSparkExpenseMutation(active, expense.id as string, editToken, {
      ...beforeEdit, lastOperationId: 'edit-operation-f', lastRequestFingerprint: 'f'.repeat(64), lastResourceToken: editToken,
      headRevision: 2, headDeleted: false,
    }, sparkExpenseVersion(editedExpense, 'edit-operation-f', 'updated', { id: 'active', displayName: 'Active Member' })))
    expect((await getDoc(reference)).data()).toMatchObject({ description: 'Dinner', revision: 1, headRevision: 2, headDeleted: false })
    expect((await getDoc(doc(active, `groups/group-a/expenses/${expense.id}/revisions/${editToken}`))).data()?.expense).toMatchObject({ description: 'Audited change', revision: 2 })

    const beforeDeniedEdit = (await getDoc(doc(friend, `groups/group-a/expenses/${expense.id}`))).data()!
    const currentEditedExpense = (await getDoc(doc(friend, `groups/group-a/expenses/${expense.id}/revisions/${editToken}`))).data()?.expense as Record<string, unknown>
    const deniedToken = 'd'.repeat(48)
    await assertFails(commitSparkExpenseMutation(friend, expense.id as string, deniedToken, {
      ...beforeDeniedEdit, lastOperationId: 'friend-edit-d', lastRequestFingerprint: 'a'.repeat(64), lastResourceToken: deniedToken,
      headRevision: 3, headDeleted: false,
    }, sparkExpenseVersion({
      ...currentEditedExpense, description: 'Friend forged edit', lastOperationId: 'friend-edit-d', lastRequestFingerprint: 'a'.repeat(64), lastResourceToken: deniedToken,
      updatedAt: serverTimestamp(), updatedBy: { id: 'friend', displayName: 'Friend' }, revision: 3,
    }, 'friend-edit-d', 'updated', { id: 'friend', displayName: 'Friend' })))

    const beforeDelete = (await getDoc(reference)).data()!
    const beforeDeleteExpense = (await getDoc(doc(active, `groups/group-a/expenses/${expense.id}/revisions/${editToken}`))).data()?.expense as Record<string, unknown>
    const deleteToken = '1'.repeat(48)
    await assertSucceeds(commitSparkExpenseMutation(active, expense.id as string, deleteToken, {
      ...beforeDelete, lastOperationId: 'delete-operation-1', lastRequestFingerprint: 'b'.repeat(64), lastResourceToken: deleteToken,
      headRevision: 3, headDeleted: true,
    }, sparkExpenseVersion({
      ...beforeDeleteExpense, lastOperationId: 'delete-operation-1', lastRequestFingerprint: 'b'.repeat(64), lastResourceToken: deleteToken,
      updatedAt: serverTimestamp(), updatedBy: { id: 'active', displayName: 'Active Member' }, revision: 3, deletedAt: serverTimestamp(),
    }, 'delete-operation-1', 'deleted', { id: 'active', displayName: 'Active Member' })))
    expect((await getDoc(reference)).data()).toMatchObject({ description: 'Dinner', revision: 1, headRevision: 3, headDeleted: true })
    expect((await getDoc(doc(active, `groups/group-a/expenses/${expense.id}/revisions/${deleteToken}`))).data()?.expense).toMatchObject({ description: 'Audited change', revision: 3 })
    await assertFails(deleteDoc(reference))
    await assertFails(updateDoc(reference, { description: 'Edit after delete' }))
    await assertFails(setDoc(doc(active, 'groups/group-a/activity/activity-ffffffffffffffffffffffffffffffffffffffffffffffff'), { kind: 'expense.created' }))
    await assertFails(setDoc(doc(active, `groups/group-a/expenses/${expense.id}/revisions/forged-revision`), { action: 'updated' }))
  })

  emulatorIt('requires active-expense-coupled comments, author-only soft delete, and exact immutable activity', async () => {
    const active = environment.authenticatedContext('active').firestore()
    const friend = environment.authenticatedContext('friend').firestore()
    const outsider = environment.authenticatedContext('outsider').firestore()
    const expense = sparkExpense('9')
    await assertSucceeds(setDoc(doc(active, `groups/group-a/expenses/${expense.id}`), expense))
    const addToken = '2'.repeat(48)
    const commentId = `comment-${addToken}`
    const comment = sparkComment(addToken, expense.id as string, { id: 'friend', displayName: 'Friend' })
    const addedActivity = sparkCommentActivity(addToken, comment, 'comment.added')

    await assertFails(setDoc(doc(friend, `groups/group-a/comments/${commentId}`), comment))
    await assertFails(commitSparkComment(outsider, commentId, addToken, comment, addedActivity))
    await assertSucceeds(commitSparkComment(friend, commentId, addToken, comment, addedActivity))
    await assertSucceeds(getDocs(query(collection(friend, 'groups/group-a/comments'), where('expenseId', '==', expense.id), orderBy('createdAt', 'asc'), limit(100))))
    await assertFails(updateDoc(doc(active, `groups/group-a/comments/${commentId}`), { body: 'Manager forged body edit' }))

    const deleteToken = '3'.repeat(48)
    const deleted = {
      ...((await getDoc(doc(friend, `groups/group-a/comments/${commentId}`))).data()!),
      lastOperationId: 'comment-delete-3', lastRequestFingerprint: '3'.repeat(64), lastResourceToken: deleteToken, deletedAt: serverTimestamp(),
    }
    const deletedActivity = sparkCommentActivity(deleteToken, deleted, 'comment.deleted')
    await assertFails(commitSparkComment(active, commentId, deleteToken, deleted, deletedActivity))
    await assertSucceeds(commitSparkComment(friend, commentId, deleteToken, deleted, deletedActivity))
    await assertFails(deleteDoc(doc(friend, `groups/group-a/comments/${commentId}`)))
    await assertFails(setDoc(doc(friend, `groups/group-a/activity/activity-${'4'.repeat(48)}`), { kind: 'comment.added' }))

    await environment.withSecurityRulesDisabled(async (context) => {
      await updateDoc(doc(context.firestore(), `groups/group-a/expenses/${expense.id}`), { headDeleted: true })
    })
    const closedToken = '4'.repeat(48)
    const closedComment = sparkComment(closedToken, expense.id as string, { id: 'friend', displayName: 'Friend' })
    await assertFails(commitSparkComment(friend, `comment-${closedToken}`, closedToken, closedComment, sparkCommentActivity(closedToken, closedComment, 'comment.added')))
  })

  emulatorIt('requires replay-bound activity for manager defaults and an atomic balance revision for debt simplification', async () => {
    const manager = environment.authenticatedContext('active').firestore()
    const friend = environment.authenticatedContext('friend').firestore()
    const outsider = environment.authenticatedContext('outsider').firestore()
    const defaultToken = '5'.repeat(48)
    const defaultSplit = { type: 'percentage', participantIds: ['active', 'friend'], percentages: { active: 60, friend: 40 } }
    const defaultSettings = sparkSettings(2, 'group.default-split', 'default-operation-5', defaultToken, { id: 'active', displayName: 'Active Member' }, { defaultSplit })
    const defaultActivity = sparkSettingsActivity(defaultToken, 'default-operation-5', { id: 'active', displayName: 'Active Member' }, 'Default split updated')

    await assertFails(setDoc(doc(manager, 'groups/group-a/settings/defaults'), defaultSettings))
    await assertFails(commitSparkSettings(friend, defaultToken, { ...defaultSettings, updatedBy: { id: 'friend', displayName: 'Friend' } }, { ...defaultActivity, actor: { id: 'friend', displayName: 'Friend' } }))
    await assertFails(commitSparkSettings(outsider, defaultToken, defaultSettings, defaultActivity))
    await assertSucceeds(commitSparkSettings(manager, defaultToken, defaultSettings, defaultActivity))
    expect((await getDoc(doc(manager, 'groups/group-a/settings/defaults'))).data()).toMatchObject({ revision: 2, defaultSplit, simplifyDebtsEnabled: true })

    const forgedToken = '6'.repeat(48)
    await assertFails(commitSparkSettings(manager, forgedToken, sparkSettings(3, 'group.default-split', 'forged-default-6', forgedToken, { id: 'active', displayName: 'Active Member' }, {
      defaultSplit: { type: 'percentage', participantIds: ['active', 'friend'], percentages: { active: 50, friend: 40 } },
    }), sparkSettingsActivity(forgedToken, 'forged-default-6', { id: 'active', displayName: 'Active Member' }, 'Default split updated')))

    const simplifyToken = '7'.repeat(48)
    const simplifySettings = sparkSettings(3, 'group.simplify-debts', 'simplify-operation-7', simplifyToken, { id: 'friend', displayName: 'Friend' }, { defaultSplit, simplifyDebtsEnabled: false })
    const simplifyActivity = sparkSettingsActivity(simplifyToken, 'simplify-operation-7', { id: 'friend', displayName: 'Friend' }, 'Simplify debts disabled')
    const balance = { groupId: 'group-a', balanceRevision: 1, simplifyDebtsEnabled: false, pairwise: [], simplified: [] }

    await assertFails(commitSparkSettings(friend, simplifyToken, simplifySettings, simplifyActivity))
    await assertFails(setDoc(doc(friend, 'groups/group-a/balance/current'), balance))
    await assertSucceeds(commitSparkSettings(friend, simplifyToken, simplifySettings, simplifyActivity, balance))
    expect((await getDoc(doc(friend, 'groups/group-a/balance/current'))).data()).toEqual(balance)
    await assertFails(setDoc(doc(friend, `groups/group-a/activity/activity-${'8'.repeat(48)}`), sparkSettingsActivity('8'.repeat(48), 'standalone-activity-8', { id: 'friend', displayName: 'Friend' }, 'Simplify debts enabled')))
    await assertFails(deleteDoc(doc(friend, 'groups/group-a/settings/defaults')))
  })
})

function profile(displayName: string, initials: string): Record<string, unknown> {
  return { displayName, initials, avatarUrl: null, createdAt: serverTimestamp(), updatedAt: serverTimestamp() }
}

function group(groupId: string, ownerUid: string, memberIds: readonly string[]): Record<string, unknown> {
  return { id: groupId, name: 'Shared group', currency: 'USD', memberIds, createdByUid: ownerUid, createdAt: serverTimestamp(), updatedAt: serverTimestamp() }
}

function commitGroupBundle(source: unknown, groupId: string, ownerUid: string, displayName: string, initials: string, memberIds: readonly string[] = [ownerUid]): Promise<void> {
  const db = source as Firestore
  const batch = writeBatch(db)
  batch.set(doc(db, `groups/${groupId}`), group(groupId, ownerUid, memberIds))
  batch.set(doc(db, `groups/${groupId}/members/${ownerUid}`), { status: 'active', role: 'owner', canManage: true, displayName, initials, avatarUrl: null, joinedAt: serverTimestamp() })
  batch.set(doc(db, `groups/${groupId}/settings/defaults`), { schemaVersion: 1, groupId, revision: 1, simplifyDebtsEnabled: true, updatedAt: serverTimestamp() })
  batch.set(doc(db, `groups/${groupId}/balance/current`), { groupId, balanceRevision: 0, simplifyDebtsEnabled: true, pairwise: [], simplified: [] })
  batch.set(doc(db, `users/${ownerUid}/groups/${groupId}`), { groupId, status: 'active', joinedAt: serverTimestamp(), updatedAt: serverTimestamp() })
  return batch.commit()
}

function invitation(invitationId: string, groupId: string, creatorUid: string): Record<string, unknown> {
  return {
    schemaVersion: 1, invitationId, tokenHash: invitationId, groupId, groupName: 'Shared group', status: 'active', createdByUid: creatorUid,
    createdAt: serverTimestamp(), updatedAt: serverTimestamp(), expiresAt: Timestamp.fromMillis(Date.now() + 7 * 24 * 60 * 60 * 1000),
  }
}

function acceptInvitation(source: unknown, invitationId: string, groupId: string, uid: string, displayName: string, initials: string, memberIds: readonly string[]): Promise<void> {
  const db = source as Firestore
  const batch = writeBatch(db)
  batch.update(doc(db, `invitations/${invitationId}`), { status: 'used', usedByUid: uid, usedAt: serverTimestamp(), updatedAt: serverTimestamp() })
  batch.update(doc(db, `groups/${groupId}`), { memberIds, updatedAt: serverTimestamp() })
  batch.set(doc(db, `groups/${groupId}/members/${uid}`), { status: 'active', role: 'member', canManage: false, displayName, initials, avatarUrl: null, invitationId, joinedAt: serverTimestamp() })
  batch.set(doc(db, `users/${uid}/groups/${groupId}`), { groupId, status: 'active', invitationId, joinedAt: serverTimestamp(), updatedAt: serverTimestamp() })
  return batch.commit()
}

function sparkExpense(token = 'a', overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const resourceToken = token.repeat(48)
  const expenseId = `expense-${resourceToken}`
  const activityId = `activity-${resourceToken}`
  const allocations = [
    { participantId: 'active', money: { currency: 'USD', minorAmount: 400 } },
    { participantId: 'friend', money: { currency: 'USD', minorAmount: 600 } },
  ]
  return {
    id: expenseId, groupId: 'group-a', operationId: `expense-operation-${token}`, requestFingerprint: token.repeat(64), resourceToken,
    lastOperationId: `expense-operation-${token}`, lastRequestFingerprint: token.repeat(64), lastResourceToken: resourceToken,
    description: 'Dinner', date: '2026-09-01', total: { currency: 'USD', minorAmount: 1000 },
    payments: [{ participantId: 'active', money: { currency: 'USD', minorAmount: 1000 } }], allocations,
    payerIds: ['active'], participantIds: ['active', 'friend'], involvedMemberIds: ['active', 'friend'], category: 'Food', splitType: 'percentage',
    splitMethod: { type: 'exact', allocations }, attachmentRefs: [], createdAt: serverTimestamp(), createdBy: { id: 'active', displayName: 'Active Member' },
    updatedAt: serverTimestamp(), updatedBy: { id: 'active', displayName: 'Active Member' }, revision: 1,
    ...overrides,
  }
}

function sparkExpenseVersion(expense: Record<string, unknown>, operationId: string, action: 'updated' | 'deleted', actor: Record<string, unknown>): Record<string, unknown> {
  return {
    groupId: 'group-a', expenseId: expense.id, revision: expense.revision,
    operationId, action, actor, createdAt: serverTimestamp(), expense,
  }
}

function commitSparkExpenseMutation(source: unknown, expenseId: string, revisionId: string, head: Record<string, unknown>, revision: Record<string, unknown>): Promise<void> {
  const db = source as Firestore
  const batch = writeBatch(db)
  batch.set(doc(db, `groups/group-a/expenses/${expenseId}`), head)
  batch.set(doc(db, `groups/group-a/expenses/${expenseId}/revisions/${revisionId}`), revision)
  return batch.commit()
}

function sparkComment(token: string, expenseId: string, author: Record<string, unknown>): Record<string, unknown> {
  return {
    groupId: 'group-a', expenseId, operationId: `comment-add-${token[0]}`, requestFingerprint: token[0]!.repeat(64), resourceToken: token,
    lastOperationId: `comment-add-${token[0]}`, lastRequestFingerprint: token[0]!.repeat(64), lastResourceToken: token,
    author, body: 'Shared comment', attachmentRefs: [], createdAt: serverTimestamp(),
  }
}

function sparkCommentActivity(token: string, comment: Record<string, unknown>, kind: 'comment.added' | 'comment.deleted'): Record<string, unknown> {
  const operationId = kind === 'comment.added' ? comment.operationId : comment.lastOperationId
  return {
    groupId: 'group-a', operationId, kind,
    subject: { kind: 'comment', id: `comment-${comment.resourceToken}`, label: comment.body },
    actor: comment.author, expenseId: comment.expenseId, commentId: `comment-${comment.resourceToken}`, createdAt: serverTimestamp(),
    ...(kind === 'comment.deleted' ? { commentId: `comment-${'2'.repeat(48)}`, subject: { kind: 'comment', id: `comment-${'2'.repeat(48)}`, label: comment.body } } : {}),
  }
}

function commitSparkComment(source: unknown, commentId: string, activityToken: string, comment: Record<string, unknown>, activity: Record<string, unknown>): Promise<void> {
  const db = source as Firestore
  const batch = writeBatch(db)
  batch.set(doc(db, `groups/group-a/comments/${commentId}`), comment)
  batch.set(doc(db, `groups/group-a/activity/activity-${activityToken}`), activity)
  return batch.commit()
}

function sparkSettings(revision: number, lastCommandKind: 'group.default-split' | 'group.simplify-debts', operationId: string, token: string, actor: Record<string, unknown>, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: 1, groupId: 'group-a', revision, simplifyDebtsEnabled: true,
    lastCommandKind, lastOperationId: operationId, lastRequestFingerprint: token[0]!.repeat(64), lastResourceToken: token,
    updatedAt: serverTimestamp(), updatedBy: actor, ...overrides,
  }
}

function sparkSettingsActivity(token: string, operationId: string, actor: Record<string, unknown>, label: string): Record<string, unknown> {
  return {
    groupId: 'group-a', operationId, kind: 'group.event', subject: { kind: 'group', id: 'group-a', label }, actor, createdAt: serverTimestamp(),
  }
}

function commitSparkSettings(source: unknown, token: string, settings: Record<string, unknown>, activity: Record<string, unknown>, balance?: Record<string, unknown>): Promise<void> {
  const db = source as Firestore
  const batch = writeBatch(db)
  batch.set(doc(db, 'groups/group-a/settings/defaults'), settings)
  batch.set(doc(db, `groups/group-a/activity/activity-${token}`), activity)
  if (balance) batch.set(doc(db, 'groups/group-a/balance/current'), balance)
  return batch.commit()
}


describe('Storage rules in the emulator', () => {
  const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1])
  const metadata = { contentType: 'image/png', customMetadata: { ownerUid: 'active', operationId: '12345678-1234-1234-1234-123456789012', purpose: 'expense-receipt' } }

  emulatorIt('allows one owner draft create/read/delete and denies overwrite, other users, spoofed metadata, and unsafe types', async () => {
    const owner = environment.authenticatedContext('active').storage(bucketUrl)
    const outsider = environment.authenticatedContext('outsider').storage(bucketUrl)
    const draft = ref(owner, 'drafts/active/asset-a')
    await assertSucceeds(uploadBytes(draft, png, metadata))
    await assertSucceeds(getBytes(draft))
    await assertFails(uploadBytes(draft, png, metadata))
    await assertFails(getBytes(ref(outsider, 'drafts/active/asset-a')))
    await assertFails(uploadBytes(ref(owner, 'drafts/active/asset-b'), png, { ...metadata, customMetadata: { ...metadata.customMetadata, ownerUid: 'outsider' } }))
    await assertFails(uploadBytes(ref(owner, 'drafts/active/asset-c'), png, { contentType: 'image/svg+xml', customMetadata: metadata.customMetadata }))
    await assertFails(uploadBytes(ref(owner, 'drafts/active/asset-d'), png, { ...metadata, customMetadata: { ...metadata.customMetadata, extra: 'forbidden' } }))
    await assertSucceeds(deleteObject(draft))
  })

  emulatorIt('enforces non-empty and exact size boundaries and keeps final paths server-owned', async () => {
    const owner = environment.authenticatedContext('active').storage(bucketUrl)
    const outsider = environment.authenticatedContext('outsider').storage(bucketUrl)
    const anonymous = environment.unauthenticatedContext().storage(bucketUrl)
    await assertFails(uploadBytes(ref(owner, 'drafts/active/empty'), new Uint8Array(), metadata))
    await assertSucceeds(uploadBytes(ref(owner, 'drafts/active/max'), new Uint8Array(15 * 1024 * 1024), metadata))
    await assertFails(uploadBytes(ref(owner, 'drafts/active/too-large'), new Uint8Array(15 * 1024 * 1024 + 1), metadata))
    await assertFails(uploadBytes(ref(anonymous, 'drafts/active/anonymous'), png, metadata))
    await assertFails(deleteObject(ref(outsider, 'drafts/active/max')))
    await assertFails(uploadBytes(ref(owner, 'groups/group-a/assets/final'), png, { contentType: 'image/png' }))
    await assertFails(uploadBytes(ref(owner, 'exports/active/job/report.csv'), new Uint8Array([1]), { contentType: 'text/csv' }))
  }, 30_000)

  emulatorIt('accepts every allowlisted image MIME and rejects incomplete metadata and owner-only export reads', async () => {
    const owner = environment.authenticatedContext('active').storage(bucketUrl)
    const outsider = environment.authenticatedContext('outsider').storage(bucketUrl)
    for (const [index, contentType] of ['image/jpeg', 'image/png', 'image/heic', 'image/heif', 'image/webp'].entries()) {
      await assertSucceeds(uploadBytes(ref(owner, `drafts/active/mime-${index}`), png, { ...metadata, contentType }))
    }
    await assertFails(uploadBytes(ref(owner, 'drafts/active/missing-operation'), png, { contentType: 'image/png', customMetadata: { ownerUid: 'active', purpose: 'expense-receipt' } }))
    await environment.withSecurityRulesDisabled(async (context) => {
      await uploadBytes(ref(context.storage(bucketUrl), 'exports/active/job/report.csv'), new Uint8Array([1]), { contentType: 'text/csv' })
    })
    await assertSucceeds(getBytes(ref(owner, 'exports/active/job/report.csv')))
    await assertFails(getBytes(ref(outsider, 'exports/active/job/report.csv')))
  })
})
