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
    await setDoc(doc(db, 'groups/group-a'), { name: 'Group A', currency: 'USD', memberIds: ['active', 'friend'] })
    await setDoc(doc(db, 'groups/group-a/members/active'), { status: 'active', canManage: true, displayName: 'Active Member' })
    await setDoc(doc(db, 'groups/group-a/members/friend'), { status: 'active', canManage: false, displayName: 'Friend' })
    await setDoc(doc(db, 'groups/group-a/members/removed'), { status: 'removed' })
    await setDoc(doc(db, 'users/active/groups/group-a'), { groupId: 'group-a', status: 'active' })
    await setDoc(doc(db, 'users/friend/groups/group-a'), { groupId: 'group-a', status: 'active' })
    await setDoc(doc(db, 'users/removed/groups/group-a'), { groupId: 'group-a', status: 'removed' })
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
    await assertSucceeds(commitGroupBundle(owner, 'group-profile', 'new-owner', 'New Owner', 'NO'))
    await assertFails(setDoc(doc(owner, 'users/someone-else'), profile('Someone Else', 'SE')))
    await assertFails(setDoc(doc(attacker, 'users/attacker'), { ...profile('Attacker', 'A'), admin: true }))
    await assertFails(updateDoc(doc(owner, 'users/new-owner'), { displayName: 'Unversioned Owner', initials: 'UO', updatedAt: serverTimestamp() }))
    await assertSucceeds(commitSparkProfileUpdate(owner, 'new-owner', 'group-profile', 'Owner Updated', 'OU'))
    await assertFails(commitSparkProfileUpdate(attacker, 'new-owner', 'group-profile', 'Forged Owner', 'FO'))
    await assertFails(updateDoc(doc(owner, 'users/new-owner'), { createdAt: serverTimestamp() }))
  })

  emulatorIt('versions notification preferences privately and denies cross-account access', async () => {
    const owner = environment.authenticatedContext('active').firestore()
    const outsider = environment.authenticatedContext('outsider').firestore()
    const reference = doc(owner, 'users/active/settings/notifications')
    await assertSucceeds(setDoc(reference, sparkNotificationPreferences(1, 'preferences-create', 'a'.repeat(48), false, true)))
    await assertSucceeds(getDoc(reference))
    await assertFails(getDoc(doc(outsider, 'users/active/settings/notifications')))
    await assertFails(setDoc(doc(outsider, 'users/active/settings/notifications'), sparkNotificationPreferences(2, 'preferences-forged', 'b'.repeat(48), true, false)))
    await assertFails(setDoc(reference, sparkNotificationPreferences(3, 'preferences-skip', 'c'.repeat(48), true, false)))
    await assertSucceeds(setDoc(reference, sparkNotificationPreferences(2, 'preferences-update', 'd'.repeat(48), true, false)))
  })

  emulatorIt('stores only exact owner-private notification receipts and a monotonic read-all cursor', async () => {
    const activityId = 'activity-notification-a'
    await environment.withSecurityRulesDisabled(async (context) => {
      await setDoc(doc(context.firestore(), `groups/group-a/activity/${activityId}`), {
        groupId: 'group-a', operationId: 'source-notification-a', kind: 'expense.created',
        subject: { kind: 'expense', id: 'expense-a', label: 'Dinner' }, actor: { id: 'friend', displayName: 'Friend' },
        expenseId: 'expense-a', resourceToken: 'a'.repeat(48), revision: 1, createdAt: Timestamp.fromDate(new Date('2026-09-01T17:30:00.000Z')),
      })
    })
    const owner = environment.authenticatedContext('active').firestore()
    const outsider = environment.authenticatedContext('outsider').firestore()
    const receipt = sparkNotificationReadReceipt(activityId, 'read-notification-a', 'b'.repeat(48))
    const receiptPath = `users/active/notificationReads/${activityId}`

    await assertSucceeds(setDoc(doc(owner, receiptPath), receipt))
    await assertSucceeds(getDoc(doc(owner, receiptPath)))
    await assertFails(getDoc(doc(outsider, receiptPath)))
    await assertFails(setDoc(doc(outsider, `users/outsider/notificationReads/${activityId}`), receipt))
    await assertFails(setDoc(doc(owner, 'users/active/notificationReads/activity-forged'), { ...receipt, notificationId: 'activity-forged', activityId: 'activity-forged' }))
    await assertFails(updateDoc(doc(owner, receiptPath), { readAt: serverTimestamp() }))
    await assertFails(deleteDoc(doc(owner, receiptPath)))

    const cursorPath = 'users/active/settings/sparkNotificationReadCursor'
    await assertSucceeds(setDoc(doc(owner, cursorPath), sparkNotificationReadCursor(1, 'read-all-a', 'c'.repeat(48), '2026-09-01T17:30:00.000Z', activityId)))
    await assertFails(setDoc(doc(outsider, cursorPath), sparkNotificationReadCursor(1, 'read-all-forged', 'd'.repeat(48), '2026-09-01T17:30:00.000Z', activityId)))
    await assertFails(setDoc(doc(owner, cursorPath), sparkNotificationReadCursor(3, 'read-all-skipped', 'e'.repeat(48), '2026-09-02T08:00:00.000Z', 'activity-notification-b')))
    await assertFails(setDoc(doc(owner, cursorPath), sparkNotificationReadCursor(2, 'read-all-backward', 'f'.repeat(48), '2026-09-01T16:00:00.000Z', 'activity-notification-old')))
    await assertSucceeds(setDoc(doc(owner, cursorPath), sparkNotificationReadCursor(2, 'read-all-b', '1'.repeat(48), '2026-09-02T08:00:00.000Z', 'activity-notification-b')))
    await assertFails(deleteDoc(doc(owner, cursorPath)))
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
    await environment.withSecurityRulesDisabled(async (context) => {
      await setDoc(doc(context.firestore(), 'groups/group-a/members/outsider'), { status: 'active', canManage: false, displayName: 'Outsider' })
      await setDoc(doc(context.firestore(), 'users/outsider/groups/group-a'), { groupId: 'group-a', status: 'active' })
    })
    const active = environment.authenticatedContext('active').firestore()
    const outsider = environment.authenticatedContext('outsider').firestore()
    const removed = environment.authenticatedContext('removed').firestore()
    const anonymous = environment.unauthenticatedContext().firestore()
    await assertSucceeds(getDoc(doc(active, 'users/active')))
    await assertFails(getDoc(doc(active, 'users/outsider')))
    await assertSucceeds(getDoc(doc(active, 'groups/group-a/expenses/expense-a')))
    await assertFails(getDoc(doc(outsider, 'groups/group-a/expenses/expense-a')))
    await assertFails(getDoc(doc(outsider, 'groups/group-a')))
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

  emulatorIt('allows one strictly validated expense and immutable activity bundle from an active member', async () => {
    const active = environment.authenticatedContext('active').firestore()
    const outsider = environment.authenticatedContext('outsider').firestore()
    const valid = sparkExpense()
    await assertSucceeds(setDoc(doc(active, `groups/group-a/expenses/${valid.id}`), valid))
    await assertSucceeds(setDoc(doc(active, `groups/group-a/activity/activity-${valid.lastResourceToken}`), sparkExpenseActivity(valid, 'expense.created', (await getDoc(doc(active, `groups/group-a/expenses/${valid.id}`))).data()!.createdAt)))
    await assertSucceeds(getDoc(doc(active, 'groups/group-a/expenses/expense-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa')))

    const outsiderExpense = sparkExpense('b')
    await assertFails(setDoc(doc(outsider, `groups/group-a/expenses/${outsiderExpense.id}`), outsiderExpense))
    const mismatchedLedger = sparkExpense('c', { allocations: [
      { participantId: 'active', money: { currency: 'USD', minorAmount: 400 } },
      { participantId: 'friend', money: { currency: 'USD', minorAmount: 599 } },
    ] })
    await assertFails(setDoc(doc(active, `groups/group-a/expenses/${mismatchedLedger.id}`), mismatchedLedger))
    const removedParticipant = sparkExpense('d', {
      participantIds: ['active', 'removed'], involvedMemberIds: ['active', 'removed'], allocations: [
        { participantId: 'active', money: { currency: 'USD', minorAmount: 400 } },
        { participantId: 'removed', money: { currency: 'USD', minorAmount: 600 } },
      ],
    })
    await assertFails(setDoc(doc(active, `groups/group-a/expenses/${removedParticipant.id}`), removedParticipant))
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
    const editHead = {
      ...beforeEdit, lastOperationId: 'edit-operation-f', lastRequestFingerprint: 'f'.repeat(64), lastResourceToken: editToken,
      headRevision: 2, headDeleted: false,
    }
    const editVersion = sparkExpenseVersion(editedExpense, 'edit-operation-f', 'updated', { id: 'active', displayName: 'Active Member' })
    await assertSucceeds(commitSparkExpenseMutation(active, expense.id as string, editToken, editHead, editVersion))
    const savedEditVersion = (await getDoc(doc(active, `groups/group-a/expenses/${expense.id}/revisions/${editToken}`))).data()!
    await assertSucceeds(setDoc(doc(active, `groups/group-a/activity/activity-${editToken}`), sparkExpenseActivity(editedExpense, 'expense.updated', savedEditVersion.createdAt)))
    expect((await getDoc(reference)).data()).toMatchObject({ description: 'Dinner', revision: 1, headRevision: 2, headDeleted: false })
    expect((await getDoc(doc(active, `groups/group-a/expenses/${expense.id}/revisions/${editToken}`))).data()?.expense).toMatchObject({ description: 'Audited change', revision: 2 })

    const beforeDeniedEdit = (await getDoc(doc(friend, `groups/group-a/expenses/${expense.id}`))).data()!
    const currentEditedExpense = (await getDoc(doc(friend, `groups/group-a/expenses/${expense.id}/revisions/${editToken}`))).data()?.expense as Record<string, unknown>
    const deniedToken = 'd'.repeat(48)
    const forgedExpense = {
      ...currentEditedExpense, description: 'Friend forged edit', lastOperationId: 'friend-edit-d', lastRequestFingerprint: 'a'.repeat(64), lastResourceToken: deniedToken,
      updatedAt: serverTimestamp(), updatedBy: { id: 'friend', displayName: 'Friend' }, revision: 3,
    }
    await assertFails(commitSparkExpenseMutation(friend, expense.id as string, deniedToken, {
      ...beforeDeniedEdit, lastOperationId: 'friend-edit-d', lastRequestFingerprint: 'a'.repeat(64), lastResourceToken: deniedToken,
      headRevision: 3, headDeleted: false,
    }, sparkExpenseVersion(forgedExpense, 'friend-edit-d', 'updated', { id: 'friend', displayName: 'Friend' })))

    const beforeDelete = (await getDoc(reference)).data()!
    const beforeDeleteExpense = (await getDoc(doc(active, `groups/group-a/expenses/${expense.id}/revisions/${editToken}`))).data()?.expense as Record<string, unknown>
    const deleteToken = '1'.repeat(48)
    const deletedExpense = {
      ...beforeDeleteExpense, lastOperationId: 'delete-operation-1', lastRequestFingerprint: 'b'.repeat(64), lastResourceToken: deleteToken,
      updatedAt: serverTimestamp(), updatedBy: { id: 'active', displayName: 'Active Member' }, revision: 3, deletedAt: serverTimestamp(),
    }
    await assertSucceeds(commitSparkExpenseMutation(active, expense.id as string, deleteToken, {
      ...beforeDelete, lastOperationId: 'delete-operation-1', lastRequestFingerprint: 'b'.repeat(64), lastResourceToken: deleteToken,
      headRevision: 3, headDeleted: true,
    }, sparkExpenseVersion(deletedExpense, 'delete-operation-1', 'deleted', { id: 'active', displayName: 'Active Member' })))
    const savedDeleteVersion = (await getDoc(doc(active, `groups/group-a/expenses/${expense.id}/revisions/${deleteToken}`))).data()!
    await assertSucceeds(setDoc(doc(active, `groups/group-a/activity/activity-${deleteToken}`), sparkExpenseActivity(deletedExpense, 'expense.deleted', savedDeleteVersion.createdAt)))
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

  emulatorIt('requires participant-owned settlements, exact immutable activity, and an authorized single void', async () => {
    await environment.withSecurityRulesDisabled(async (context) => {
      const db = context.firestore()
      await updateDoc(doc(db, 'groups/group-a'), { memberIds: ['active', 'friend', 'other'] })
      await setDoc(doc(db, 'groups/group-a/members/other'), { status: 'active', canManage: false, displayName: 'Other Member' })
      await setDoc(doc(db, 'users/other/groups/group-a'), { groupId: 'group-a', status: 'active' })
    })
    const friend = environment.authenticatedContext('friend').firestore()
    const manager = environment.authenticatedContext('active').firestore()
    const other = environment.authenticatedContext('other').firestore()
    const outsider = environment.authenticatedContext('outsider').firestore()
    const createToken = 'a'.repeat(48)
    const settlementId = `settlement-${createToken}`
    const settlement = sparkSettlement(createToken, { id: 'friend', displayName: 'Friend' })
    const createdActivity = sparkSettlementActivity(createToken, settlement, 'settlement.created')

    await assertFails(setDoc(doc(friend, `groups/group-a/settlements/${settlementId}`), settlement))
    await assertFails(commitSparkSettlement(outsider, settlementId, createToken, settlement, createdActivity))
    await assertFails(commitSparkSettlement(friend, settlementId, createToken, { ...settlement, money: { currency: 'USD', minorAmount: 601 } }, createdActivity))
    await assertSucceeds(commitSparkSettlement(friend, settlementId, createToken, settlement, createdActivity))
    await assertSucceeds(getDoc(doc(manager, `groups/group-a/settlements/${settlementId}`)))
    await assertFails(updateDoc(doc(friend, `groups/group-a/settlements/${settlementId}`), { note: 'Forged edit' }))

    const voidToken = 'b'.repeat(48)
    const current = (await getDoc(doc(manager, `groups/group-a/settlements/${settlementId}`))).data()!
    const voided = {
      ...current, lastOperationId: 'settlement-void-b', lastRequestFingerprint: 'b'.repeat(64), lastResourceToken: voidToken, revision: 2,
      void: { operationId: 'settlement-void-b', reason: 'Entered twice.', actor: { id: 'active', displayName: 'Active Member' }, createdAt: serverTimestamp(), revision: 2 },
    }
    const voidedActivity = sparkSettlementActivity(voidToken, voided, 'settlement.voided')
    await assertFails(commitSparkSettlement(other, settlementId, voidToken, { ...voided, void: { ...(voided.void as Record<string, unknown>), actor: { id: 'other', displayName: 'Other Member' } } }, { ...voidedActivity, actor: { id: 'other', displayName: 'Other Member' } }))
    await assertSucceeds(commitSparkSettlement(manager, settlementId, voidToken, voided, voidedActivity))
    expect((await getDoc(doc(manager, `groups/group-a/settlements/${settlementId}`))).data()).toMatchObject({ revision: 2, void: { reason: 'Entered twice.', revision: 2 } })
    await assertFails(commitSparkSettlement(manager, settlementId, 'c'.repeat(48), { ...voided, lastOperationId: 'second-void', lastRequestFingerprint: 'c'.repeat(64), lastResourceToken: 'c'.repeat(48) }, sparkSettlementActivity('c'.repeat(48), voided, 'settlement.voided')))
    await assertFails(deleteDoc(doc(manager, `groups/group-a/settlements/${settlementId}`)))
    await assertFails(setDoc(doc(manager, `groups/group-a/activity/activity-${'d'.repeat(48)}`), sparkSettlementActivity('d'.repeat(48), voided, 'settlement.voided')))
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

function commitSparkProfileUpdate(source: unknown, uid: string, groupId: string, displayName: string, initials: string): Promise<void> {
  const db = source as Firestore
  const batch = writeBatch(db)
  batch.update(doc(db, `users/${uid}`), {
    displayName, initials, avatarUrl: null, updatedAt: serverTimestamp(),
    lastCommandKind: 'profile.update', lastOperationId: 'profile-rename',
    lastRequestFingerprint: 'e'.repeat(64), lastResourceToken: 'e'.repeat(48),
  })
  batch.update(doc(db, `groups/${groupId}/members/${uid}`), { displayName, initials, avatarUrl: null })
  return batch.commit()
}

function sparkNotificationPreferences(revision: number, operationId: string, token: string, emailEnabled: boolean, pushEnabled: boolean): Record<string, unknown> {
  return {
    schemaVersion: 1, revision, emailEnabled, pushEnabled,
    lastCommandKind: 'notification.preferences', lastOperationId: operationId,
    lastRequestFingerprint: token[0]!.repeat(64), lastResourceToken: token,
    updatedAt: serverTimestamp(),
  }
}

function sparkNotificationReadReceipt(activityId: string, operationId: string, token: string): Record<string, unknown> {
  return {
    schemaVersion: 1, notificationId: activityId, groupId: 'group-a', activityId,
    sourceCreatedAt: '2026-09-01T17:30:00.000Z', readAt: serverTimestamp(), operationId,
    requestFingerprint: token[0]!.repeat(64), resourceToken: token,
  }
}

function sparkNotificationReadCursor(revision: number, operationId: string, token: string, cutoffCreatedAt: string, cutoffId: string): Record<string, unknown> {
  return {
    schemaVersion: 1, revision, cutoffCreatedAt, cutoffId, readNotificationIds: [cutoffId], updatedAt: serverTimestamp(),
    lastCommandKind: 'notification.read-all', lastOperationId: operationId,
    lastRequestFingerprint: token[0]!.repeat(64), lastResourceToken: token,
  }
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

function sparkExpenseActivity(expense: Record<string, unknown>, kind: 'expense.created' | 'expense.updated' | 'expense.deleted', createdAt: unknown): Record<string, unknown> {
  const actor = kind === 'expense.created' ? expense.createdBy : expense.updatedBy
  return {
    groupId: 'group-a', operationId: expense.lastOperationId, kind,
    subject: { kind: 'expense', id: expense.id, label: expense.description },
    actor, expenseId: expense.id, resourceToken: expense.lastResourceToken, revision: expense.revision, createdAt,
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

function sparkSettlement(token: string, actor: Record<string, unknown>): Record<string, unknown> {
  const settlementId = `settlement-${token}`
  return {
    settlementId, groupId: 'group-a', operationId: `settlement-create-${token[0]}`,
    requestFingerprint: token[0]!.repeat(64), resourceToken: token,
    lastOperationId: `settlement-create-${token[0]}`, lastRequestFingerprint: token[0]!.repeat(64), lastResourceToken: token,
    senderId: 'friend', recipientId: 'active', money: { currency: 'USD', minorAmount: 600 },
    basis: { kind: 'simplified', senderId: 'friend', recipientId: 'active', currency: 'USD', debtMinor: 600 },
    method: 'cash', occurredOn: '2026-09-01', note: 'Paid in person', outsidePaymentConfirmed: true,
    createdBy: actor, createdAt: serverTimestamp(), revision: 1,
  }
}

function sparkSettlementActivity(token: string, settlement: Record<string, unknown>, kind: 'settlement.created' | 'settlement.voided'): Record<string, unknown> {
  const voided = settlement.void as Record<string, unknown> | undefined
  const actor = kind === 'settlement.created' ? settlement.createdBy : voided?.actor
  const operationId = kind === 'settlement.created' ? settlement.operationId : voided?.operationId
  return {
    groupId: 'group-a', operationId, kind,
    subject: { kind: 'settlement', id: settlement.settlementId, label: kind === 'settlement.created' ? 'Payment recorded' : 'Payment voided' },
    actor, settlementId: settlement.settlementId, createdAt: serverTimestamp(),
  }
}

function commitSparkSettlement(source: unknown, settlementId: string, activityToken: string, settlement: Record<string, unknown>, activity: Record<string, unknown>): Promise<void> {
  const db = source as Firestore
  const batch = writeBatch(db)
  batch.set(doc(db, `groups/group-a/settlements/${settlementId}`), settlement)
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
