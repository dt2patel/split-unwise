// @vitest-environment node
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { connectAuthEmulator, createUserWithEmailAndPassword, getAuth, signInWithEmailAndPassword, signOut, updateProfile } from 'firebase/auth'
import { collection, connectFirestoreEmulator, doc, getDoc, getDocs, getFirestore, limit, query } from 'firebase/firestore'
import { deleteApp } from 'firebase/app'
import { getSplitUnwiseFirebaseApp, resetFirebaseBootstrapForTesting } from '../firebaseBootstrap'
import { acceptSparkInvitation, bootstrapFirebaseProfile, createSparkGroup, createSparkInvitation, inspectSparkInvitation, synchronizeFirebaseProfile } from '../firebaseSparkMutations'
import type { FirebaseConfiguration } from '../firebase'
import { createFirebaseRepository } from '../firebaseRepository'

const emulatorEnabled = Boolean(process.env.FIRESTORE_EMULATOR_HOST && process.env.FIREBASE_AUTH_EMULATOR_HOST)
const emulatorIt = emulatorEnabled ? it : it.skip
const configuration: FirebaseConfiguration = {
  apiKey: 'demo-api-key', authDomain: 'demo-split-unwise.firebaseapp.com', projectId: 'demo-split-unwise', appId: '1:123456789:web:abcdef123456',
}
let app: Awaited<ReturnType<typeof getSplitUnwiseFirebaseApp>>

beforeAll(async () => {
  if (!emulatorEnabled) return
  resetFirebaseBootstrapForTesting()
  app = await getSplitUnwiseFirebaseApp(configuration)
  connectAuthEmulator(getAuth(app), `http://${process.env.FIREBASE_AUTH_EMULATOR_HOST}`, { disableWarnings: true })
  const [host, rawPort] = process.env.FIRESTORE_EMULATOR_HOST!.split(':')
  connectFirestoreEmulator(getFirestore(app), host, Number(rawPort))
})

afterAll(async () => {
  if (app) await deleteApp(app)
  resetFirebaseBootstrapForTesting()
})

