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
    await setDoc(doc(db, 'users/manager'), { displayName: 'Series Manager', initials: 'SM' })
    await setDoc(doc(db, 'users/materializer'), { displayName: 'Materializer', initials: 'M' })
    await setDoc(doc(db, 'groups/group-a'), { name: 'Group A', currency: 'USD', memberIds: ['active', 'friend', 'manager', 'materializer'] })
    await setDoc(doc(db, 'groups/group-a/members/active'), { status: 'active', canManage: true, displayName: 'Active Member' })
    await setDoc(doc(db, 'groups/group-a/members/friend'), { status: 'active', canManage: false, displayName: 'Friend' })
    await setDoc(doc(db, 'groups/group-a/members/manager'), { status: 'active', canManage: true, displayName: 'Series Manager' })
    await setDoc(doc(db, 'groups/group-a/members/materializer'), { status: 'active', canManage: false, displayName: 'Materializer' })
    await setDoc(doc(db, 'groups/group-a/members/removed'), { status: 'removed' })
    await setDoc(doc(db, 'users/active/groups/group-a'), { groupId: 'group-a', status: 'active' })
    await setDoc(doc(db, 'users/friend/groups/group-a'), { groupId: 'group-a', status: 'active' })
    await setDoc(doc(db, 'users/manager/groups/group-a'), { groupId: 'group-a', status: 'active' })
    await setDoc(doc(db, 'users/materializer/groups/group-a'), { groupId: 'group-a', status: 'active' })
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

  emulatorIt('moves only the current account through a retryable deletion tombstone and then denies shared access', async () => {
    const owner = environment.authenticatedContext('delete-owner', { email: 'delete-owner@example.com', email_verified: true }).firestore()
    const attacker = environment.authenticatedContext('delete-attacker', { email: 'attacker@example.com', email_verified: true }).firestore()
    const profileReference = doc(owner, 'users/delete-owner')
    await assertSucceeds(setDoc(profileReference, profile('Delete Owner', 'DO')))
    await assertSucceeds(setDoc(doc(attacker, 'users/delete-attacker'), profile('Delete Attacker', 'DA')))
    await assertSucceeds(commitGroupBundle(owner, 'group-delete-account', 'delete-owner', 'Delete Owner', 'DO'))
    const createdAt = (await getDoc(profileReference)).data()!.createdAt

    await assertSucceeds(setDoc(profileReference, deletingProfile(createdAt, ['group-delete-account'], 'deleting')))
    await assertSucceeds(getDoc(doc(owner, 'groups/group-delete-account')))
    await assertFails(commitSparkProfileUpdate(owner, 'delete-owner', 'group-delete-account', 'Usable Again', 'UA'))
    await assertFails(setDoc(doc(attacker, 'users/delete-owner'), deletingProfile(createdAt, ['group-delete-account'], 'deleting')))

    const cleanup = writeBatch(owner)
    cleanup.set(doc(owner, 'groups/group-delete-account'), {
      ...(await getDoc(doc(owner, 'groups/group-delete-account'))).data()!, memberIds: [], status: 'deleted',
      deletedAt: serverTimestamp(), deletedBy: { id: 'delete-owner', displayName: 'Deleted user' }, updatedAt: serverTimestamp(),
      lastAccountDeletionId: 'account-delete-12345678', lastDeletedAccountUid: 'delete-owner',
    })
    cleanup.set(doc(owner, 'groups/group-delete-account/members/delete-owner'), {
      ...(await getDoc(doc(owner, 'groups/group-delete-account/members/delete-owner'))).data()!, status: 'removed', role: 'member', canManage: false,
      displayName: 'Deleted user', initials: 'DU', avatarUrl: null, accountStatus: 'deleted',
      accountDeletionId: 'account-delete-12345678', accountDeletedAt: serverTimestamp(),
    })
    await assertSucceeds(cleanup.commit())
    await assertSucceeds(deleteDoc(doc(owner, 'users/delete-owner/groups/group-delete-account')))

    const deleting = (await getDoc(profileReference)).data()!
    await assertSucceeds(setDoc(profileReference, deletingProfile(createdAt, ['group-delete-account'], 'prepared', deleting.deletionRequestedAt)))
    await assertFails(getDoc(doc(owner, 'groups/group-delete-account')))

    const prepared = (await getDoc(profileReference)).data()!
    await assertSucceeds(setDoc(profileReference, deletingProfile(createdAt, ['group-delete-account'], 'deleting', prepared.deletionRequestedAt)))
    await assertFails(getDoc(doc(owner, 'groups/group-delete-account')))
  })

  emulatorIt('anonymizes only the deleting account while preserving the shared ledger and removing private data', async () => {
    const ownerActor = { id: 'active', displayName: 'Active Member' }
    const friendActor = { id: 'friend', displayName: 'Friend' }
    const expense = sparkExpense('a')
    const revision = sparkExpenseVersion(expense, 'expense-revision-a', 'updated', ownerActor)
    const activity = sparkExpenseActivity(expense, 'expense.created', Timestamp.fromDate(new Date('2026-09-01T12:00:00.000Z')))
    const comment = sparkComment('b'.repeat(48), String(expense.id), ownerActor)
    const settlement: Record<string, unknown> = {
      ...sparkSettlement('c'.repeat(48), ownerActor), revision: 2,
      void: { operationId: 'settlement-void-c', reason: 'Duplicate', actor: ownerActor, createdAt: Timestamp.fromDate(new Date('2026-09-01T13:00:00.000Z')), revision: 2 },
    }
    const settlementId = String(settlement.settlementId)
    const recurringSource = sparkRecurringSource('d')
    const recurring = sparkRecurringTemplate(recurringSource, '2026-10-01')
    const cancelledRecurring = {
      ...sparkRecurringTemplate({ ...sparkRecurringSource('f'), createdBy: ownerActor, updatedBy: friendActor }, '2026-11-01'),
      id: 'recurring-cancelled-f', status: 'cancelled', involvedMemberIds: ['friend'], createdBy: ownerActor, updatedBy: friendActor,
    }
    const settings = sparkSettings(2, 'group.default-split', 'default-split-a', 'e'.repeat(48), ownerActor, {
      defaultSplit: { type: 'equal', participantIds: ['active', 'friend'] },
    })
    const invitationId = 'zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz'

    await environment.withSecurityRulesDisabled(async (context) => {
      const db = context.firestore()
      await setDoc(doc(db, 'users/active'), { displayName: 'Active Member', initials: 'AM', avatarUrl: null, createdAt: Timestamp.fromMillis(1), updatedAt: Timestamp.fromMillis(1) })
      await setDoc(doc(db, 'users/friend'), { displayName: 'Friend', initials: 'F', avatarUrl: null, createdAt: Timestamp.fromMillis(1), updatedAt: Timestamp.fromMillis(1) })
      await setDoc(doc(db, 'groups/group-a'), { ...group('group-a', 'active', ['active', 'friend'], 'friendship'), createdAt: Timestamp.fromMillis(1), updatedAt: Timestamp.fromMillis(1) })
      await setDoc(doc(db, 'groups/group-a/members/active'), { status: 'active', role: 'owner', canManage: true, displayName: 'Active Member', initials: 'AM', avatarUrl: null, joinedAt: Timestamp.fromMillis(1) })
      await setDoc(doc(db, 'groups/group-a/members/friend'), { status: 'active', role: 'member', canManage: false, displayName: 'Friend', initials: 'F', avatarUrl: null, joinedAt: Timestamp.fromMillis(1) })
      await setDoc(doc(db, 'users/active/groups/group-a'), { groupId: 'group-a', status: 'active', contextLabel: 'Friend', joinedAt: Timestamp.fromMillis(1), updatedAt: Timestamp.fromMillis(1) })
      await setDoc(doc(db, 'users/friend/groups/group-a'), { groupId: 'group-a', status: 'active', contextLabel: 'Active Member', joinedAt: Timestamp.fromMillis(1), updatedAt: Timestamp.fromMillis(1) })
      await setDoc(doc(db, `groups/group-a/expenses/${expense.id}`), expense)
      await setDoc(doc(db, `groups/group-a/expenses/${expense.id}/revisions/revision-a`), revision)
      await setDoc(doc(db, `groups/group-a/activity/activity-${'a'.repeat(48)}`), activity)
      await setDoc(doc(db, `groups/group-a/comments/comment-${'b'.repeat(48)}`), comment)
      await setDoc(doc(db, `groups/group-a/settlements/${settlementId}`), settlement)
      await setDoc(doc(db, `groups/group-a/recurringTemplates/${recurring.id}`), recurring)
      await setDoc(doc(db, `groups/group-a/recurringTemplates/${cancelledRecurring.id}`), cancelledRecurring)
      await setDoc(doc(db, 'groups/group-a/settings/defaults'), settings)
      await setDoc(doc(db, `invitations/${invitationId}`), {
        schemaVersion: 1, invitationId, tokenHash: invitationId, groupId: 'group-a', groupKind: 'friendship', groupName: 'Shared group',
        status: 'active', createdByUid: 'active', createdByName: 'Active Member', targetEmail: 'friend@example.com',
        createdAt: Timestamp.fromMillis(1), updatedAt: Timestamp.fromMillis(1), expiresAt: Timestamp.fromMillis(Date.now() + 86_400_000),
      })
      await setDoc(doc(db, 'users/active/settings/notifications'), { emailEnabled: true, pushEnabled: true })
      await setDoc(doc(db, 'users/friend/settings/notifications'), { emailEnabled: true, pushEnabled: true })
    })

    const owner = environment.authenticatedContext('active', { email: 'active@example.com', email_verified: true }).firestore()
    const friend = environment.authenticatedContext('friend', { email: 'friend@example.com', email_verified: true }).firestore()
    const ownerProfile = (await getDoc(doc(owner, 'users/active'))).data()!
    await assertSucceeds(setDoc(doc(owner, 'users/active'), deletingProfile(ownerProfile.createdAt, ['group-a'], 'deleting')))

    const blockedToken = 'f'.repeat(48)
    const blockedComment = sparkComment(blockedToken, String(expense.id), ownerActor)
    await assertFails(commitSparkComment(owner, `comment-${blockedToken}`, blockedToken, blockedComment, sparkCommentActivity(blockedToken, blockedComment, 'comment.added')))
    await assertFails(updateDoc(doc(owner, `groups/group-a/expenses/${expense.id}`), { total: { currency: 'USD', minorAmount: 1 } }))
    await assertFails(updateDoc(doc(owner, 'groups/group-a/members/friend'), { accountStatus: 'deleted' }))
    await assertFails(deleteDoc(doc(owner, 'users/friend/settings/notifications')))

    await assertSucceeds(setDoc(doc(owner, `groups/group-a/expenses/${expense.id}`), {
      ...(await getDoc(doc(owner, `groups/group-a/expenses/${expense.id}`))).data()!,
      createdBy: { id: 'active', displayName: 'Deleted user' }, updatedBy: { id: 'active', displayName: 'Deleted user' },
    }))
    const savedRevision = (await getDoc(doc(owner, `groups/group-a/expenses/${expense.id}/revisions/revision-a`))).data()!
    await assertSucceeds(setDoc(doc(owner, `groups/group-a/expenses/${expense.id}/revisions/revision-a`), {
      ...savedRevision,
      actor: { id: 'active', displayName: 'Deleted user' },
      expense: { ...(savedRevision.expense as Record<string, unknown>), createdBy: { id: 'active', displayName: 'Deleted user' }, updatedBy: { id: 'active', displayName: 'Deleted user' } },
    }))
    await assertSucceeds(setDoc(doc(owner, `groups/group-a/activity/activity-${'a'.repeat(48)}`), {
      ...(await getDoc(doc(owner, `groups/group-a/activity/activity-${'a'.repeat(48)}`))).data()!, actor: { id: 'active', displayName: 'Deleted user' },
    }))
    await assertSucceeds(setDoc(doc(owner, `groups/group-a/comments/comment-${'b'.repeat(48)}`), {
      ...(await getDoc(doc(owner, `groups/group-a/comments/comment-${'b'.repeat(48)}`))).data()!,
      author: { id: 'active', displayName: 'Deleted user' }, body: 'Comment removed with deleted account', attachmentRefs: [],
    }))
    await assertSucceeds(setDoc(doc(owner, `groups/group-a/settlements/${settlementId}`), {
      ...(await getDoc(doc(owner, `groups/group-a/settlements/${settlementId}`))).data()!,
      createdBy: { id: 'active', displayName: 'Deleted user' },
      void: { ...(settlement.void as Record<string, unknown>), actor: { id: 'active', displayName: 'Deleted user' } },
    }))
    await assertSucceeds(setDoc(doc(owner, `groups/group-a/recurringTemplates/${recurring.id}`), {
      ...(await getDoc(doc(owner, `groups/group-a/recurringTemplates/${recurring.id}`))).data()!,
      status: 'cancelled', revision: 2, updatedAt: serverTimestamp(), updatedBy: { id: 'active', displayName: 'Deleted user' },
      createdBy: { id: 'active', displayName: 'Deleted user' }, accountDeletionId: 'account-delete-12345678', accountDeletedUid: 'active',
    }))
    await assertSucceeds(setDoc(doc(owner, `groups/group-a/recurringTemplates/${cancelledRecurring.id}`), {
      ...(await getDoc(doc(owner, `groups/group-a/recurringTemplates/${cancelledRecurring.id}`))).data()!,
      createdBy: { id: 'active', displayName: 'Deleted user' },
    }))
    await assertSucceeds(setDoc(doc(owner, 'groups/group-a/settings/defaults'), {
      schemaVersion: 1, groupId: 'group-a', revision: 3, simplifyDebtsEnabled: true,
      lastCommandKind: settings.lastCommandKind, lastOperationId: settings.lastOperationId,
      lastRequestFingerprint: settings.lastRequestFingerprint, lastResourceToken: settings.lastResourceToken,
      updatedAt: serverTimestamp(), updatedBy: { id: 'active', displayName: 'Deleted user' },
      accountDeletionId: 'account-delete-12345678', accountDeletedUid: 'active',
    }))

    const continuity = writeBatch(owner)
    continuity.set(doc(owner, 'groups/group-a'), {
      ...(await getDoc(doc(owner, 'groups/group-a'))).data()!, memberIds: ['friend'], createdByUid: 'friend', updatedAt: serverTimestamp(),
      lastAccountDeletionId: 'account-delete-12345678', lastDeletedAccountUid: 'active',
    })
    continuity.set(doc(owner, 'groups/group-a/members/active'), {
      ...(await getDoc(doc(owner, 'groups/group-a/members/active'))).data()!, status: 'removed', role: 'member', canManage: false,
      displayName: 'Deleted user', initials: 'DU', avatarUrl: null, accountStatus: 'deleted',
      accountDeletionId: 'account-delete-12345678', accountDeletedAt: serverTimestamp(),
    })
    continuity.set(doc(owner, 'groups/group-a/members/friend'), {
      ...(await getDoc(doc(owner, 'groups/group-a/members/friend'))).data()!, role: 'owner', canManage: true,
      accountDeletionPromotionId: 'account-delete-12345678', accountDeletionPromotedAt: serverTimestamp(),
    })
    continuity.set(doc(owner, 'users/friend/groups/group-a'), {
      ...(await getDoc(doc(friend, 'users/friend/groups/group-a'))).data()!, contextLabel: 'Deleted user', updatedAt: serverTimestamp(),
      accountDeletionId: 'account-delete-12345678', accountDeletedUid: 'active',
    })
    await assertSucceeds(continuity.commit())

    await assertSucceeds(deleteDoc(doc(owner, 'users/active/groups/group-a')))
    await assertSucceeds(deleteDoc(doc(owner, 'users/active/settings/notifications')))
    await assertSucceeds(deleteDoc(doc(owner, `invitations/${invitationId}`)))
    const deleting = (await getDoc(doc(owner, 'users/active'))).data()!
    await assertSucceeds(setDoc(doc(owner, 'users/active'), deletingProfile(deleting.createdAt, ['group-a'], 'prepared', deleting.deletionRequestedAt)))

    const savedExpense = (await getDoc(doc(friend, `groups/group-a/expenses/${expense.id}`))).data()!
    expect(savedExpense.total).toEqual({ currency: 'USD', minorAmount: 1000 })
    expect(savedExpense.createdBy).toEqual({ id: 'active', displayName: 'Deleted user' })
    expect((await getDoc(doc(friend, 'groups/group-a/members/active'))).data()).toMatchObject({ status: 'removed', displayName: 'Deleted user', accountStatus: 'deleted' })
    expect((await getDoc(doc(friend, 'users/friend/groups/group-a'))).data()).toMatchObject({ contextLabel: 'Deleted user' })
    expect((await getDoc(doc(friend, `groups/group-a/recurringTemplates/${recurring.id}`))).data()).toMatchObject({ status: 'cancelled' })
    expect((await getDoc(doc(friend, `groups/group-a/recurringTemplates/${cancelledRecurring.id}`))).data()).toMatchObject({
      status: 'cancelled', revision: 1, createdBy: { id: 'active', displayName: 'Deleted user' },
    })
    expect((await getDoc(doc(friend, 'groups/group-a/settings/defaults'))).data()).not.toHaveProperty('defaultSplit')
    await assertFails(getDoc(doc(owner, 'groups/group-a')))
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

  emulatorIt('allows only built-in group cover paths during owner bootstrap', async () => {
    const owner = environment.authenticatedContext('cover-owner').firestore()
    await assertSucceeds(setDoc(doc(owner, 'users/cover-owner'), profile('Cover Owner', 'CO')))
    await assertSucceeds(commitGroupBundle(owner, 'group-covered', 'cover-owner', 'Cover Owner', 'CO', ['cover-owner'], 'group', '/covers/group-home.jpg'))
    expect((await getDoc(doc(owner, 'groups/group-covered'))).data()).toMatchObject({ coverImageUrl: '/covers/group-home.jpg' })
    await assertFails(commitGroupBundle(owner, 'group-remote-cover', 'cover-owner', 'Cover Owner', 'CO', ['cover-owner'], 'group', 'https://example.com/tracker.jpg'))
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

  emulatorIt('keeps a friendship targeted and capped at exactly two people', async () => {
    const owner = environment.authenticatedContext('friend-owner', { email: 'owner@example.com', email_verified: true }).firestore()
    const friend = environment.authenticatedContext('friend-member', { email: 'friend@example.com', email_verified: true }).firestore()
    const third = environment.authenticatedContext('friend-third', { email: 'third@example.com', email_verified: true }).firestore()
    await assertSucceeds(setDoc(doc(owner, 'users/friend-owner'), profile('Friend Owner', 'FO')))
    await assertSucceeds(setDoc(doc(friend, 'users/friend-member'), profile('Friend Member', 'FM')))
    await assertSucceeds(setDoc(doc(third, 'users/friend-third'), profile('Third Person', 'TP')))
    await assertSucceeds(commitGroupBundle(owner, 'friendship-shared', 'friend-owner', 'Friend Owner', 'FO', ['friend-owner'], 'friendship'))

    const invitationId = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
    const secondInvitationId = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'
    await assertFails(setDoc(doc(owner, 'invitations/ddddddddddddddddddddddddddddddddddddddddddd'), invitation('ddddddddddddddddddddddddddddddddddddddddddd', 'friendship-shared', 'friend-owner', 'Friend@Example.com')))
    await assertFails(setDoc(doc(owner, 'invitations/eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee'), invitation('eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee', 'friendship-shared', 'friend-owner', 'friend@example')))
    await assertSucceeds(setDoc(doc(owner, `invitations/${invitationId}`), invitation(invitationId, 'friendship-shared', 'friend-owner', 'friend@example.com')))
    await assertSucceeds(setDoc(doc(owner, `invitations/${secondInvitationId}`), invitation(secondInvitationId, 'friendship-shared', 'friend-owner', 'third@example.com')))
    await assertSucceeds(acceptInvitation(friend, invitationId, 'friendship-shared', 'friend-member', 'Friend Member', 'FM', ['friend-owner', 'friend-member']))
    await assertSucceeds(commitSparkProfileUpdate(owner, 'friend-owner', 'friendship-shared', 'Renamed Owner', 'RO', 'friend-member'))
    await expect(getDoc(doc(friend, 'users/friend-member/groups/friendship-shared'))).resolves.toMatchObject({
      data: expect.any(Function),
    })
    expect((await getDoc(doc(friend, 'users/friend-member/groups/friendship-shared'))).data()).toMatchObject({ contextLabel: 'Renamed Owner' })

    const fullInvitationId = 'ccccccccccccccccccccccccccccccccccccccccccc'
    await assertFails(setDoc(doc(owner, `invitations/${fullInvitationId}`), invitation(fullInvitationId, 'friendship-shared', 'friend-owner', 'another@example.com')))
    await assertFails(acceptInvitation(third, secondInvitationId, 'friendship-shared', 'friend-third', 'Third Person', 'TP', ['friend-owner', 'friend-member', 'friend-third']))
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

    const reimbursement = sparkExpense('5', { reimbursement: true })
    await assertSucceeds(setDoc(doc(active, `groups/group-a/expenses/${reimbursement.id}`), reimbursement))
    const invalidReimbursement = sparkExpense('6', { reimbursement: false })
    await assertFails(setDoc(doc(active, `groups/group-a/expenses/${invalidReimbursement.id}`), invalidReimbursement))

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
      splitMethod: { type: 'exact', allocations: [
        { participantId: 'active', money: { currency: 'USD', minorAmount: 400 } },
        { participantId: 'removed', money: { currency: 'USD', minorAmount: 600 } },
      ] },
    })
    await environment.withSecurityRulesDisabled(async (context) => {
      await updateDoc(doc(context.firestore(), 'groups/group-a'), { memberIds: ['active', 'friend', 'manager', 'removed'] })
    })
    await assertFails(setDoc(doc(active, `groups/group-a/expenses/${removedParticipant.id}`), removedParticipant))

    const inflatedInvolvedMembers = sparkExpense('4', { involvedMemberIds: ['active', 'friend', 'manager'] })
    await assertFails(setDoc(doc(active, `groups/group-a/expenses/${inflatedInvolvedMembers.id}`), inflatedInvolvedMembers))
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
      headRevision: 2, headDeleted: false, current: editedExpense,
    }
    const editVersion = sparkExpenseVersion(editedExpense, 'edit-operation-f', 'updated', { id: 'active', displayName: 'Active Member' })
    await assertSucceeds(commitSparkExpenseMutation(active, expense.id as string, editToken, editHead, editVersion))
    const savedEditVersion = (await getDoc(doc(active, `groups/group-a/expenses/${expense.id}/revisions/${editToken}`))).data()!
    await assertSucceeds(setDoc(doc(active, `groups/group-a/activity/activity-${editToken}`), sparkExpenseActivity(editedExpense, 'expense.updated', savedEditVersion.createdAt)))
    expect((await getDoc(reference)).data()).toMatchObject({ description: 'Dinner', revision: 1, headRevision: 2, headDeleted: false, current: { description: 'Audited change', revision: 2 } })
    expect((await getDoc(doc(active, `groups/group-a/expenses/${expense.id}/revisions/${editToken}`))).data()?.expense).toMatchObject({ description: 'Audited change', revision: 2 })

    const beforeFriendEdit = (await getDoc(doc(friend, `groups/group-a/expenses/${expense.id}`))).data()!
    const currentEditedExpense = (await getDoc(doc(friend, `groups/group-a/expenses/${expense.id}/revisions/${editToken}`))).data()?.expense as Record<string, unknown>
    const friendEditToken = 'd'.repeat(48)
    const friendEditedExpense = {
      ...currentEditedExpense, description: 'Friend corrected dinner', lastOperationId: 'friend-edit-d', lastRequestFingerprint: 'a'.repeat(64), lastResourceToken: friendEditToken,
      updatedAt: serverTimestamp(), updatedBy: { id: 'friend', displayName: 'Friend' }, revision: 3,
    }
    await assertSucceeds(commitSparkExpenseMutation(friend, expense.id as string, friendEditToken, {
      ...beforeFriendEdit, lastOperationId: 'friend-edit-d', lastRequestFingerprint: 'a'.repeat(64), lastResourceToken: friendEditToken,
      headRevision: 3, headDeleted: false, current: friendEditedExpense,
    }, sparkExpenseVersion(friendEditedExpense, 'friend-edit-d', 'updated', { id: 'friend', displayName: 'Friend' })))
    const savedFriendEditVersion = (await getDoc(doc(friend, `groups/group-a/expenses/${expense.id}/revisions/${friendEditToken}`))).data()!
    await assertSucceeds(setDoc(doc(friend, `groups/group-a/activity/activity-${friendEditToken}`), sparkExpenseActivity(friendEditedExpense, 'expense.updated', savedFriendEditVersion.createdAt)))
    expect((await getDoc(reference)).data()).toMatchObject({
      createdBy: { id: 'active', displayName: 'Active Member' },
      headRevision: 3,
      current: { description: 'Friend corrected dinner', updatedBy: { id: 'friend', displayName: 'Friend' }, revision: 3 },
    })

    const beforeDelete = (await getDoc(doc(friend, `groups/group-a/expenses/${expense.id}`))).data()!
    const beforeDeleteExpense = (await getDoc(doc(friend, `groups/group-a/expenses/${expense.id}/revisions/${friendEditToken}`))).data()?.expense as Record<string, unknown>
    const deleteToken = '1'.repeat(48)
    const deletedExpense = {
      ...beforeDeleteExpense, lastOperationId: 'delete-operation-1', lastRequestFingerprint: 'b'.repeat(64), lastResourceToken: deleteToken,
      updatedAt: serverTimestamp(), updatedBy: { id: 'friend', displayName: 'Friend' }, revision: 4, deletedAt: serverTimestamp(),
    }
    await assertSucceeds(commitSparkExpenseMutation(friend, expense.id as string, deleteToken, {
      ...beforeDelete, lastOperationId: 'delete-operation-1', lastRequestFingerprint: 'b'.repeat(64), lastResourceToken: deleteToken,
      headRevision: 4, headDeleted: true, current: deletedExpense,
    }, sparkExpenseVersion(deletedExpense, 'delete-operation-1', 'deleted', { id: 'friend', displayName: 'Friend' })))
    const savedDeleteVersion = (await getDoc(doc(friend, `groups/group-a/expenses/${expense.id}/revisions/${deleteToken}`))).data()!
    await assertSucceeds(setDoc(doc(friend, `groups/group-a/activity/activity-${deleteToken}`), sparkExpenseActivity(deletedExpense, 'expense.deleted', savedDeleteVersion.createdAt)))
    expect((await getDoc(reference)).data()).toMatchObject({ description: 'Dinner', revision: 1, headRevision: 4, headDeleted: true, current: { description: 'Friend corrected dinner', revision: 4 } })
    expect((await getDoc(doc(friend, `groups/group-a/expenses/${expense.id}/revisions/${deleteToken}`))).data()?.expense).toMatchObject({ description: 'Friend corrected dinner', revision: 4 })

    const beforeRestore = (await getDoc(doc(active, `groups/group-a/expenses/${expense.id}`))).data()!
    const deletedSnapshot = savedDeleteVersion.expense as Record<string, unknown>
    const { deletedAt: _deletedAt, ...restorableSnapshot } = deletedSnapshot
    const restoreToken = '2'.repeat(48)
    const restoredExpense = {
      ...restorableSnapshot, lastOperationId: 'restore-operation-2', lastRequestFingerprint: 'c'.repeat(64), lastResourceToken: restoreToken,
      updatedAt: serverTimestamp(), updatedBy: { id: 'active', displayName: 'Active Member' }, revision: 5,
    }
    await assertSucceeds(commitSparkExpenseMutation(active, expense.id as string, restoreToken, {
      ...beforeRestore, lastOperationId: 'restore-operation-2', lastRequestFingerprint: 'c'.repeat(64), lastResourceToken: restoreToken,
      headRevision: 5, headDeleted: false, current: restoredExpense,
    }, sparkExpenseVersion(restoredExpense, 'restore-operation-2', 'restored', { id: 'active', displayName: 'Active Member' })))
    const savedRestoreVersion = (await getDoc(doc(active, `groups/group-a/expenses/${expense.id}/revisions/${restoreToken}`))).data()!
    await assertSucceeds(setDoc(doc(active, `groups/group-a/activity/activity-${restoreToken}`), sparkExpenseActivity(restoredExpense, 'expense.restored', savedRestoreVersion.createdAt)))
    expect((await getDoc(reference)).data()).toMatchObject({ headRevision: 5, headDeleted: false, current: { description: 'Friend corrected dinner', revision: 5 } })
    expect((await getDoc(reference)).data()?.current).not.toHaveProperty('deletedAt')

    await assertFails(deleteDoc(reference))
    await assertFails(updateDoc(reference, { description: 'Edit after delete' }))
    await assertFails(setDoc(doc(active, 'groups/group-a/activity/activity-ffffffffffffffffffffffffffffffffffffffffffffffff'), { kind: 'expense.created' }))
    await assertFails(setDoc(doc(active, `groups/group-a/expenses/${expense.id}/revisions/forged-revision`), { action: 'updated' }))
  })

  emulatorIt('binds recurring template creation to one exact active-member source expense', async () => {
    const active = environment.authenticatedContext('active').firestore()
    const outsider = environment.authenticatedContext('outsider').firestore()
    const source = sparkRecurringSource('2')
    const template = sparkRecurringTemplate(source, '2026-10-01')

    await assertFails(setDoc(doc(active, `groups/group-a/recurringTemplates/${template.id}`), template))
    await assertFails(commitSparkRecurringCreation(outsider, source, template))
    await assertFails(commitSparkRecurringCreation(active, source, {
      ...template,
      recurrence: { frequency: 'daily', anchor: { month: 9, day: 1 }, timeZone: 'UTC' },
    }))
    await assertFails(commitSparkRecurringCreation(active, source, {
      ...template,
      recurrence: { frequency: 'monthly', anchor: { month: 13, day: 1 }, timeZone: 'UTC' },
    }))
    await assertFails(commitSparkRecurringCreation(active, source, {
      ...template,
      createdBy: { id: 'friend', displayName: 'Friend' },
      updatedBy: { id: 'friend', displayName: 'Friend' },
    }))
    await assertFails(commitSparkRecurringCreation(active, {
      ...source,
      recurringTemplateId: `recurring-${'3'.repeat(48)}`,
    }, template))
    await assertSucceeds(commitSparkRecurringCreation(active, source, template))
  })

  emulatorIt('preserves the reimbursement marker through recurring creation and materialization', async () => {
    const active = environment.authenticatedContext('active').firestore()
    const source: Record<string, unknown> = { ...sparkRecurringSource('7'), reimbursement: true }
    const template: Record<string, unknown> = { ...sparkRecurringTemplate(source, '2026-10-01'), reimbursement: true }

    await assertSucceeds(commitSparkRecurringCreation(active, source, template))
    const savedTemplate = (await getDoc(doc(active, `groups/group-a/recurringTemplates/${template.id}`))).data()!
    expect(savedTemplate).toMatchObject({ reimbursement: true })
    const materialized = sparkRecurringMaterialization(savedTemplate, '8', '2026-10-01', '2026-11-01')
    materialized.occurrence.reimbursement = true

    await assertSucceeds(commitSparkRecurringMaterialization(active, materialized))
    expect((await getDoc(doc(active, `groups/group-a/expenses/${materialized.occurrence.id}`))).data()).toMatchObject({ reimbursement: true })
  })

  emulatorIt('materializes only the active current date with deterministic identity, then cancels by exact revision', async () => {
    const active = environment.authenticatedContext('active').firestore()
    const friend = environment.authenticatedContext('friend').firestore()
    const source = sparkRecurringSource('3')
    const template = sparkRecurringTemplate(source, '2026-10-01')
    await assertSucceeds(commitSparkRecurringCreation(active, source, template))
    const savedTemplate = (await getDoc(doc(active, `groups/group-a/recurringTemplates/${template.id}`))).data()!

    const skipped = sparkRecurringMaterialization(savedTemplate, '4', '2026-11-01', '2026-12-01')
    await assertFails(commitSparkRecurringMaterialization(active, skipped))
    const backwards = sparkRecurringMaterialization(savedTemplate, '4', '2026-10-01', '2026-09-01')
    await assertFails(commitSparkRecurringMaterialization(active, backwards))
    const forgedActor = sparkRecurringMaterialization(savedTemplate, '4', '2026-10-01', '2026-11-01', { id: 'friend', displayName: 'Friend' })
    await assertFails(commitSparkRecurringMaterialization(active, forgedActor))
    const duplicateIdentity = sparkRecurringMaterialization(savedTemplate, '3', '2026-10-01', '2026-11-01')
    await assertFails(commitSparkRecurringMaterialization(active, duplicateIdentity))

    const materialized = sparkRecurringMaterialization(savedTemplate, '4', '2026-10-01', '2026-11-01')
    await assertSucceeds(commitSparkRecurringMaterialization(active, materialized))
    await assertFails(deleteDoc(doc(active, `groups/group-a/recurringTemplates/${template.id}`)))

    const advancedTemplate = (await getDoc(doc(active, `groups/group-a/recurringTemplates/${template.id}`))).data()!
    await assertFails(setDoc(doc(friend, `groups/group-a/recurringTemplates/${template.id}`), sparkRecurringCancellation(advancedTemplate, '5', 3, { id: 'friend', displayName: 'Friend' })))
    await assertFails(setDoc(doc(active, `groups/group-a/recurringTemplates/${template.id}`), sparkRecurringCancellation(advancedTemplate, '5', 1)))
    await assertSucceeds(setDoc(doc(friend, `groups/group-a/recurringTemplates/${template.id}`), sparkRecurringCancellation(advancedTemplate, '5', 2, { id: 'friend', displayName: 'Friend' })))

    const cancelled = (await getDoc(doc(active, `groups/group-a/recurringTemplates/${template.id}`))).data()!
    await assertFails(commitSparkRecurringMaterialization(active, sparkRecurringMaterialization(cancelled, '6', '2026-11-01', '2026-12-01')))
  })

  emulatorIt('revalidates stored template participants before every materialization', async () => {
    const active = environment.authenticatedContext('active').firestore()
    const source = sparkRecurringSource('1')
    const template = sparkRecurringTemplate(source, '2026-10-01')
    await assertSucceeds(commitSparkRecurringCreation(active, source, template))
    const createdTemplate = (await getDoc(doc(active, `groups/group-a/recurringTemplates/${template.id}`))).data()!

    const activeParticipants = sparkRecurringMaterialization(createdTemplate, '2', '2026-10-01', '2026-11-01')
    await assertSucceeds(commitSparkRecurringMaterialization(active, activeParticipants))
    const advancedTemplate = (await getDoc(doc(active, `groups/group-a/recurringTemplates/${template.id}`))).data()!

    await environment.withSecurityRulesDisabled(async (context) => {
      await updateDoc(doc(context.firestore(), 'groups/group-a/members/friend'), { status: 'removed' })
    })
    const removedParticipant = sparkRecurringMaterialization(advancedTemplate, '3', '2026-11-01', '2026-12-01')
    await assertFails(commitSparkRecurringMaterialization(active, removedParticipant))
  })

  emulatorIt('rejects an ordinary member schedule jump while allowing valid collaborative materialization and future edits', async () => {
    const creator = environment.authenticatedContext('friend').firestore()
    const materializer = environment.authenticatedContext('materializer').firestore()
    const manager = environment.authenticatedContext('manager').firestore()
    const creatorActor = { id: 'friend', displayName: 'Friend' }
    const materializerActor = { id: 'materializer', displayName: 'Materializer' }
    const managerActor = { id: 'manager', displayName: 'Series Manager' }
    const source = sparkRecurringSource('4', creatorActor)
    const template = sparkRecurringTemplate(source, '2026-10-01')
    await assertSucceeds(commitSparkRecurringCreation(creator, source, template))
    const savedTemplate = (await getDoc(doc(creator, `groups/group-a/recurringTemplates/${template.id}`))).data()!

    const hostileJump = sparkRecurringMaterialization(savedTemplate, '5', '2026-10-01', '9999-12-31', materializerActor)
    await assertFails(commitSparkRecurringMaterialization(materializer, hostileJump))

    const managed = sparkRecurringMaterialization(savedTemplate, '6', '2026-10-01', '2026-11-01', managerActor)
    await assertSucceeds(commitSparkRecurringMaterialization(manager, managed))
    expect((await getDoc(doc(manager, `groups/group-a/expenses/${managed.occurrence.id}`))).data()).toMatchObject({
      createdBy: creatorActor,
      updatedBy: managerActor,
    })

    const advanced = (await getDoc(doc(creator, `groups/group-a/recurringTemplates/${template.id}`))).data()!
    const memberMaterialization = sparkRecurringMaterialization(advanced, '7', '2026-11-01', '2026-12-01', materializerActor)
    await assertSucceeds(commitSparkRecurringMaterialization(materializer, memberMaterialization))
    expect((await getDoc(doc(materializer, `groups/group-a/expenses/${memberMaterialization.occurrence.id}`))).data()).toMatchObject({
      createdBy: creatorActor,
      updatedBy: materializerActor,
    })

    const memberFrontier = (await getDoc(doc(materializer, `groups/group-a/expenses/${memberMaterialization.occurrence.id}`))).data()!
    const memberTemplate = (await getDoc(doc(materializer, `groups/group-a/recurringTemplates/${template.id}`))).data()!
    const memberFuture = sparkFutureRecurringEdit(memberFrontier, memberTemplate, '8', materializerActor)
    await assertSucceeds(commitSparkFutureRecurringEdit(materializer, memberFuture, memberFuture.template))
    const futureTemplate = (await getDoc(doc(creator, `groups/group-a/recurringTemplates/${template.id}`))).data()!
    await assertSucceeds(setDoc(
      doc(creator, `groups/group-a/recurringTemplates/${template.id}`),
      sparkRecurringCancellation(futureTemplate, 'b', Number(futureTemplate.revision), creatorActor),
    ))
  })

  emulatorIt('authorizes cancellation independently for any active member at the current revision', async () => {
    const creator = environment.authenticatedContext('active').firestore()
    const manager = environment.authenticatedContext('manager').firestore()
    const nonManager = environment.authenticatedContext('friend').firestore()
    const creatorActor = { id: 'active', displayName: 'Active Member' }
    const managerActor = { id: 'manager', displayName: 'Series Manager' }
    const nonManagerActor = { id: 'friend', displayName: 'Friend' }

    const creatorSource = sparkRecurringSource('a', creatorActor)
    const creatorTemplate = sparkRecurringTemplate(creatorSource, '2026-10-01')
    await assertSucceeds(commitSparkRecurringCreation(creator, creatorSource, creatorTemplate))
    const savedCreatorTemplate = (await getDoc(doc(creator, `groups/group-a/recurringTemplates/${creatorTemplate.id}`))).data()!
    await environment.withSecurityRulesDisabled(async (context) => {
      await updateDoc(doc(context.firestore(), 'groups/group-a/members/active'), { canManage: false })
    })
    await assertSucceeds(setDoc(
      doc(creator, `groups/group-a/recurringTemplates/${creatorTemplate.id}`),
      sparkRecurringCancellation(savedCreatorTemplate, '1', 1, creatorActor),
    ))

    const managerSource = sparkRecurringSource('b', creatorActor)
    const managerTemplate = sparkRecurringTemplate(managerSource, '2026-10-01')
    await assertSucceeds(commitSparkRecurringCreation(creator, managerSource, managerTemplate))
    const savedManagerTemplate = (await getDoc(doc(creator, `groups/group-a/recurringTemplates/${managerTemplate.id}`))).data()!
    await assertSucceeds(setDoc(
      doc(manager, `groups/group-a/recurringTemplates/${managerTemplate.id}`),
      sparkRecurringCancellation(savedManagerTemplate, '2', 1, managerActor),
    ))

    const deniedSource = sparkRecurringSource('c', creatorActor)
    const deniedTemplate = sparkRecurringTemplate(deniedSource, '2026-10-01')
    await assertSucceeds(commitSparkRecurringCreation(creator, deniedSource, deniedTemplate))
    const savedDeniedTemplate = (await getDoc(doc(creator, `groups/group-a/recurringTemplates/${deniedTemplate.id}`))).data()!
    await assertSucceeds(setDoc(
      doc(nonManager, `groups/group-a/recurringTemplates/${deniedTemplate.id}`),
      sparkRecurringCancellation(savedDeniedTemplate, '3', 1, nonManagerActor),
    ))
  })

  emulatorIt('audits an occurrence date edit while preserving its immutable materialization provenance', async () => {
    const active = environment.authenticatedContext('active').firestore()
    const source = sparkRecurringSource('d')
    const template = sparkRecurringTemplate(source, '2026-10-01')
    await assertSucceeds(commitSparkRecurringCreation(active, source, template))
    const createdTemplate = (await getDoc(doc(active, `groups/group-a/recurringTemplates/${template.id}`))).data()!
    const materialized = sparkRecurringMaterialization(createdTemplate, 'e', '2026-10-01', '2026-11-01')
    await assertSucceeds(commitSparkRecurringMaterialization(active, materialized))
    const occurrenceId = String(materialized.occurrence.id)
    const occurrence = (await getDoc(doc(active, `groups/group-a/expenses/${occurrenceId}`))).data()!

    const forged = sparkOccurrenceEdit(occurrence, 'f', '2026-10-02', `recurring-${'1'.repeat(48)}`)
    await assertFails(commitSparkExpenseMutation(active, occurrenceId, String(forged.expense.lastResourceToken), forged.head, forged.revision))

    const valid = sparkOccurrenceEdit(occurrence, '6', '2026-10-02', String(template.id))
    await assertSucceeds(commitSparkExpenseMutation(active, occurrenceId, String(valid.expense.lastResourceToken), valid.head, valid.revision))
    expect((await getDoc(doc(active, `groups/group-a/expenses/${occurrenceId}`))).data()).toMatchObject({
      id: occurrenceId,
      date: '2026-10-01',
      current: { id: occurrenceId, date: '2026-10-02', recurringTemplateId: template.id, occurrenceEditScope: 'occurrence' },
    })
  })

  emulatorIt('updates future recurrence only with the linked audited frontier revision', async () => {
    const active = environment.authenticatedContext('active').firestore()
    const source: Record<string, unknown> = { ...sparkRecurringSource('7'), reimbursement: true }
    const template: Record<string, unknown> = { ...sparkRecurringTemplate(source, '2026-10-01'), reimbursement: true }
    await assertSucceeds(commitSparkRecurringCreation(active, source, template))
    const savedSource = (await getDoc(doc(active, `groups/group-a/expenses/${source.id}`))).data()!
    const createdTemplate = (await getDoc(doc(active, `groups/group-a/recurringTemplates/${template.id}`))).data()!

    const future = sparkFutureRecurringEdit(savedSource, createdTemplate, '8')
    await assertFails(commitSparkFutureRecurringEdit(active, future, {
      ...future.template,
      description: 'Template diverged from its immutable revision',
    }))
    await assertFails(commitSparkFutureRecurringEdit(active, {
      ...future,
      expense: { ...future.expense, occurrenceEditScope: 'occurrence' },
      head: { ...future.head, current: { ...future.expense, occurrenceEditScope: 'occurrence' } },
      revision: { ...future.revision, expense: { ...future.expense, occurrenceEditScope: 'occurrence' } },
    }, future.template))
    await assertFails(commitSparkFutureRecurringEdit(active, future, { ...future.template, unexpected: true }))
    const broadExpense = { ...future.expense, unexpected: true }
    await assertFails(commitSparkFutureRecurringEdit(active, {
      ...future,
      expense: broadExpense,
      head: { ...future.head, current: broadExpense },
      revision: { ...future.revision, expense: broadExpense },
    }, future.template))

    const malformedDescription = patchSparkFutureRecurringEdit(future, { description: '' })
    await assertFails(commitSparkFutureRecurringEdit(active, malformedDescription, malformedDescription.template))
    const malformedCategory = patchSparkFutureRecurringEdit(future, { category: '' })
    await assertFails(commitSparkFutureRecurringEdit(active, malformedCategory, malformedCategory.template))
    const malformedDate = patchSparkFutureRecurringEdit(
      future,
      { date: '2026-02-30' },
      { nextDate: '2026-03-14' },
    )
    await assertFails(commitSparkFutureRecurringEdit(active, malformedDate, malformedDate.template))
    const nonLeapDate = patchSparkFutureRecurringEdit(
      future,
      {
        date: '2026-02-29',
        recurrence: { frequency: 'yearly', anchor: { month: 2, day: 29 }, timeZone: 'UTC' },
      },
      { nextDate: '2027-02-28' },
    )
    await assertFails(commitSparkFutureRecurringEdit(active, nonLeapDate, nonLeapDate.template))
    const mismatchedAnchor = patchSparkFutureRecurringEdit(future, {
      recurrence: { frequency: 'fortnightly', anchor: { month: 9, day: 14 }, timeZone: 'UTC' },
    })
    await assertFails(commitSparkFutureRecurringEdit(active, mismatchedAnchor, mismatchedAnchor.template))
    const malformedNextDate = patchSparkFutureRecurringEdit(future, {}, { nextDate: '2026-09-31' })
    await assertFails(commitSparkFutureRecurringEdit(active, malformedNextDate, malformedNextDate.template))
    const ordinaryExpense = { ...future.expense }
    const ordinaryTemplate = { ...future.template }
    delete ordinaryExpense.reimbursement
    delete ordinaryTemplate.reimbursement
    const ordinaryFuture = {
      ...future,
      expense: ordinaryExpense,
      head: { ...future.head, current: ordinaryExpense },
      revision: { ...future.revision, expense: ordinaryExpense },
    }
    await assertSucceeds(commitSparkFutureRecurringEdit(active, ordinaryFuture, ordinaryTemplate))

    const savedHead = (await getDoc(doc(active, `groups/group-a/expenses/${source.id}`))).data()!
    const savedTemplate = (await getDoc(doc(active, `groups/group-a/recurringTemplates/${template.id}`))).data()!
    expect(savedHead.current).not.toHaveProperty('reimbursement')
    expect(savedTemplate).not.toHaveProperty('reimbursement')
    await environment.withSecurityRulesDisabled(async (context) => {
      await updateDoc(doc(context.firestore(), `groups/group-a/recurringTemplates/${template.id}`), {
        lastOccurrenceId: `occ_${template.id}_2026-09-15`, lastOccurrenceDate: '2026-09-15',
      })
    })
    const staleFrontier = sparkFutureRecurringEdit(savedHead, savedTemplate, '9')
    await assertFails(commitSparkFutureRecurringEdit(active, staleFrontier, staleFrontier.template))
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

  emulatorIt('applies a manager-only currency conversion with one server cutoff, immutable activity, and atomic balance invalidation', async () => {
    const manager = environment.authenticatedContext('active').firestore()
    const friend = environment.authenticatedContext('friend').firestore()
    const defaultSplit = { type: 'percentage', participantIds: ['active', 'friend'], percentages: { active: 60, friend: 40 } }
    await environment.withSecurityRulesDisabled(async (context) => {
      await setDoc(doc(context.firestore(), 'groups/group-a/settings/defaults'), {
        schemaVersion: 1, groupId: 'group-a', revision: 1, defaultSplit, simplifyDebtsEnabled: true, updatedAt: Timestamp.fromMillis(0),
      })
    })
    const operationId = 'currency-conversion-eur'
    const token = '9'.repeat(48)
    const rate = {
      baseCurrency: 'USD', quoteCurrency: 'EUR', numerator: 86_237, denominator: 100_000,
      authority: 'European Central Bank via Frankfurter', effectiveDate: '2026-08-29', observedAt: '2026-09-01T11:59:00.000Z',
    }
    const conversion = { schemaVersion: 1, groupId: 'group-a', operationId, targetCurrency: 'EUR', convertedAt: serverTimestamp(), sourceCurrencies: ['USD'], rates: [rate] }
    const pointer = { schemaVersion: 1, operationId, targetCurrency: 'EUR', convertedAt: serverTimestamp() }
    const settings = sparkSettings(2, 'group.currency-conversion', operationId, token, { id: 'active', displayName: 'Active Member' }, { defaultSplit, currencyConversion: pointer })
    const activity = sparkSettingsActivity(token, operationId, { id: 'active', displayName: 'Active Member' }, 'Currencies converted to EUR')
    const balance = { groupId: 'group-a', balanceRevision: 1, simplifyDebtsEnabled: true, pairwise: [], simplified: [] }

    await assertFails(commitSparkSettings(manager, token, settings, activity))
    await assertFails(commitSparkSettings(friend, token, { ...settings, updatedBy: { id: 'friend', displayName: 'Friend' } }, { ...activity, actor: { id: 'friend', displayName: 'Friend' } }, balance, conversion))
    await assertFails(commitSparkSettings(manager, token, settings, activity, balance, { ...conversion, convertedAt: Timestamp.fromMillis(0) }))
    await assertFails(commitSparkSettings(manager, token, settings, activity, balance, { ...conversion, rates: [{ ...rate, quoteCurrency: 'GBP' }] }))
    await assertFails(commitSparkSettings(manager, token, settings, activity, balance, { ...conversion, admin: true }))
    await assertFails(commitSparkSettings(manager, token, {
      ...settings, defaultSplit: { type: 'equal', participantIds: ['active'] },
    }, activity, balance, conversion))

    await assertSucceeds(commitSparkSettings(manager, token, settings, activity, balance, conversion))
    const saved = (await getDoc(doc(manager, 'groups/group-a/settings/defaults'))).data()!
    expect(saved).toMatchObject({ revision: 2, lastCommandKind: 'group.currency-conversion', currencyConversion: { operationId, targetCurrency: 'EUR' } })
    expect(saved.currencyConversion.convertedAt).toBeInstanceOf(Timestamp)
    expect((await getDoc(doc(manager, `groups/group-a/currencyConversions/conversion-${token}`))).data()).toMatchObject({ operationId, targetCurrency: 'EUR', sourceCurrencies: ['USD'] })
    expect((await getDoc(doc(manager, `groups/group-a/currencyConversions/conversion-${token}/rates/USD`))).data()).toMatchObject(rate)
  })
})

function profile(displayName: string, initials: string): Record<string, unknown> {
  return { displayName, initials, avatarUrl: null, createdAt: serverTimestamp(), updatedAt: serverTimestamp() }
}

function deletingProfile(createdAt: unknown, deletionGroupIds: readonly string[], deletionStatus: 'deleting' | 'prepared', deletionRequestedAt: unknown = serverTimestamp()): Record<string, unknown> {
  return {
    displayName: 'Deleted user', initials: 'DU', avatarUrl: null, createdAt, updatedAt: serverTimestamp(),
    deletionRequestedAt, deletionStatus, deletionId: 'account-delete-12345678', deletionGroupIds,
  }
}

function commitSparkProfileUpdate(source: unknown, uid: string, groupId: string, displayName: string, initials: string, counterpartUid?: string): Promise<void> {
  const db = source as Firestore
  const batch = writeBatch(db)
  batch.update(doc(db, `users/${uid}`), {
    displayName, initials, avatarUrl: null, updatedAt: serverTimestamp(),
    lastCommandKind: 'profile.update', lastOperationId: 'profile-rename',
    lastRequestFingerprint: 'e'.repeat(64), lastResourceToken: 'e'.repeat(48),
  })
  batch.update(doc(db, `groups/${groupId}/members/${uid}`), { displayName, initials, avatarUrl: null })
  if (counterpartUid) batch.update(doc(db, `users/${counterpartUid}/groups/${groupId}`), { contextLabel: displayName, updatedAt: serverTimestamp() })
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

function group(groupId: string, ownerUid: string, memberIds: readonly string[], kind: 'group' | 'friendship' = 'group', coverImageUrl?: string): Record<string, unknown> {
  return { id: groupId, kind, name: 'Shared group', currency: 'USD', ...(coverImageUrl ? { coverImageUrl } : {}), memberIds, createdByUid: ownerUid, createdAt: serverTimestamp(), updatedAt: serverTimestamp() }
}

function commitGroupBundle(source: unknown, groupId: string, ownerUid: string, displayName: string, initials: string, memberIds: readonly string[] = [ownerUid], kind: 'group' | 'friendship' = 'group', coverImageUrl?: string): Promise<void> {
  const db = source as Firestore
  const batch = writeBatch(db)
  batch.set(doc(db, `groups/${groupId}`), group(groupId, ownerUid, memberIds, kind, coverImageUrl))
  batch.set(doc(db, `groups/${groupId}/members/${ownerUid}`), { status: 'active', role: 'owner', canManage: true, displayName, initials, avatarUrl: null, joinedAt: serverTimestamp() })
  batch.set(doc(db, `groups/${groupId}/settings/defaults`), { schemaVersion: 1, groupId, revision: 1, simplifyDebtsEnabled: true, updatedAt: serverTimestamp() })
  batch.set(doc(db, `groups/${groupId}/balance/current`), { groupId, balanceRevision: 0, simplifyDebtsEnabled: true, pairwise: [], simplified: [] })
  batch.set(doc(db, `users/${ownerUid}/groups/${groupId}`), { groupId, status: 'active', contextLabel: 'Shared group', joinedAt: serverTimestamp(), updatedAt: serverTimestamp() })
  return batch.commit()
}

function invitation(invitationId: string, groupId: string, creatorUid: string, targetEmail?: string): Record<string, unknown> {
  return {
    schemaVersion: 1, invitationId, tokenHash: invitationId, groupId, groupKind: groupId === 'friendship-shared' ? 'friendship' : 'group', groupName: 'Shared group', status: 'active', createdByUid: creatorUid,
    createdByName: creatorUid === 'friend-owner' ? 'Friend Owner' : 'New Owner',
    createdAt: serverTimestamp(), updatedAt: serverTimestamp(), expiresAt: Timestamp.fromMillis(Date.now() + 7 * 24 * 60 * 60 * 1000),
    ...(targetEmail ? { targetEmail } : {}),
  }
}

function acceptInvitation(source: unknown, invitationId: string, groupId: string, uid: string, displayName: string, initials: string, memberIds: readonly string[]): Promise<void> {
  const db = source as Firestore
  const batch = writeBatch(db)
  batch.update(doc(db, `invitations/${invitationId}`), { status: 'used', usedByUid: uid, usedAt: serverTimestamp(), updatedAt: serverTimestamp() })
  batch.update(doc(db, `groups/${groupId}`), { memberIds, updatedAt: serverTimestamp() })
  batch.set(doc(db, `groups/${groupId}/members/${uid}`), { status: 'active', role: 'member', canManage: false, displayName, initials, avatarUrl: null, invitationId, joinedAt: serverTimestamp() })
  batch.set(doc(db, `users/${uid}/groups/${groupId}`), {
    groupId, status: 'active', invitationId,
    contextLabel: groupId === 'friendship-shared' ? 'Friend Owner' : 'Shared group',
    joinedAt: serverTimestamp(), updatedAt: serverTimestamp(),
  })
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

function sparkExpenseVersion(expense: Record<string, unknown>, operationId: string, action: 'updated' | 'deleted' | 'restored', actor: Record<string, unknown>): Record<string, unknown> {
  return {
    groupId: 'group-a', expenseId: expense.id, revision: expense.revision,
    operationId, action, actor, createdAt: serverTimestamp(), expense,
  }
}

function sparkExpenseActivity(expense: Record<string, unknown>, kind: 'expense.created' | 'expense.updated' | 'expense.deleted' | 'expense.restored', createdAt: unknown): Record<string, unknown> {
  const actor = kind === 'expense.created' && !expense.recurringTemplateId ? expense.createdBy : expense.updatedBy
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

function sparkOccurrenceEdit(
  source: Record<string, unknown>, token: string, date: string, recurringTemplateId: string,
): { expense: Record<string, unknown>; head: Record<string, unknown>; revision: Record<string, unknown> } {
  const actor = { id: 'active', displayName: 'Active Member' }
  const resourceToken = token.repeat(48)
  const expense: Record<string, unknown> = {
    ...source,
    date,
    recurringTemplateId,
    occurrenceEditScope: 'occurrence',
    lastOperationId: `occurrence-edit-${token}`,
    lastRequestFingerprint: token.repeat(64),
    lastResourceToken: resourceToken,
    updatedAt: serverTimestamp(),
    updatedBy: actor,
    revision: Number(source.revision) + 1,
  }
  delete expense.recurrence
  const head = {
    ...source,
    lastOperationId: expense.lastOperationId,
    lastRequestFingerprint: expense.lastRequestFingerprint,
    lastResourceToken: resourceToken,
    headRevision: expense.revision,
    headDeleted: false,
    current: expense,
  }
  return {
    expense,
    head,
    revision: sparkExpenseVersion(expense, String(expense.lastOperationId), 'updated', actor),
  }
}

function sparkRecurringSource(token: string, actor: Record<string, unknown> = { id: 'active', displayName: 'Active Member' }): Record<string, unknown> {
  const resourceToken = token.repeat(48)
  return sparkExpense(token, {
    recurrence: { frequency: 'monthly', anchor: { month: 9, day: 1 }, timeZone: 'UTC' },
    recurringTemplateId: `recurring-${resourceToken}`,
    createdBy: actor,
    updatedBy: actor,
  })
}

function sparkRecurringTemplate(source: Record<string, unknown>, nextDate: string): Record<string, unknown> {
  const actor = source.createdBy as Record<string, unknown>
  return {
    id: source.recurringTemplateId, groupId: 'group-a', sourceExpenseId: source.id,
    operationId: source.operationId, requestFingerprint: source.requestFingerprint, resourceToken: source.resourceToken,
    lastOperationId: source.lastOperationId, lastRequestFingerprint: source.lastRequestFingerprint, lastResourceToken: source.lastResourceToken,
    status: 'active', description: source.description, total: source.total, payments: source.payments, allocations: source.allocations,
    payerIds: source.payerIds, participantIds: source.participantIds, involvedMemberIds: source.involvedMemberIds,
    category: source.category, splitMethod: source.splitMethod, recurrence: source.recurrence,
    anchorDate: source.date, nextDate, revision: 1,
    createdAt: serverTimestamp(), createdBy: actor, updatedAt: serverTimestamp(), updatedBy: actor,
  }
}

function commitSparkRecurringCreation(source: unknown, expense: Record<string, unknown>, template: Record<string, unknown>): Promise<void> {
  const db = source as Firestore
  const batch = writeBatch(db)
  batch.set(doc(db, `groups/group-a/expenses/${expense.id}`), expense)
  batch.set(doc(db, `groups/group-a/recurringTemplates/${template.id}`), template)
  return batch.commit()
}

function sparkRecurringMaterialization(
  template: Record<string, unknown>, token: string, occurrenceDate: string, nextDate: string,
  actor: Record<string, unknown> = { id: 'active', displayName: 'Active Member' },
): { occurrence: Record<string, unknown>; template: Record<string, unknown>; activity: Record<string, unknown> } {
  const resourceToken = token.repeat(48)
  const templateId = String(template.id)
  const occurrenceId = `occ_${templateId}_${occurrenceDate}`
  const occurrence = sparkExpense(token, {
    id: occurrenceId, groupId: 'group-a', operationId: `materialize-${token}`, requestFingerprint: token.repeat(64), resourceToken,
    lastOperationId: `materialize-${token}`, lastRequestFingerprint: token.repeat(64), lastResourceToken: resourceToken,
    description: template.description, date: occurrenceDate, total: template.total, payments: template.payments, allocations: template.allocations,
    category: template.category, splitType: 'exact', splitMethod: template.splitMethod, recurrence: template.recurrence, recurringTemplateId: templateId,
    createdBy: template.createdBy, updatedBy: actor, revision: 1,
  })
  const advanced = {
    ...template,
    lastOperationId: occurrence.lastOperationId, lastRequestFingerprint: occurrence.lastRequestFingerprint, lastResourceToken: resourceToken,
    nextDate, revision: Number(template.revision) + 1, lastOccurrenceId: occurrenceId, lastOccurrenceDate: occurrenceDate,
    updatedAt: serverTimestamp(), updatedBy: actor,
  }
  return { occurrence, template: advanced, activity: sparkExpenseActivity(occurrence, 'expense.created', serverTimestamp()) }
}

function commitSparkRecurringMaterialization(source: unknown, record: { occurrence: Record<string, unknown>; template: Record<string, unknown>; activity: Record<string, unknown> }): Promise<void> {
  const db = source as Firestore
  const batch = writeBatch(db)
  batch.set(doc(db, `groups/group-a/expenses/${record.occurrence.id}`), record.occurrence)
  batch.set(doc(db, `groups/group-a/recurringTemplates/${record.template.id}`), record.template)
  batch.set(doc(db, `groups/group-a/activity/activity-${record.occurrence.resourceToken}`), record.activity)
  return batch.commit()
}

function sparkRecurringCancellation(
  template: Record<string, unknown>, token: string, expectedRevision: number,
  actor: Record<string, unknown> = { id: 'active', displayName: 'Active Member' },
): Record<string, unknown> {
  return {
    ...template,
    status: 'cancelled', revision: expectedRevision + 1,
    lastOperationId: `cancel-${token}`, lastRequestFingerprint: token.repeat(64), lastResourceToken: token.repeat(48),
    updatedAt: serverTimestamp(), updatedBy: actor,
  }
}

function sparkFutureRecurringEdit(
  source: Record<string, unknown>, template: Record<string, unknown>, token: string,
  actor: Record<string, unknown> = { id: 'active', displayName: 'Active Member' },
): { expense: Record<string, unknown>; head: Record<string, unknown>; revision: Record<string, unknown>; template: Record<string, unknown> } {
  const resourceToken = token.repeat(48)
  const current = (source.current && typeof source.current === 'object' ? source.current : source) as Record<string, unknown>
  const revisionNumber = Number(source.headRevision ?? current.revision) + 1
  const expense: Record<string, unknown> = {
    ...current,
    description: 'Future recurring dinner', date: '2026-09-15',
    recurrence: { frequency: 'fortnightly', anchor: { month: 9, day: 15 }, timeZone: 'UTC' }, occurrenceEditScope: 'future',
    lastOperationId: `future-${token}`, lastRequestFingerprint: token.repeat(64), lastResourceToken: resourceToken,
    updatedAt: serverTimestamp(), updatedBy: actor, revision: revisionNumber,
  }
  const head = {
    ...source,
    lastOperationId: expense.lastOperationId, lastRequestFingerprint: expense.lastRequestFingerprint, lastResourceToken: resourceToken,
    headRevision: revisionNumber, headDeleted: false, current: expense,
  }
  const revision = sparkExpenseVersion(expense, String(expense.lastOperationId), 'updated', actor)
  const updatedTemplate = {
    ...template,
    description: expense.description, total: expense.total, payments: expense.payments, allocations: expense.allocations,
    category: expense.category, splitMethod: expense.splitMethod, recurrence: expense.recurrence,
    anchorDate: expense.date, nextDate: '2026-09-29', revision: Number(template.revision) + 1,
    lastOperationId: expense.lastOperationId, lastRequestFingerprint: expense.lastRequestFingerprint, lastResourceToken: resourceToken,
    updatedAt: serverTimestamp(), updatedBy: actor,
  }
  return { expense, head, revision, template: updatedTemplate }
}

function patchSparkFutureRecurringEdit(
  record: { expense: Record<string, unknown>; head: Record<string, unknown>; revision: Record<string, unknown>; template: Record<string, unknown> },
  expensePatch: Record<string, unknown>,
  templatePatch: Record<string, unknown> = {},
): { expense: Record<string, unknown>; head: Record<string, unknown>; revision: Record<string, unknown>; template: Record<string, unknown> } {
  const expense = { ...record.expense, ...expensePatch }
  const head = { ...record.head, current: expense }
  const revision = { ...record.revision, expense }
  const template = {
    ...record.template,
    description: expense.description,
    total: expense.total,
    payments: expense.payments,
    allocations: expense.allocations,
    payerIds: expense.payerIds,
    participantIds: expense.participantIds,
    involvedMemberIds: expense.involvedMemberIds,
    category: expense.category,
    splitMethod: expense.splitMethod,
    recurrence: expense.recurrence,
    anchorDate: expense.date,
    ...templatePatch,
  }
  return { expense, head, revision, template }
}

function commitSparkFutureRecurringEdit(
  source: unknown,
  record: { expense: Record<string, unknown>; head: Record<string, unknown>; revision: Record<string, unknown> },
  template: Record<string, unknown>,
): Promise<void> {
  const db = source as Firestore
  const batch = writeBatch(db)
  batch.set(doc(db, `groups/group-a/expenses/${record.expense.id}`), record.head)
  batch.set(doc(db, `groups/group-a/expenses/${record.expense.id}/revisions/${record.expense.lastResourceToken}`), record.revision)
  batch.set(doc(db, `groups/group-a/recurringTemplates/${template.id}`), template)
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

function sparkSettings(revision: number, lastCommandKind: 'group.currency-conversion' | 'group.default-split' | 'group.simplify-debts', operationId: string, token: string, actor: Record<string, unknown>, overrides: Record<string, unknown> = {}): Record<string, unknown> {
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

function commitSparkSettings(source: unknown, token: string, settings: Record<string, unknown>, activity: Record<string, unknown>, balance?: Record<string, unknown>, conversion?: Record<string, unknown>): Promise<void> {
  const db = source as Firestore
  const batch = writeBatch(db)
  batch.set(doc(db, 'groups/group-a/settings/defaults'), settings)
  batch.set(doc(db, `groups/group-a/activity/activity-${token}`), activity)
  if (balance) batch.set(doc(db, 'groups/group-a/balance/current'), balance)
  if (conversion) {
    const { rates, ...manifest } = conversion
    const conversionId = `conversion-${token}`
    batch.set(doc(db, `groups/group-a/currencyConversions/${conversionId}`), manifest)
    if (Array.isArray(rates)) for (const candidate of rates) {
      const rate = candidate as Record<string, unknown>
      batch.set(doc(db, `groups/group-a/currencyConversions/${conversionId}/rates/${String(rate.baseCurrency)}`), {
        schemaVersion: 1, groupId: 'group-a', conversionId, operationId: conversion.operationId, ...rate,
      })
    }
  }
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