describe('Firebase Spark two-account flow', () => {
  emulatorIt('signs up two real Auth users, creates a group, and joins through a private invitation', async () => {
    const auth = getAuth(app)
    const suffix = crypto.randomUUID()
    const ownerEmail = `owner-${suffix}@example.com`
    const friendEmail = `friend-${suffix}@example.com`
    const password = 'SplitUnwise-Test-42!'

    const owner = await createUserWithEmailAndPassword(auth, ownerEmail, password)
    await updateProfile(owner.user, { displayName: 'Owner Account' })
    await bootstrapFirebaseProfile(configuration, owner.user)
    await synchronizeFirebaseProfile(configuration, owner.user)
    const created = await createSparkGroup(configuration, { operationId: `flow-${suffix}`, name: 'Shared Chicago Trip', currency: 'USD' })
    const prepared = await createSparkInvitation(configuration, { groupId: created.groupId, canonicalOrigin: 'https://split-unwise-aditya.web.app' })
    const token = new URL(prepared.link).hash.slice('#token='.length)

    await signOut(auth)
    const friend = await createUserWithEmailAndPassword(auth, friendEmail, password)
    await updateProfile(friend.user, { displayName: 'Friend Account' })
    await bootstrapFirebaseProfile(configuration, friend.user)
    await synchronizeFirebaseProfile(configuration, friend.user)
    await expect(inspectSparkInvitation(configuration, prepared.invitationId, token)).resolves.toMatchObject({ groupId: created.groupId, groupName: 'Shared Chicago Trip', alreadyMember: false })
    await expect(acceptSparkInvitation(configuration, prepared.invitationId, token)).resolves.toEqual({ groupId: created.groupId })

    const joinedGroup = await getDoc(doc(getFirestore(app), `groups/${created.groupId}`))
    expect(joinedGroup.data()?.memberIds).toEqual(expect.arrayContaining([owner.user.uid, friend.user.uid]))
    expect((await getDocs(query(collection(getFirestore(app), `groups/${created.groupId}/members`), limit(100)))).size).toBe(2)

    await signOut(auth)
    await signInWithEmailAndPassword(auth, ownerEmail, password)
    const ownerRepository = createFirebaseRepository(configuration, owner.user.uid)
    await expect(ownerRepository.app.getCurrentUser()).resolves.toMatchObject({ id: owner.user.uid, displayName: 'Owner Account' })
    await expect(ownerRepository.groups.list()).resolves.toEqual([expect.objectContaining({ id: created.groupId, name: 'Shared Chicago Trip' })])
    await expect(ownerRepository.groups.listMembers(created.groupId)).resolves.toEqual(expect.arrayContaining([
      expect.objectContaining({ id: owner.user.uid, displayName: 'Owner Account' }),
      expect.objectContaining({ id: friend.user.uid, displayName: 'Friend Account' }),
    ]))
    expect((await getDoc(doc(getFirestore(app), `groups/${created.groupId}`))).exists()).toBe(true)
  }, 30_000)

  emulatorIt('persists replay-safe Pro defaults and member-controlled debt simplification for both accounts', async () => {
    const auth = getAuth(app)
    const suffix = crypto.randomUUID()
    const ownerEmail = `settings-owner-${suffix}@example.com`
    const friendEmail = `settings-friend-${suffix}@example.com`
    const password = 'SplitUnwise-Test-42!'
    const owner = await createUserWithEmailAndPassword(auth, ownerEmail, password)
    await updateProfile(owner.user, { displayName: 'Settings Owner' })
    await bootstrapFirebaseProfile(configuration, owner.user)
    await synchronizeFirebaseProfile(configuration, owner.user)
    const created = await createSparkGroup(configuration, { operationId: `settings-${suffix}`, name: 'Saved Settings Group', currency: 'USD' })
    const prepared = await createSparkInvitation(configuration, { groupId: created.groupId, canonicalOrigin: 'https://split-unwise-aditya.web.app' })
    const token = new URL(prepared.link).hash.slice('#token='.length)

    await signOut(auth)
    const friend = await createUserWithEmailAndPassword(auth, friendEmail, password)
    await updateProfile(friend.user, { displayName: 'Settings Friend' })
    await bootstrapFirebaseProfile(configuration, friend.user)
    await synchronizeFirebaseProfile(configuration, friend.user)
    await acceptSparkInvitation(configuration, prepared.invitationId, token)
    await signOut(auth)
    await signInWithEmailAndPassword(auth, ownerEmail, password)

    const ownerRepository = createFirebaseRepository(configuration, owner.user.uid)
    const defaultCommand = {
      kind: 'group.default-split' as const, operationId: `default-${suffix}`, groupId: created.groupId, expectedRevision: 1,
      defaultSplit: { type: 'percentage' as const, participantIds: [owner.user.uid, friend.user.uid], percentages: { [owner.user.uid]: 60, [friend.user.uid]: 40 } },
    }
    const savedDefault = await ownerRepository.groups.setDefaultSplit(defaultCommand)
    expect(savedDefault).toEqual({ kind: defaultCommand.kind, operationId: defaultCommand.operationId, status: 'saved', resourceId: created.groupId })
    await expect(ownerRepository.groups.setDefaultSplit(defaultCommand)).resolves.toEqual(savedDefault)
    await expect(ownerRepository.groups.getSettings(created.groupId)).resolves.toMatchObject({
      revision: 2, defaultSplit: defaultCommand.defaultSplit, simplifyDebtsEnabled: true,
    })

    await signOut(auth)
    await signInWithEmailAndPassword(auth, friendEmail, password)
    const friendRepository = createFirebaseRepository(configuration, friend.user.uid)
    await expect(friendRepository.groups.setDefaultSplit({ ...defaultCommand, operationId: `friend-default-${suffix}`, expectedRevision: 2 })).rejects.toThrow(/manager/i)
    const simplifyCommand = { kind: 'group.simplify-debts' as const, operationId: `simplify-${suffix}`, groupId: created.groupId, expectedRevision: 2, simplifyDebtsEnabled: false }
    const savedSimplification = await friendRepository.groups.setSimplifyDebts(simplifyCommand)
    expect(savedSimplification).toEqual({ kind: simplifyCommand.kind, operationId: simplifyCommand.operationId, status: 'saved', resourceId: created.groupId })
    await expect(friendRepository.groups.setSimplifyDebts(simplifyCommand)).resolves.toEqual(savedSimplification)
    await expect(friendRepository.groups.getSettings(created.groupId)).resolves.toMatchObject({ revision: 3, defaultSplit: defaultCommand.defaultSplit, simplifyDebtsEnabled: false })
    await expect(friendRepository.groups.getBalanceSnapshot(created.groupId)).resolves.toMatchObject({ balanceRevision: 1, simplifyDebtsEnabled: false, pairwise: [], simplified: [] })
    await expect(friendRepository.activity.listForGroup(created.groupId)).resolves.toEqual(expect.arrayContaining([
      expect.objectContaining({ operationId: defaultCommand.operationId, kind: 'group.event', subject: { kind: 'group', id: created.groupId, label: 'Default split updated' } }),
      expect.objectContaining({ operationId: simplifyCommand.operationId, kind: 'group.event', subject: { kind: 'group', id: created.groupId, label: 'Simplify debts disabled' } }),
    ]))
    await expect(friendRepository.activity.listForAccount({ filter: 'all', limit: 10 })).resolves.toMatchObject({
      items: expect.arrayContaining([
        expect.objectContaining({ groupId: created.groupId, operationId: defaultCommand.operationId }),
        expect.objectContaining({ groupId: created.groupId, operationId: simplifyCommand.operationId }),
      ]),
    })

    await signOut(auth)
    await signInWithEmailAndPassword(auth, ownerEmail, password)
    await expect(ownerRepository.groups.setDefaultSplit({ ...defaultCommand, operationId: `stale-default-${suffix}`, expectedRevision: 2 })).rejects.toThrow(/changed remotely/i)
  }, 30_000)

  emulatorIt('replays private profile and notification settings while propagating the public member snapshot', async () => {
    const auth = getAuth(app)
    const suffix = crypto.randomUUID()
    const ownerEmail = `private-owner-${suffix}@example.com`
    const friendEmail = `private-friend-${suffix}@example.com`
    const password = 'SplitUnwise-Test-42!'
    const owner = await createUserWithEmailAndPassword(auth, ownerEmail, password)
    await updateProfile(owner.user, { displayName: 'Original Owner' })
    await bootstrapFirebaseProfile(configuration, owner.user)
    await synchronizeFirebaseProfile(configuration, owner.user)
    const created = await createSparkGroup(configuration, { operationId: `private-${suffix}`, name: 'Private Settings Group', currency: 'USD' })
    const invitation = await createSparkInvitation(configuration, { groupId: created.groupId, canonicalOrigin: 'https://split-unwise-aditya.web.app' })
    const token = new URL(invitation.link).hash.slice('#token='.length)

    await signOut(auth)
    const friend = await createUserWithEmailAndPassword(auth, friendEmail, password)
    await updateProfile(friend.user, { displayName: 'Private Friend' })
    await bootstrapFirebaseProfile(configuration, friend.user)
    await synchronizeFirebaseProfile(configuration, friend.user)
    await acceptSparkInvitation(configuration, invitation.invitationId, token)
    await signOut(auth)
    await signInWithEmailAndPassword(auth, ownerEmail, password)

    const ownerRepository = createFirebaseRepository(configuration, owner.user.uid)
    const profileCommand = { kind: 'profile.update' as const, operationId: `rename-${suffix}`, displayName: 'Renamed Owner', initials: 'RO' }
    const savedProfile = await ownerRepository.app.updateProfile(profileCommand)
    expect(savedProfile).toEqual({ kind: profileCommand.kind, operationId: profileCommand.operationId, status: 'saved', resourceId: owner.user.uid })
    await expect(ownerRepository.app.updateProfile(profileCommand)).resolves.toEqual(savedProfile)
    await expect(ownerRepository.app.getCurrentUser()).resolves.toMatchObject({ id: owner.user.uid, displayName: 'Renamed Owner', initials: 'RO' })
    expect(auth.currentUser?.displayName).toBe('Renamed Owner')

    const preferencesCommand = { kind: 'notification.preferences' as const, operationId: `preferences-${suffix}`, preferences: { emailEnabled: false, pushEnabled: true } }
    const savedPreferences = await ownerRepository.notifications.updatePreferences(preferencesCommand)
    expect(savedPreferences).toEqual({ kind: preferencesCommand.kind, operationId: preferencesCommand.operationId, status: 'saved', preferences: preferencesCommand.preferences })
    await expect(ownerRepository.notifications.updatePreferences(preferencesCommand)).resolves.toEqual(savedPreferences)
    await expect(ownerRepository.notifications.getPreferences()).resolves.toEqual(preferencesCommand.preferences)

    await signOut(auth)
    await signInWithEmailAndPassword(auth, friendEmail, password)
    const friendRepository = createFirebaseRepository(configuration, friend.user.uid)
    await expect(friendRepository.groups.listMembers(created.groupId)).resolves.toEqual(expect.arrayContaining([
      expect.objectContaining({ id: owner.user.uid, displayName: 'Renamed Owner', initials: 'RO' }),
      expect.objectContaining({ id: friend.user.uid, displayName: 'Private Friend' }),
    ]))
    const expenseCommand = {
      kind: 'expense.add' as const, operationId: `notification-expense-${suffix}`, groupId: created.groupId,
      description: 'Notification dinner', date: '2026-09-01', total: { currency: 'USD' as const, minorAmount: 2000 },
      payments: [{ participantId: friend.user.uid, money: { currency: 'USD' as const, minorAmount: 2000 } }],
      allocations: [
        { participantId: owner.user.uid, money: { currency: 'USD' as const, minorAmount: 1000 } },
        { participantId: friend.user.uid, money: { currency: 'USD' as const, minorAmount: 1000 } },
      ],
      category: 'Food', splitMethod: { type: 'equal' as const, participantIds: [owner.user.uid, friend.user.uid] }, attachmentRefs: [],
    }
    const expense = await friendRepository.expenses.add(expenseCommand)
    if (expense.status !== 'saved') throw new Error('Expected notification source expense to save')
    await expect(friendRepository.notifications.list({ limit: 100 })).resolves.toEqual({ items: [] })

    await signOut(auth)
    await signInWithEmailAndPassword(auth, ownerEmail, password)
    const firstPage = await ownerRepository.notifications.list({ limit: 100 })
    expect(firstPage.items).toEqual([
      expect.objectContaining({ principalId: owner.user.uid, groupId: created.groupId, activityId: expect.any(String), kind: 'expense.created' }),
    ])
    const firstNotification = firstPage.items[0]!
    const readCommand = { kind: 'notification.read' as const, operationId: `notification-read-${suffix}`, notificationId: firstNotification.notificationId }
    const read = await ownerRepository.notifications.markRead(readCommand)
    await expect(ownerRepository.notifications.markRead(readCommand)).resolves.toEqual(read)
    expect(read).toMatchObject({ status: 'saved', notification: { notificationId: firstNotification.notificationId, readAt: expect.any(String) } })

    await signOut(auth)
    await signInWithEmailAndPassword(auth, friendEmail, password)
    await friendRepository.comments.add({
      kind: 'comment.add', operationId: `notification-comment-${suffix}`, groupId: created.groupId,
      expenseId: expense.expense.id, body: 'Receipt is on the table.', attachmentRefs: [],
    })

    await signOut(auth)
    await signInWithEmailAndPassword(auth, ownerEmail, password)
    const secondPage = await ownerRepository.notifications.list({ limit: 100 })
    expect(secondPage.items).toHaveLength(2)
    expect(secondPage.items.filter(({ readAt }) => readAt === undefined)).toHaveLength(1)
    expect(await ownerRepository.notifications.unreadCount()).toBe(1)
    const latest = secondPage.items[0]!
    const cutoff = { createdAt: latest.createdAt, id: latest.notificationId }
    const readAllCommand = { kind: 'notification.read-all' as const, operationId: `notification-read-all-${suffix}`, cutoff }
    const readAll = await ownerRepository.notifications.markAllRead(readAllCommand)
    await expect(ownerRepository.notifications.markAllRead(readAllCommand)).resolves.toEqual(readAll)
    expect(readAll).toMatchObject({ status: 'saved', cutoff, readNotificationIds: [latest.notificationId] })
    await expect(ownerRepository.notifications.unreadCount()).resolves.toBe(0)
    expect((await ownerRepository.notifications.list({ limit: 100 })).items.every(({ readAt }) => typeof readAt === 'string')).toBe(true)
  }, 45_000)

  emulatorIt('adds, edits, and soft-deletes one replay-stable expense with shared history and balances', async () => {
    const auth = getAuth(app)
    const suffix = crypto.randomUUID()
    const ownerEmail = `ledger-owner-${suffix}@example.com`
    const friendEmail = `ledger-friend-${suffix}@example.com`
    const password = 'SplitUnwise-Test-42!'
    const owner = await createUserWithEmailAndPassword(auth, ownerEmail, password)
    await updateProfile(owner.user, { displayName: 'Ledger Owner' })
    await bootstrapFirebaseProfile(configuration, owner.user)
    await synchronizeFirebaseProfile(configuration, owner.user)
    const created = await createSparkGroup(configuration, { operationId: `ledger-${suffix}`, name: 'Live Ledger Group', currency: 'USD' })
    const prepared = await createSparkInvitation(configuration, { groupId: created.groupId, canonicalOrigin: 'https://split-unwise-aditya.web.app' })
    const token = new URL(prepared.link).hash.slice('#token='.length)

    await signOut(auth)
    const friend = await createUserWithEmailAndPassword(auth, friendEmail, password)
    await updateProfile(friend.user, { displayName: 'Ledger Friend' })
    await bootstrapFirebaseProfile(configuration, friend.user)
    await synchronizeFirebaseProfile(configuration, friend.user)
    await acceptSparkInvitation(configuration, prepared.invitationId, token)
    await signOut(auth)
    await signInWithEmailAndPassword(auth, ownerEmail, password)

    const operationId = `expense-${suffix}`
    const ownerRepository = createFirebaseRepository(configuration, owner.user.uid)
    const command = {
      kind: 'expense.add' as const, operationId, groupId: created.groupId, description: 'Shared dinner', date: '2026-09-01',
      total: { currency: 'USD' as const, minorAmount: 2400 },
      payments: [{ participantId: owner.user.uid, money: { currency: 'USD' as const, minorAmount: 2400 } }],
      allocations: [
        { participantId: owner.user.uid, money: { currency: 'USD' as const, minorAmount: 1200 } },
        { participantId: friend.user.uid, money: { currency: 'USD' as const, minorAmount: 1200 } },
      ],
      category: 'Food', splitMethod: { type: 'equal' as const, participantIds: [owner.user.uid, friend.user.uid] }, attachmentRefs: [],
    }
    const first = await ownerRepository.expenses.add(command)
    const replay = await ownerRepository.expenses.add(command)

    expect(first).toMatchObject({ kind: 'expense.add', operationId, status: 'saved', expense: { description: 'Shared dinner', revision: 1 } })
    expect(replay).toEqual(first)
    if (first.status !== 'saved') throw new Error('Expected Spark expense creation to save')
    expect(await ownerRepository.expenses.listForGroup(created.groupId)).toHaveLength(1)
    expect(await ownerRepository.groups.getBalanceSnapshot(created.groupId)).toMatchObject({
      groupId: created.groupId, balanceRevision: 1,
      pairwise: [{ fromParticipantId: friend.user.uid, toParticipantId: owner.user.uid, money: { currency: 'USD', minorAmount: 1200 } }],
      simplified: [{ fromParticipantId: friend.user.uid, toParticipantId: owner.user.uid, money: { currency: 'USD', minorAmount: 1200 } }],
    })

    await signOut(auth)
    await signInWithEmailAndPassword(auth, friendEmail, password)
    const friendRepository = createFirebaseRepository(configuration, friend.user.uid)
    await expect(friendRepository.expenses.listForGroup(created.groupId)).resolves.toEqual([
      expect.objectContaining({ description: 'Shared dinner', total: { currency: 'USD', minorAmount: 2400 } }),
    ])
    await expect(friendRepository.activity.listForAccount({ filter: 'expenses', limit: 20 })).resolves.toMatchObject({
      items: [{ kind: 'expense.created', operationId, expenseId: first.expense.id, revision: 1, subject: { kind: 'expense', id: first.expense.id, label: 'Shared dinner' } }],
    })
    await expect(friendRepository.groups.getBalanceSnapshot(created.groupId)).resolves.toMatchObject({
      simplified: [{ fromParticipantId: friend.user.uid, toParticipantId: owner.user.uid, money: { currency: 'USD', minorAmount: 1200 } }],
    })

    const editCommand = {
      kind: 'expense.edit' as const, operationId: `edit-${suffix}`, groupId: created.groupId, expenseId: first.expense.id, expectedRevision: 1,
      draft: {
        groupId: created.groupId, description: 'Shared dinner and dessert', date: '2026-09-01',
        total: { currency: 'USD' as const, minorAmount: 3000 },
        payments: [{ participantId: owner.user.uid, money: { currency: 'USD' as const, minorAmount: 3000 } }],
        allocations: [
          { participantId: owner.user.uid, money: { currency: 'USD' as const, minorAmount: 1500 } },
          { participantId: friend.user.uid, money: { currency: 'USD' as const, minorAmount: 1500 } },
        ],
        category: 'Food', splitMethod: { type: 'equal' as const, participantIds: [owner.user.uid, friend.user.uid] }, attachmentRefs: [],
      },
    }
    await expect(friendRepository.expenses.edit({ ...editCommand, operationId: `friend-edit-${suffix}` })).rejects.toThrow(/author|manager/i)

    await signOut(auth)
    await signInWithEmailAndPassword(auth, ownerEmail, password)
    const edited = await ownerRepository.expenses.edit(editCommand)
    const editReplay = await ownerRepository.expenses.edit(editCommand)
    expect(edited).toMatchObject({ status: 'saved', expense: { id: first.expense.id, description: 'Shared dinner and dessert', revision: 2 } })
    expect(editReplay).toEqual(edited)
    await expect(ownerRepository.groups.getBalanceSnapshot(created.groupId)).resolves.toMatchObject({
      balanceRevision: 2,
      simplified: [{ fromParticipantId: friend.user.uid, toParticipantId: owner.user.uid, money: { currency: 'USD', minorAmount: 1500 } }],
    })
    await expect(ownerRepository.expenses.listRevisions(created.groupId, first.expense.id)).resolves.toMatchObject([
      { revision: 1, action: 'created', expense: { description: 'Shared dinner' } },
      { revision: 2, action: 'updated', expense: { description: 'Shared dinner and dessert' } },
    ])

    await signOut(auth)
    await signInWithEmailAndPassword(auth, friendEmail, password)
    const commentCommand = {
      kind: 'comment.add' as const, operationId: `comment-${suffix}`, groupId: created.groupId, expenseId: first.expense.id,
      body: 'Dessert was a good call.', attachmentRefs: [],
    }
    const addedComment = await friendRepository.comments.add(commentCommand)
    const commentReplay = await friendRepository.comments.add(commentCommand)
    expect(addedComment).toMatchObject({ status: 'saved', comment: { body: 'Dessert was a good call.' }, activity: { kind: 'comment.added' } })
    expect(commentReplay).toEqual(addedComment)
    if (addedComment.status !== 'saved') throw new Error('Expected Spark comment creation to save')
    await expect(friendRepository.comments.listForExpense(created.groupId, first.expense.id)).resolves.toEqual([
      expect.objectContaining({ commentId: addedComment.comment.commentId, body: 'Dessert was a good call.' }),
    ])
    await expect(friendRepository.activity.listForGroup(created.groupId)).resolves.toEqual(expect.arrayContaining([
      expect.objectContaining({ operationId: commentCommand.operationId, kind: 'comment.added', commentId: addedComment.comment.commentId }),
    ]))

    const commentDelete = {
      kind: 'comment.delete' as const, operationId: `comment-delete-${suffix}`, groupId: created.groupId,
      expenseId: first.expense.id, commentId: addedComment.comment.commentId,
    }
    await signOut(auth)
    await signInWithEmailAndPassword(auth, ownerEmail, password)
    await expect(ownerRepository.comments.delete({ ...commentDelete, operationId: `owner-comment-delete-${suffix}` })).rejects.toThrow(/author/i)
    await signOut(auth)
    await signInWithEmailAndPassword(auth, friendEmail, password)
    const deletedComment = await friendRepository.comments.delete(commentDelete)
    const deleteCommentReplay = await friendRepository.comments.delete(commentDelete)
    expect(deletedComment).toMatchObject({ status: 'saved', comment: { commentId: addedComment.comment.commentId, deletedAt: expect.any(String) }, activity: { kind: 'comment.deleted' } })
    expect(deleteCommentReplay).toEqual(deletedComment)
    await expect(friendRepository.comments.listForExpense(created.groupId, first.expense.id)).resolves.toEqual([
      expect.objectContaining({ commentId: addedComment.comment.commentId, deletedAt: expect.any(String) }),
    ])

    await signOut(auth)
    await signInWithEmailAndPassword(auth, ownerEmail, password)

    const deleteCommand = { kind: 'expense.delete' as const, operationId: `delete-${suffix}`, groupId: created.groupId, expenseId: first.expense.id, expectedRevision: 2 }
    const removed = await ownerRepository.expenses.delete(deleteCommand)
    const deleteReplay = await ownerRepository.expenses.delete(deleteCommand)
    expect(removed).toMatchObject({ status: 'saved', tombstone: { id: first.expense.id, groupId: created.groupId, revision: 3 } })
    expect(deleteReplay).toEqual(removed)
    await expect(ownerRepository.expenses.listForGroup(created.groupId)).resolves.toEqual([])
    await expect(ownerRepository.expenses.getById(created.groupId, first.expense.id)).resolves.toMatchObject({ revision: 3, deletedAt: expect.any(String) })
    await expect(ownerRepository.groups.getBalanceSnapshot(created.groupId)).resolves.toMatchObject({ balanceRevision: 3, pairwise: [], simplified: [] })
    await expect(ownerRepository.expenses.listRevisions(created.groupId, first.expense.id)).resolves.toMatchObject([
      { revision: 1, action: 'created' }, { revision: 2, action: 'updated' }, { revision: 3, action: 'deleted' },
    ])
    const expenseActivity = (await ownerRepository.activity.listForGroup(created.groupId))
      .filter(({ kind }) => kind === 'expense.created' || kind === 'expense.updated' || kind === 'expense.deleted')
      .map(({ kind, operationId: activityOperationId, expenseId, revision, subject }) => ({ kind, operationId: activityOperationId, expenseId, revision, subject }))
    expect(expenseActivity).toEqual([
      { kind: 'expense.created', operationId, expenseId: first.expense.id, revision: 1, subject: { kind: 'expense', id: first.expense.id, label: 'Shared dinner' } },
      { kind: 'expense.updated', operationId: editCommand.operationId, expenseId: first.expense.id, revision: 2, subject: { kind: 'expense', id: first.expense.id, label: 'Shared dinner and dessert' } },
      { kind: 'expense.deleted', operationId: deleteCommand.operationId, expenseId: first.expense.id, revision: 3, subject: { kind: 'expense', id: first.expense.id, label: 'Shared dinner and dessert' } },
    ])
  }, 30_000)

  emulatorIt('records and voids a replay-safe hosted settlement that both accounts can read', async () => {
    const auth = getAuth(app)
    const suffix = crypto.randomUUID()
    const ownerEmail = `settlement-owner-${suffix}@example.com`
    const friendEmail = `settlement-friend-${suffix}@example.com`
    const password = 'SplitUnwise-Test-42!'
    const owner = await createUserWithEmailAndPassword(auth, ownerEmail, password)
    await updateProfile(owner.user, { displayName: 'Settlement Owner' })
    await bootstrapFirebaseProfile(configuration, owner.user)
    await synchronizeFirebaseProfile(configuration, owner.user)
    const created = await createSparkGroup(configuration, { operationId: `settlement-${suffix}`, name: 'Settlement Group', currency: 'USD' })
    const invitation = await createSparkInvitation(configuration, { groupId: created.groupId, canonicalOrigin: 'https://split-unwise-aditya.web.app' })
    const token = new URL(invitation.link).hash.slice('#token='.length)

    await signOut(auth)
    const friend = await createUserWithEmailAndPassword(auth, friendEmail, password)
    await updateProfile(friend.user, { displayName: 'Settlement Friend' })
    await bootstrapFirebaseProfile(configuration, friend.user)
    await synchronizeFirebaseProfile(configuration, friend.user)
    await acceptSparkInvitation(configuration, invitation.invitationId, token)
    await signOut(auth)
    await signInWithEmailAndPassword(auth, ownerEmail, password)

    const ownerRepository = createFirebaseRepository(configuration, owner.user.uid)
    const expense = await ownerRepository.expenses.add({
      kind: 'expense.add', operationId: `settlement-expense-${suffix}`, groupId: created.groupId, description: 'Cabin deposit', date: '2026-09-01',
      total: { currency: 'USD', minorAmount: 2400 }, payments: [{ participantId: owner.user.uid, money: { currency: 'USD', minorAmount: 2400 } }],
      allocations: [
        { participantId: owner.user.uid, money: { currency: 'USD', minorAmount: 1200 } },
        { participantId: friend.user.uid, money: { currency: 'USD', minorAmount: 1200 } },
      ],
      category: 'Lodging', splitMethod: { type: 'equal', participantIds: [owner.user.uid, friend.user.uid] }, attachmentRefs: [],
    })
    expect(expense.status).toBe('saved')

    await signOut(auth)
    await signInWithEmailAndPassword(auth, friendEmail, password)
    const friendRepository = createFirebaseRepository(configuration, friend.user.uid)
    const before = await friendRepository.groups.getBalanceSnapshot(created.groupId)
    const basis = before.simplified[0]
    expect(basis).toEqual({ fromParticipantId: friend.user.uid, toParticipantId: owner.user.uid, money: { currency: 'USD', minorAmount: 1200 } })
    const recordCommand = {
      kind: 'settlement.record' as const, operationId: `record-${suffix}`, groupId: created.groupId, expectedBalanceRevision: before.balanceRevision,
      basis: { kind: 'simplified' as const, senderId: basis!.fromParticipantId, recipientId: basis!.toParticipantId, currency: basis!.money.currency, debtMinor: basis!.money.minorAmount },
      money: { currency: 'USD' as const, minorAmount: 500 }, method: 'cash' as const, occurredOn: '2026-09-01', note: 'Paid after dinner', outsidePaymentConfirmed: true as const,
    }
    const recorded = await friendRepository.settlements.record(recordCommand)
    const replay = await friendRepository.settlements.record(recordCommand)
    expect(recorded).toMatchObject({ kind: 'settlement.record', operationId: recordCommand.operationId, status: 'saved', settlement: { revision: 1, money: { currency: 'USD', minorAmount: 500 } }, activity: { kind: 'settlement.created' } })
    expect(replay).toEqual(recorded)
    if (recorded.status !== 'saved') throw new Error('Expected Spark settlement creation to save')
    await expect(friendRepository.settlements.listForGroup(created.groupId)).resolves.toEqual([expect.objectContaining({ settlementId: recorded.settlement.settlementId, revision: 1 })])
    await expect(friendRepository.groups.getBalanceSnapshot(created.groupId)).resolves.toMatchObject({
      balanceRevision: 2,
      simplified: [{ fromParticipantId: friend.user.uid, toParticipantId: owner.user.uid, money: { currency: 'USD', minorAmount: 700 } }],
    })

    await signOut(auth)
    await signInWithEmailAndPassword(auth, ownerEmail, password)
    await expect(ownerRepository.settlements.getById(created.groupId, recorded.settlement.settlementId)).resolves.toMatchObject({ revision: 1, createdBy: { id: friend.user.uid } })
    const beforeVoid = await ownerRepository.groups.getBalanceSnapshot(created.groupId)
    const voidCommand = {
      kind: 'settlement.void' as const, operationId: `void-${suffix}`, groupId: created.groupId, settlementId: recorded.settlement.settlementId,
      expectedRevision: 1, expectedBalanceRevision: beforeVoid.balanceRevision, reason: 'Entered twice by mistake.',
    }
    const voided = await ownerRepository.settlements.void(voidCommand)
    const voidReplay = await ownerRepository.settlements.void(voidCommand)
    expect(voided).toMatchObject({ kind: 'settlement.void', operationId: voidCommand.operationId, status: 'saved', settlement: { revision: 2, void: { reason: voidCommand.reason } }, activity: { kind: 'settlement.voided' } })
    expect(voidReplay).toEqual(voided)
    await expect(ownerRepository.groups.getBalanceSnapshot(created.groupId)).resolves.toMatchObject({
      balanceRevision: 3,
      simplified: [{ fromParticipantId: friend.user.uid, toParticipantId: owner.user.uid, money: { currency: 'USD', minorAmount: 1200 } }],
    })
    await expect(ownerRepository.activity.listForGroup(created.groupId)).resolves.toEqual(expect.arrayContaining([
      expect.objectContaining({ operationId: recordCommand.operationId, kind: 'settlement.created', settlementId: recorded.settlement.settlementId }),
      expect.objectContaining({ operationId: voidCommand.operationId, kind: 'settlement.voided', settlementId: recorded.settlement.settlementId }),
    ]))
  }, 30_000)

  emulatorIt('creates one recurring template and one occurrence when clients race, then semantically replays across users', async () => {
    const auth = getAuth(app)
    const suffix = crypto.randomUUID()
    const ownerEmail = `recurrence-owner-${suffix}@example.com`
    const friendEmail = `recurrence-friend-${suffix}@example.com`
    const password = 'SplitUnwise-Test-42!'
    const owner = await createUserWithEmailAndPassword(auth, ownerEmail, password)
    await updateProfile(owner.user, { displayName: 'Recurrence Owner' })
    await bootstrapFirebaseProfile(configuration, owner.user)
    await synchronizeFirebaseProfile(configuration, owner.user)
    const created = await createSparkGroup(configuration, { operationId: `recurrence-${suffix}`, name: 'Recurring Household', currency: 'USD' })
    const invitation = await createSparkInvitation(configuration, { groupId: created.groupId, canonicalOrigin: 'https://split-unwise-aditya.web.app' })
    const invitationToken = new URL(invitation.link).hash.slice('#token='.length)

    await signOut(auth)
    const friend = await createUserWithEmailAndPassword(auth, friendEmail, password)
    await updateProfile(friend.user, { displayName: 'Recurrence Friend' })
    await bootstrapFirebaseProfile(configuration, friend.user)
    await synchronizeFirebaseProfile(configuration, friend.user)
    await acceptSparkInvitation(configuration, invitation.invitationId, invitationToken)
    await signOut(auth)
    await signInWithEmailAndPassword(auth, ownerEmail, password)

    const ownerRepository = createFirebaseRepository(configuration, owner.user.uid)
    const recurringCommand = {
      kind: 'expense.add' as const, operationId: `recurring-rent-${suffix}`, groupId: created.groupId, description: 'Monthly rent', date: '2026-09-01',
      total: { currency: 'USD' as const, minorAmount: 2000 }, payments: [{ participantId: owner.user.uid, money: { currency: 'USD' as const, minorAmount: 2000 } }],
      allocations: [
        { participantId: owner.user.uid, money: { currency: 'USD' as const, minorAmount: 1000 } },
        { participantId: friend.user.uid, money: { currency: 'USD' as const, minorAmount: 1000 } },
      ],
      category: 'Housing', splitMethod: { type: 'equal' as const, participantIds: [owner.user.uid, friend.user.uid] }, attachmentRefs: [],
      recurrence: { frequency: 'monthly' as const, anchor: { month: 9, day: 1 }, timeZone: 'America/Chicago' },
    }
    const added = await ownerRepository.expenses.add(recurringCommand)
    expect(added).toMatchObject({ status: 'saved', expense: { recurringTemplateId: expect.stringMatching(/^recurring-[a-f0-9]{48}$/) } })
    if (added.status !== 'saved' || !added.expense.recurringTemplateId) throw new Error('Expected recurring Spark expense to save')
    const templateId = added.expense.recurringTemplateId
    await expect(ownerRepository.expenses.add(recurringCommand)).resolves.toEqual(added)
    await expect(ownerRepository.groups.listRecurring(created.groupId)).resolves.toEqual([
      expect.objectContaining({ id: templateId, nextDate: '2026-10-01', revision: 1, status: 'active' }),
    ])

    await signOut(auth)
    await signInWithEmailAndPassword(auth, friendEmail, password)
    const friendRepository = createFirebaseRepository(configuration, friend.user.uid)
    const firstRace = friendRepository.commands.execute({
      kind: 'recurrence.materialize', operationId: `race-a-${suffix}`, groupId: created.groupId, templateId, occurrenceDate: '2026-10-01',
    })
    const secondRace = friendRepository.commands.execute({
      kind: 'recurrence.materialize', operationId: `race-b-${suffix}`, groupId: created.groupId, templateId, occurrenceDate: '2026-10-01',
    })
    const [first, second] = await Promise.all([firstRace, secondRace])
    expect(first).toMatchObject({ status: 'saved', occurrence: { id: `occ_${templateId}_2026-10-01` } })
    expect(second).toMatchObject({ status: 'saved', occurrence: { id: `occ_${templateId}_2026-10-01` } })
    await expect(friendRepository.groups.listRecurring(created.groupId)).resolves.toEqual([
      expect.objectContaining({ id: templateId, nextDate: '2026-11-01', revision: 2, lastOccurrenceDate: '2026-10-01' }),
    ])
    expect((await friendRepository.expenses.listForGroup(created.groupId)).filter(({ recurringTemplateId }) => recurringTemplateId === templateId)).toHaveLength(2)
    await expect(friendRepository.groups.getBalanceSnapshot(created.groupId)).resolves.toMatchObject({
      pairwise: [{ fromParticipantId: friend.user.uid, toParticipantId: owner.user.uid, money: { currency: 'USD', minorAmount: 2000 } }],
    })
    expect((await friendRepository.activity.listForGroup(created.groupId)).filter(({ expenseId }) => expenseId === `occ_${templateId}_2026-10-01`)).toHaveLength(1)

    await signOut(auth)
    await signInWithEmailAndPassword(auth, ownerEmail, password)
    const crossUserReplay = await ownerRepository.commands.execute({
      kind: 'recurrence.materialize', operationId: `owner-replay-${suffix}`, groupId: created.groupId, templateId, occurrenceDate: '2026-10-01',
    })
    expect(crossUserReplay).toMatchObject({ status: 'saved', occurrence: { id: `occ_${templateId}_2026-10-01` }, template: { revision: 2 } })
    expect((await ownerRepository.activity.listForGroup(created.groupId)).filter(({ expenseId }) => expenseId === `occ_${templateId}_2026-10-01`)).toHaveLength(1)
  }, 45_000)

  emulatorIt('isolates occurrence edits, gates future edits to the series frontier, and cancels without touching expenses', async () => {
    const auth = getAuth(app)
    const suffix = crypto.randomUUID()
    const email = `recurrence-edit-${suffix}@example.com`
    const password = 'SplitUnwise-Test-42!'
    const owner = await createUserWithEmailAndPassword(auth, email, password)
    await updateProfile(owner.user, { displayName: 'Series Editor' })
    await bootstrapFirebaseProfile(configuration, owner.user)
    await synchronizeFirebaseProfile(configuration, owner.user)
    const created = await createSparkGroup(configuration, { operationId: `series-edit-${suffix}`, name: 'Series Editing', currency: 'USD' })
    const repository = createFirebaseRepository(configuration, owner.user.uid)
    const baseDraft = {
      groupId: created.groupId, description: 'Storage unit', date: '2026-09-01', total: { currency: 'USD' as const, minorAmount: 1200 },
      payments: [{ participantId: owner.user.uid, money: { currency: 'USD' as const, minorAmount: 1200 } }],
      allocations: [{ participantId: owner.user.uid, money: { currency: 'USD' as const, minorAmount: 1200 } }],
      category: 'Housing', splitMethod: { type: 'equal' as const, participantIds: [owner.user.uid] }, attachmentRefs: [],
      recurrence: { frequency: 'monthly' as const, anchor: { month: 9, day: 1 }, timeZone: 'UTC' },
    }
    const added = await repository.expenses.add({ kind: 'expense.add', operationId: `series-source-${suffix}`, ...baseDraft })
    if (added.status !== 'saved' || !added.expense.recurringTemplateId) throw new Error('Expected recurring Spark source to save')
    const templateId = added.expense.recurringTemplateId

    const sourceFuture = await repository.expenses.edit({
      kind: 'expense.edit', operationId: `source-future-${suffix}`, groupId: created.groupId, expenseId: added.expense.id, expectedRevision: 1,
      draft: { ...baseDraft, date: '2026-09-15', description: 'Storage plus insurance', recurrence: { frequency: 'fortnightly', anchor: { month: 9, day: 15 }, timeZone: 'UTC' }, occurrenceEditScope: 'future' },
    })
    expect(sourceFuture).toMatchObject({ status: 'saved', expense: { revision: 2, occurrenceEditScope: 'future' } })
    await expect(repository.groups.listRecurring(created.groupId)).resolves.toEqual([
      expect.objectContaining({ id: templateId, description: 'Storage plus insurance', nextDate: '2026-09-29', revision: 2 }),
    ])

    const catchUp = await repository.groups.materializeDue(created.groupId, '2026-09-29')
    expect(catchUp).toMatchObject({ occurrences: [{ id: `occ_${templateId}_2026-09-29` }], moreRemain: false })
    const occurrence = catchUp.occurrences[0]!
    const beforeOccurrenceEdit = (await repository.groups.listRecurring(created.groupId))[0]!
    const occurrenceEdit = await repository.expenses.edit({
      kind: 'expense.edit', operationId: `one-occurrence-${suffix}`, groupId: created.groupId, expenseId: occurrence.id, expectedRevision: 1,
      draft: { ...baseDraft, date: '2026-09-30', description: 'One-off discounted storage', recurrence: undefined, occurrenceEditScope: 'occurrence' },
    })
    expect(occurrenceEdit).toMatchObject({
      status: 'saved',
      expense: { id: `occ_${templateId}_2026-09-29`, date: '2026-09-30', occurrenceEditScope: 'occurrence' },
    })
    await expect(repository.groups.listRecurring(created.groupId)).resolves.toEqual([beforeOccurrenceEdit])

    await expect(repository.expenses.edit({
      kind: 'expense.edit', operationId: `stale-source-${suffix}`, groupId: created.groupId, expenseId: added.expense.id, expectedRevision: 2,
      draft: { ...baseDraft, date: '2026-09-29', occurrenceEditScope: 'future' },
    })).rejects.toThrow(/latest/i)

    await repository.expenses.edit({
      kind: 'expense.edit', operationId: `latest-future-${suffix}`, groupId: created.groupId, expenseId: occurrence.id, expectedRevision: 2,
      draft: { ...baseDraft, date: '2026-09-29', recurrence: { frequency: 'weekly', anchor: { month: 9, day: 29 }, timeZone: 'UTC' }, occurrenceEditScope: 'future' },
    })
    const latestTemplate = (await repository.groups.listRecurring(created.groupId))[0]!
    expect(latestTemplate).toMatchObject({ nextDate: '2026-10-06', revision: 4 })
    const expensesBeforeCancel = await repository.expenses.listForGroup(created.groupId)
    await expect(repository.commands.execute({
      kind: 'recurrence.cancel', operationId: `cancel-series-${suffix}`, groupId: created.groupId, templateId, expectedRevision: latestTemplate.revision,
    })).resolves.toMatchObject({ status: 'saved', template: { status: 'cancelled', revision: 5 } })
    await expect(repository.expenses.listForGroup(created.groupId)).resolves.toEqual(expensesBeforeCancel)
    await expect(repository.groups.materializeDue(created.groupId, '2026-12-31')).resolves.toEqual({ occurrences: [], moreRemain: false })
  }, 45_000)
})
