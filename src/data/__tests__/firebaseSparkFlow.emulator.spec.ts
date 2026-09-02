// @vitest-environment node
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { connectAuthEmulator, createUserWithEmailAndPassword, getAuth, signInWithEmailAndPassword, signOut, updateProfile } from 'firebase/auth'
import { collection, connectFirestoreEmulator, doc, getDoc, getDocs, getFirestore, limit, query, serverTimestamp, writeBatch } from 'firebase/firestore'
import { deleteApp } from 'firebase/app'
import { getSplitUnwiseFirebaseApp, resetFirebaseBootstrapForTesting } from '../firebaseBootstrap'
import { acceptSparkInvitation, bootstrapFirebaseProfile, createSparkGroup, createSparkInvitation, inspectSparkInvitation, synchronizeFirebaseProfile } from '../firebaseSparkMutations'
import type { FirebaseConfiguration } from '../firebase'
import { createFirebaseRepository } from '../firebaseRepository'
import { prepareFirebaseAccountDeletion } from '../firebaseAccountDeletion'

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

  emulatorIt('prepares a shared account deletion without changing the remaining member ledger', async () => {
    const auth = getAuth(app)
    const db = getFirestore(app)
    const suffix = crypto.randomUUID()
    const ownerEmail = `deletion-owner-${suffix}@example.com`
    const friendEmail = `deletion-friend-${suffix}@example.com`
    const extraEmail = `deletion-extra-${suffix}@example.com`
    const password = 'SplitUnwise-Test-42!'

    const owner = await createUserWithEmailAndPassword(auth, ownerEmail, password)
    await updateProfile(owner.user, { displayName: 'Deletion Owner' })
    await bootstrapFirebaseProfile(configuration, owner.user)
    await synchronizeFirebaseProfile(configuration, owner.user)
    const created = await createSparkGroup(configuration, { operationId: `deletion-${suffix}`, name: 'Deletion Ledger', currency: 'USD' })
    const invitation = await createSparkInvitation(configuration, { groupId: created.groupId, canonicalOrigin: 'https://split-unwise-aditya.web.app' })
    const token = new URL(invitation.link).hash.slice('#token='.length)

    await signOut(auth)
    const friend = await createUserWithEmailAndPassword(auth, friendEmail, password)
    await updateProfile(friend.user, { displayName: 'Deletion Friend' })
    await bootstrapFirebaseProfile(configuration, friend.user)
    await synchronizeFirebaseProfile(configuration, friend.user)
    await acceptSparkInvitation(configuration, invitation.invitationId, token)

    await signOut(auth)
    await signInWithEmailAndPassword(auth, ownerEmail, password)
    const ownerRepository = createFirebaseRepository(configuration, owner.user.uid)
    await ownerRepository.groups.setDefaultSplit({
      kind: 'group.default-split', operationId: `deletion-default-${suffix}`, groupId: created.groupId, expectedRevision: 1,
      defaultSplit: { type: 'equal', participantIds: [owner.user.uid, friend.user.uid] },
    })
    await ownerRepository.notifications.updatePreferences({
      kind: 'notification.preferences', operationId: `deletion-preferences-${suffix}`,
      preferences: { emailEnabled: false, pushEnabled: true },
    })
    const expense = await ownerRepository.expenses.add({
      kind: 'expense.add', operationId: `deletion-expense-${suffix}`, groupId: created.groupId,
      description: 'Recurring deletion dinner', date: '2026-09-01',
      total: { currency: 'USD', minorAmount: 2400 },
      payments: [{ participantId: owner.user.uid, money: { currency: 'USD', minorAmount: 2400 } }],
      allocations: [
        { participantId: owner.user.uid, money: { currency: 'USD', minorAmount: 1200 } },
        { participantId: friend.user.uid, money: { currency: 'USD', minorAmount: 1200 } },
      ],
      category: 'Food', splitMethod: { type: 'equal', participantIds: [owner.user.uid, friend.user.uid] }, attachmentRefs: [],
      recurrence: { frequency: 'monthly', anchor: { month: 9, day: 1 }, timeZone: 'America/Chicago' },
    })
    if (expense.status !== 'saved' || !expense.expense.recurringTemplateId) throw new Error('Expected deletion source expense to save')
    const comment = await ownerRepository.comments.add({
      kind: 'comment.add', operationId: `deletion-comment-${suffix}`, groupId: created.groupId,
      expenseId: expense.expense.id, body: 'Owner private comment', attachmentRefs: [],
    })
    if (comment.status !== 'saved') throw new Error('Expected deletion comment to save')
    const settlement = await ownerRepository.settlements.record({
      kind: 'settlement.record', operationId: `deletion-settlement-${suffix}`, groupId: created.groupId, expectedBalanceRevision: 1,
      basis: { kind: 'simplified', senderId: friend.user.uid, recipientId: owner.user.uid, currency: 'USD', debtMinor: 1200 },
      money: { currency: 'USD', minorAmount: 400 }, method: 'cash', occurredOn: '2026-09-01', outsidePaymentConfirmed: true,
    })
    if (settlement.status !== 'saved') throw new Error('Expected deletion settlement to save')
    const activeInvitation = await createSparkInvitation(configuration, {
      groupId: created.groupId, canonicalOrigin: 'https://split-unwise-aditya.web.app', targetEmail: extraEmail,
    })

    const expensePath = `groups/${created.groupId}/expenses/${expense.expense.id}`
    const settlementPath = `groups/${created.groupId}/settlements/${settlement.settlement.settlementId}`
    const balancePath = `groups/${created.groupId}/balance/current`
    const [beforeExpense, beforeSettlement, beforeBalance] = await Promise.all([
      getDoc(doc(db, expensePath)), getDoc(doc(db, settlementPath)), getDoc(doc(db, balancePath)),
    ])
    const preservedExpenseLedger = pick(beforeExpense.data()!, ['total', 'payments', 'allocations'])
    const preservedSettlementLedger = pick(beforeSettlement.data()!, ['money', 'senderId', 'recipientId', 'basis'])
    const preservedBalance = beforeBalance.data()

    const prepared = await prepareFirebaseAccountDeletion(configuration, { uid: owner.user.uid }, app)
    expect(prepared).toMatchObject({ phase: 'prepared', groupsProcessed: 1 })
    expect((await getDoc(doc(db, `users/${owner.user.uid}`))).data()).toMatchObject({
      displayName: 'Deleted user', initials: 'DU', avatarUrl: null, deletionStatus: 'prepared', deletionId: prepared.deletionId,
    })
    await expect(getDoc(doc(db, `groups/${created.groupId}`))).rejects.toBeDefined()
    await expect(prepareFirebaseAccountDeletion(configuration, { uid: owner.user.uid }, app)).resolves.toEqual({
      deletionId: prepared.deletionId, phase: 'prepared', groupsProcessed: 0,
      sharedDocumentsChanged: 0, privateDocumentsDeleted: 0, invitationsDeleted: 0,
    })

    await signOut(auth)
    await signInWithEmailAndPassword(auth, friendEmail, password)
    const remainingRepository = createFirebaseRepository(configuration, friend.user.uid)
    await expect(remainingRepository.groups.listMembers(created.groupId)).resolves.toEqual(expect.arrayContaining([
      expect.objectContaining({ id: owner.user.uid, accountStatus: 'deleted', displayName: 'Deleted user', canManage: false }),
      expect.objectContaining({ id: friend.user.uid, displayName: 'Deletion Friend', canManage: true }),
    ]))
    expect(pick((await getDoc(doc(db, expensePath))).data()!, ['total', 'payments', 'allocations'])).toEqual(preservedExpenseLedger)
    expect((await getDoc(doc(db, expensePath))).data()?.createdBy).toEqual({ id: owner.user.uid, displayName: 'Deleted user' })
    expect(pick((await getDoc(doc(db, settlementPath))).data()!, ['money', 'senderId', 'recipientId', 'basis'])).toEqual(preservedSettlementLedger)
    expect((await getDoc(doc(db, balancePath))).data()).toEqual(preservedBalance)
    expect((await getDoc(doc(db, `groups/${created.groupId}/members/${owner.user.uid}`))).data()).toMatchObject({
      status: 'removed', displayName: 'Deleted user', initials: 'DU', accountStatus: 'deleted',
    })
    expect((await getDoc(doc(db, `groups/${created.groupId}/recurringTemplates/${expense.expense.recurringTemplateId}`))).data()).toMatchObject({ status: 'cancelled' })
    expect((await getDoc(doc(db, `groups/${created.groupId}/settings/defaults`))).data()).not.toHaveProperty('defaultSplit')
    expect((await getDoc(doc(db, `groups/${created.groupId}/comments/${comment.comment.commentId}`))).data()).toMatchObject({
      author: { id: owner.user.uid, displayName: 'Deleted user' }, body: 'Comment removed with deleted account', attachmentRefs: [],
    })
    expect((await getDoc(doc(db, `invitations/${activeInvitation.invitationId}`))).exists()).toBe(false)
    expect((await getDoc(doc(db, `users/${friend.user.uid}/groups/${created.groupId}`))).data()).toMatchObject({ contextLabel: 'Deletion Ledger' })
  }, 45_000)

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

    const originalExpense = await ownerRepository.expenses.add({
      kind: 'expense.add', operationId: `conversion-source-${suffix}`, groupId: created.groupId, description: 'Euro preview dinner', date: '2026-09-01',
      total: { currency: 'USD', minorAmount: 10_000 },
      payments: [{ participantId: owner.user.uid, money: { currency: 'USD', minorAmount: 10_000 } }],
      allocations: [
        { participantId: owner.user.uid, money: { currency: 'USD', minorAmount: 5_000 } },
        { participantId: friend.user.uid, money: { currency: 'USD', minorAmount: 5_000 } },
      ],
      category: 'Food', splitMethod: { type: 'equal', participantIds: [owner.user.uid, friend.user.uid] }, attachmentRefs: [],
    })
    if (originalExpense.status !== 'saved') throw new Error(originalExpense.reason)
    const conversionCommand = {
      kind: 'group.currency-conversion' as const, operationId: `currency-${suffix}`, groupId: created.groupId, expectedRevision: 3, targetCurrency: 'EUR' as const,
      rates: [{
        baseCurrency: 'USD' as const, quoteCurrency: 'EUR' as const, numerator: 1, denominator: 2,
        authority: 'European Central Bank via Frankfurter', effectiveDate: '2026-08-29', observedAt: '2026-09-01T11:59:00.000Z',
      }],
    }
    const converted = await ownerRepository.groups.convertCurrencies(conversionCommand).catch((reason) => { throw new Error(`Conversion command failed: ${String(reason)}`) })
    await expect(ownerRepository.groups.convertCurrencies(conversionCommand)).resolves.toEqual(converted)
    await expect(ownerRepository.groups.getSettings(created.groupId)).resolves.toMatchObject({ revision: 4, currencyConversion: { targetCurrency: 'EUR', rates: conversionCommand.rates } })
    await expect(ownerRepository.expenses.getById(created.groupId, originalExpense.expense.id)).resolves.toMatchObject({
      total: { currency: 'EUR', minorAmount: 5_000 }, currencyConversion: { sourceMoney: { currency: 'USD', minorAmount: 10_000 } },
    })

    const postConversionDefault = {
      kind: 'group.default-split' as const, operationId: `post-conversion-default-${suffix}`, groupId: created.groupId,
      expectedRevision: 4, defaultSplit: { type: 'equal' as const, participantIds: [owner.user.uid, friend.user.uid] },
    }
    await expect(ownerRepository.groups.setDefaultSplit(postConversionDefault)).resolves.toMatchObject({ status: 'saved' })
    await expect(ownerRepository.groups.getSettings(created.groupId)).resolves.toMatchObject({
      revision: 5, defaultSplit: postConversionDefault.defaultSplit,
      currencyConversion: { targetCurrency: 'EUR', rates: conversionCommand.rates },
    })
    await expect(ownerRepository.expenses.getById(created.groupId, originalExpense.expense.id)).resolves.toMatchObject({
      total: { currency: 'EUR', minorAmount: 5_000 }, currencyConversion: { sourceMoney: { currency: 'USD', minorAmount: 10_000 } },
    })

    const laterExpense = await ownerRepository.expenses.add({
      kind: 'expense.add', operationId: `conversion-later-${suffix}`, groupId: created.groupId, description: 'Later USD taxi', date: '2026-09-02',
      total: { currency: 'USD', minorAmount: 2_000 },
      payments: [{ participantId: owner.user.uid, money: { currency: 'USD', minorAmount: 2_000 } }],
      allocations: [
        { participantId: owner.user.uid, money: { currency: 'USD', minorAmount: 1_000 } },
        { participantId: friend.user.uid, money: { currency: 'USD', minorAmount: 1_000 } },
      ],
      category: 'Transport', splitMethod: { type: 'equal', participantIds: [owner.user.uid, friend.user.uid] }, attachmentRefs: [],
    }).catch((reason) => { throw new Error(`Post-conversion expense failed: ${String(reason)}`) })
    if (laterExpense.status !== 'saved') throw new Error(laterExpense.reason)
    await expect(ownerRepository.expenses.getById(created.groupId, laterExpense.expense.id)).resolves.toMatchObject({ total: { currency: 'USD', minorAmount: 2_000 } })

    await signOut(auth)
    await signInWithEmailAndPassword(auth, friendEmail, password)
    const friendConvertedRepository = createFirebaseRepository(configuration, friend.user.uid)
    await expect(friendConvertedRepository.expenses.getById(created.groupId, originalExpense.expense.id)).resolves.toMatchObject({ total: { currency: 'EUR', minorAmount: 5_000 } })
    await expect(friendConvertedRepository.groups.convertCurrencies({ ...conversionCommand, operationId: `friend-currency-${suffix}`, expectedRevision: 5 })).rejects.toThrow(/manager/i)
  }, 30_000)

  emulatorIt('soft-removes an uninvolved member as one replay-safe group bundle', async () => {
    const auth = getAuth(app)
    const suffix = crypto.randomUUID()
    const ownerEmail = `removal-owner-${suffix}@example.com`
    const friendEmail = `removal-friend-${suffix}@example.com`
    const password = 'SplitUnwise-Test-42!'
    const owner = await createUserWithEmailAndPassword(auth, ownerEmail, password)
    await updateProfile(owner.user, { displayName: 'Removal Owner' })
    await bootstrapFirebaseProfile(configuration, owner.user)
    await synchronizeFirebaseProfile(configuration, owner.user)
    const created = await createSparkGroup(configuration, { operationId: `removal-${suffix}`, name: 'Removal Group', currency: 'USD' })
    const invitation = await createSparkInvitation(configuration, { groupId: created.groupId, canonicalOrigin: 'https://split-unwise-aditya.web.app' })
    const token = new URL(invitation.link).hash.slice('#token='.length)

    await signOut(auth)
    const friend = await createUserWithEmailAndPassword(auth, friendEmail, password)
    await updateProfile(friend.user, { displayName: 'Removal Friend' })
    await bootstrapFirebaseProfile(configuration, friend.user)
    await synchronizeFirebaseProfile(configuration, friend.user)
    await acceptSparkInvitation(configuration, invitation.invitationId, token)
    await signOut(auth)
    await signInWithEmailAndPassword(auth, ownerEmail, password)

    const repository = createFirebaseRepository(configuration, owner.user.uid)
    await repository.groups.setDefaultSplit({
      kind: 'group.default-split', operationId: `removal-default-${suffix}`, groupId: created.groupId, expectedRevision: 1,
      defaultSplit: { type: 'equal', participantIds: [owner.user.uid, friend.user.uid] },
    })

    const db = getFirestore(app)
    const groupReference = doc(db, `groups/${created.groupId}`)
    const targetReference = doc(db, `groups/${created.groupId}/members/${friend.user.uid}`)
    const projectionReference = doc(db, `users/${friend.user.uid}/groups/${created.groupId}`)
    const settingsReference = doc(db, `groups/${created.groupId}/settings/defaults`)
    const [groupSnapshot, targetSnapshot, settingsSnapshot] = await Promise.all([
      getDoc(groupReference), getDoc(targetReference), getDoc(settingsReference),
    ])
    const forgedOperationId = `forged-remove-${suffix}`
    const forgedToken = 'f'.repeat(48)
    const forgedFingerprint = 'e'.repeat(64)
    const forgedBatch = writeBatch(db)
    forgedBatch.set(groupReference, {
      ...groupSnapshot.data(), memberIds: [owner.user.uid], updatedAt: serverTimestamp(),
      lastMembershipCommandKind: 'group.member-remove', lastMembershipOperationId: forgedOperationId,
      lastMembershipRequestFingerprint: forgedFingerprint, lastMembershipResourceToken: forgedToken,
      lastRemovedMemberId: friend.user.uid,
    })
    forgedBatch.set(targetReference, {
      ...targetSnapshot.data(), status: 'removed', removedByUid: owner.user.uid, removedAt: serverTimestamp(),
      lastCommandKind: 'group.member-remove', lastOperationId: forgedOperationId,
      lastRequestFingerprint: forgedFingerprint, lastResourceToken: forgedToken,
    })
    forgedBatch.update(projectionReference, {
      status: 'removed', removedByUid: owner.user.uid, removedAt: serverTimestamp(), updatedAt: serverTimestamp(),
    })
    forgedBatch.set(settingsReference, {
      ...settingsSnapshot.data(), revision: Number(settingsSnapshot.data()?.revision) + 1,
      defaultSplit: { type: 'equal', participantIds: [owner.user.uid] },
      lastCommandKind: 'group.member-remove', lastOperationId: forgedOperationId,
      lastRequestFingerprint: forgedFingerprint, lastResourceToken: forgedToken,
      updatedAt: serverTimestamp(), updatedBy: { id: owner.user.uid, displayName: 'Removal Owner' },
    })
    forgedBatch.set(doc(db, `groups/${created.groupId}/activity/activity-${forgedToken}`), {
      groupId: created.groupId, operationId: forgedOperationId, kind: 'membership.changed',
      subject: { kind: 'membership', id: friend.user.uid, label: 'Removal Friend removed' },
      actor: { id: owner.user.uid, displayName: 'Removal Owner' }, createdAt: serverTimestamp(),
    })
    await expect(forgedBatch.commit()).rejects.toThrow(/permission/i)

    const command = { kind: 'group.member-remove' as const, operationId: `remove-${suffix}`, groupId: created.groupId, targetMemberId: friend.user.uid }

    const saved = await repository.groups.removeMember(command)
    await expect(repository.groups.removeMember(command)).resolves.toEqual(saved)

    expect(saved).toEqual({ kind: command.kind, operationId: command.operationId, status: 'saved', resourceId: friend.user.uid })
    await expect(repository.groups.listMembers(created.groupId)).resolves.toEqual([expect.objectContaining({ id: owner.user.uid, role: 'owner' })])
    await expect(repository.groups.getSettings(created.groupId)).resolves.toMatchObject({ revision: 3 })
    expect((await repository.groups.getSettings(created.groupId)).defaultSplit).toBeUndefined()
    await expect(repository.activity.listForGroup(created.groupId)).resolves.toContainEqual(expect.objectContaining({
      operationId: command.operationId, kind: 'membership.changed', subject: { kind: 'membership', id: friend.user.uid, label: 'Removal Friend removed' },
    }))

    await signOut(auth)
    await signInWithEmailAndPassword(auth, friendEmail, password)
    const removedRepository = createFirebaseRepository(configuration, friend.user.uid)
    await expect(removedRepository.groups.list()).resolves.toEqual([])
    expect((await getDoc(doc(getFirestore(app), `users/${friend.user.uid}/groups/${created.groupId}`))).data()).toMatchObject({ status: 'removed' })
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
      category: 'Food', splitMethod: { type: 'equal' as const, participantIds: [owner.user.uid, friend.user.uid] }, reimbursement: true as const, attachmentRefs: [],
    }
    const first = await ownerRepository.expenses.add(command)
    const replay = await ownerRepository.expenses.add(command)

    expect(first).toMatchObject({ kind: 'expense.add', operationId, status: 'saved', expense: { description: 'Shared dinner', reimbursement: true, revision: 1 } })
    expect(replay).toEqual(first)
    if (first.status !== 'saved') throw new Error('Expected Spark expense creation to save')
    expect(await ownerRepository.expenses.listForGroup(created.groupId)).toHaveLength(1)
    expect(await ownerRepository.groups.getBalanceSnapshot(created.groupId)).toMatchObject({
      groupId: created.groupId, balanceRevision: 1,
      pairwise: [{ fromParticipantId: owner.user.uid, toParticipantId: friend.user.uid, money: { currency: 'USD', minorAmount: 1200 } }],
      simplified: [{ fromParticipantId: owner.user.uid, toParticipantId: friend.user.uid, money: { currency: 'USD', minorAmount: 1200 } }],
    })

    await signOut(auth)
    await signInWithEmailAndPassword(auth, friendEmail, password)
    const friendRepository = createFirebaseRepository(configuration, friend.user.uid)
    await expect(friendRepository.expenses.listForGroup(created.groupId)).resolves.toEqual([
      expect.objectContaining({ description: 'Shared dinner', reimbursement: true, total: { currency: 'USD', minorAmount: 2400 } }),
    ])
    await expect(friendRepository.activity.listForAccount({ filter: 'expenses', limit: 20 })).resolves.toMatchObject({
      items: [{ kind: 'expense.created', operationId, expenseId: first.expense.id, revision: 1, subject: { kind: 'expense', id: first.expense.id, label: 'Shared dinner' } }],
    })
    await expect(friendRepository.groups.getBalanceSnapshot(created.groupId)).resolves.toMatchObject({
      simplified: [{ fromParticipantId: owner.user.uid, toParticipantId: friend.user.uid, money: { currency: 'USD', minorAmount: 1200 } }],
    })

    const editCommand = {
      kind: 'expense.edit' as const, operationId: `friend-edit-${suffix}`, groupId: created.groupId, expenseId: first.expense.id, expectedRevision: 1,
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
    const edited = await friendRepository.expenses.edit(editCommand)
    const editReplay = await friendRepository.expenses.edit(editCommand)
    expect(edited).toMatchObject({
      status: 'saved',
      expense: {
        id: first.expense.id, description: 'Shared dinner and dessert', revision: 2,
        createdBy: { id: owner.user.uid, displayName: 'Ledger Owner' },
        updatedBy: { id: friend.user.uid, displayName: 'Ledger Friend' },
      },
    })
    expect(edited.status === 'saved' ? edited.expense : undefined).not.toHaveProperty('reimbursement')
    expect(editReplay).toEqual(edited)

    await signOut(auth)
    await signInWithEmailAndPassword(auth, ownerEmail, password)
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

    const deleteCommand = { kind: 'expense.delete' as const, operationId: `delete-${suffix}`, groupId: created.groupId, expenseId: first.expense.id, expectedRevision: 2 }
    const removed = await friendRepository.expenses.delete(deleteCommand)
    const deleteReplay = await friendRepository.expenses.delete(deleteCommand)
    expect(removed).toMatchObject({ status: 'saved', tombstone: { id: first.expense.id, groupId: created.groupId, revision: 3 } })
    expect(deleteReplay).toEqual(removed)
    await expect(friendRepository.expenses.listForGroup(created.groupId)).resolves.toEqual([])
    await expect(friendRepository.expenses.getById(created.groupId, first.expense.id)).resolves.toMatchObject({
      revision: 3, deletedAt: expect.any(String), createdBy: { id: owner.user.uid }, updatedBy: { id: friend.user.uid },
    })
    await expect(friendRepository.groups.getBalanceSnapshot(created.groupId)).resolves.toMatchObject({ balanceRevision: 3, pairwise: [], simplified: [] })
    await expect(friendRepository.expenses.listRevisions(created.groupId, first.expense.id)).resolves.toMatchObject([
      { revision: 1, action: 'created', actor: { id: owner.user.uid } },
      { revision: 2, action: 'updated', actor: { id: friend.user.uid } },
      { revision: 3, action: 'deleted', actor: { id: friend.user.uid } },
    ])
    const expenseActivity = (await friendRepository.activity.listForGroup(created.groupId))
      .filter(({ kind }) => kind === 'expense.created' || kind === 'expense.updated' || kind === 'expense.deleted')
      .map(({ kind, operationId: activityOperationId, expenseId, revision, subject }) => ({ kind, operationId: activityOperationId, expenseId, revision, subject }))
    expect(expenseActivity).toEqual([
      { kind: 'expense.created', operationId, expenseId: first.expense.id, revision: 1, subject: { kind: 'expense', id: first.expense.id, label: 'Shared dinner' } },
      { kind: 'expense.updated', operationId: editCommand.operationId, expenseId: first.expense.id, revision: 2, subject: { kind: 'expense', id: first.expense.id, label: 'Shared dinner and dessert' } },
      { kind: 'expense.deleted', operationId: deleteCommand.operationId, expenseId: first.expense.id, revision: 3, subject: { kind: 'expense', id: first.expense.id, label: 'Shared dinner and dessert' } },
    ])

    const restoreCommand = { kind: 'expense.restore' as const, operationId: `restore-${suffix}`, groupId: created.groupId, expenseId: first.expense.id, expectedRevision: 3 }
    const restored = await friendRepository.expenses.restore(restoreCommand)
    await expect(friendRepository.expenses.restore(restoreCommand)).resolves.toEqual(restored)
    expect(restored).toMatchObject({ status: 'saved', expense: { id: first.expense.id, revision: 4, updatedBy: { id: friend.user.uid } } })
    if (restored.status !== 'saved') throw new Error('Expected Spark expense restoration to save')
    expect(restored.expense.deletedAt).toBeUndefined()
    await expect(friendRepository.expenses.listForGroup(created.groupId)).resolves.toEqual([
      expect.objectContaining({ id: first.expense.id, revision: 4 }),
    ])
    await expect(friendRepository.groups.getBalanceSnapshot(created.groupId)).resolves.toMatchObject({
      balanceRevision: 4,
      simplified: [{ fromParticipantId: friend.user.uid, toParticipantId: owner.user.uid, money: { currency: 'USD', minorAmount: 1500 } }],
    })
    const restoredRevisions = await friendRepository.expenses.listRevisions(created.groupId, first.expense.id)
    expect(restoredRevisions).toMatchObject([
      { revision: 1, action: 'created' },
      { revision: 2, action: 'updated' },
      { revision: 3, action: 'deleted' },
      { revision: 4, action: 'restored', operationId: restoreCommand.operationId },
    ])
    expect(restoredRevisions.at(-1)?.expense.deletedAt).toBeUndefined()
    await expect(friendRepository.activity.listForGroup(created.groupId)).resolves.toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'expense.restored', operationId: restoreCommand.operationId, expenseId: first.expense.id, revision: 4 }),
    ]))
  }, 30_000)

  emulatorIt('atomically moves an ordinary expense between two shared contexts while preserving the source audit', async () => {
    const auth = getAuth(app)
    const suffix = crypto.randomUUID()
    const ownerEmail = `move-owner-${suffix}@example.com`
    const friendEmail = `move-friend-${suffix}@example.com`
    const password = 'SplitUnwise-Test-42!'
    const owner = await createUserWithEmailAndPassword(auth, ownerEmail, password)
    await updateProfile(owner.user, { displayName: 'Move Owner' })
    await bootstrapFirebaseProfile(configuration, owner.user)
    await synchronizeFirebaseProfile(configuration, owner.user)
    const source = await createSparkGroup(configuration, { operationId: `move-source-${suffix}`, name: 'Move Source', currency: 'USD' })
    const target = await createSparkGroup(configuration, { operationId: `move-target-${suffix}`, name: 'Move Target', currency: 'USD' })
    const privateTarget = await createSparkGroup(configuration, { operationId: `move-private-${suffix}`, name: 'Private Target', currency: 'USD' })
    const sourceInvitation = await createSparkInvitation(configuration, { groupId: source.groupId, canonicalOrigin: 'https://split-unwise-aditya.web.app' })
    const targetInvitation = await createSparkInvitation(configuration, { groupId: target.groupId, canonicalOrigin: 'https://split-unwise-aditya.web.app' })

    await signOut(auth)
    const friend = await createUserWithEmailAndPassword(auth, friendEmail, password)
    await updateProfile(friend.user, { displayName: 'Move Friend' })
    await bootstrapFirebaseProfile(configuration, friend.user)
    await synchronizeFirebaseProfile(configuration, friend.user)
    await acceptSparkInvitation(configuration, sourceInvitation.invitationId, new URL(sourceInvitation.link).hash.slice('#token='.length))
    await acceptSparkInvitation(configuration, targetInvitation.invitationId, new URL(targetInvitation.link).hash.slice('#token='.length))
    await signOut(auth)
    await signInWithEmailAndPassword(auth, ownerEmail, password)

    const ownerRepository = createFirebaseRepository(configuration, owner.user.uid)
    const added = await ownerRepository.expenses.add({
      kind: 'expense.add', operationId: `move-expense-${suffix}`, groupId: source.groupId, description: 'Train tickets', date: '2026-09-01',
      total: { currency: 'USD', minorAmount: 4000 }, payments: [{ participantId: owner.user.uid, money: { currency: 'USD', minorAmount: 4000 } }],
      allocations: [
        { participantId: owner.user.uid, money: { currency: 'USD', minorAmount: 2000 } },
        { participantId: friend.user.uid, money: { currency: 'USD', minorAmount: 2000 } },
      ],
      category: 'Transport', splitMethod: { type: 'equal', participantIds: [owner.user.uid, friend.user.uid] }, attachmentRefs: [],
    })
    if (added.status !== 'saved') throw new Error('Expected the source expense to save')

    await signOut(auth)
    await signInWithEmailAndPassword(auth, friendEmail, password)
    const friendRepository = createFirebaseRepository(configuration, friend.user.uid)
    const moveDraft = {
      groupId: target.groupId, description: 'Train tickets to Milwaukee', date: '2026-09-01',
      total: { currency: 'USD' as const, minorAmount: 4000 }, payments: [{ participantId: owner.user.uid, money: { currency: 'USD' as const, minorAmount: 4000 } }],
      allocations: [
        { participantId: owner.user.uid, money: { currency: 'USD' as const, minorAmount: 2000 } },
        { participantId: friend.user.uid, money: { currency: 'USD' as const, minorAmount: 2000 } },
      ],
      category: 'Transport', splitMethod: { type: 'equal' as const, participantIds: [owner.user.uid, friend.user.uid] }, attachmentRefs: [],
    }
    await expect(friendRepository.expenses.edit({
      kind: 'expense.edit', operationId: `move-denied-${suffix}`, groupId: source.groupId,
      expenseId: added.expense.id, expectedRevision: 1, draft: { ...moveDraft, groupId: privateTarget.groupId },
    })).rejects.toThrow(/active.*target|target.*member/i)
    const sourceAfterDeniedMove = await friendRepository.expenses.getById(source.groupId, added.expense.id)
    expect(sourceAfterDeniedMove).toMatchObject({ revision: 1 })
    expect(sourceAfterDeniedMove?.deletedAt).toBeUndefined()

    const moveCommand = {
      kind: 'expense.edit' as const, operationId: `move-shared-${suffix}`, groupId: source.groupId,
      expenseId: added.expense.id, expectedRevision: 1, draft: moveDraft,
    }
    const moved = await friendRepository.expenses.edit(moveCommand)
    await expect(friendRepository.expenses.edit(moveCommand)).resolves.toEqual(moved)
    expect(moved).toMatchObject({
      status: 'saved', expense: {
        groupId: target.groupId, description: moveDraft.description, revision: 1,
        createdBy: { id: friend.user.uid }, updatedBy: { id: friend.user.uid },
      },
    })
    if (moved.status !== 'saved') throw new Error('Expected the move to save')
    expect(moved.expense.id).not.toBe(added.expense.id)
    await expect(friendRepository.expenses.listForGroup(source.groupId)).resolves.toEqual([])
    await expect(friendRepository.expenses.getById(source.groupId, added.expense.id)).resolves.toMatchObject({
      revision: 2, deletedAt: expect.any(String), createdBy: { id: owner.user.uid }, updatedBy: { id: friend.user.uid },
    })
    await expect(friendRepository.expenses.listForGroup(target.groupId)).resolves.toEqual([
      expect.objectContaining({ id: moved.expense.id, description: moveDraft.description, revision: 1 }),
    ])
    await expect(friendRepository.groups.getBalanceSnapshot(source.groupId)).resolves.toMatchObject({ pairwise: [], simplified: [] })
    await expect(friendRepository.groups.getBalanceSnapshot(target.groupId)).resolves.toMatchObject({
      simplified: [{ fromParticipantId: friend.user.uid, toParticipantId: owner.user.uid, money: { currency: 'USD', minorAmount: 2000 } }],
    })
    await expect(friendRepository.expenses.listRevisions(source.groupId, added.expense.id)).resolves.toMatchObject([
      { revision: 1, action: 'created', actor: { id: owner.user.uid } },
      { revision: 2, action: 'deleted', actor: { id: friend.user.uid } },
    ])
    await expect(friendRepository.expenses.listRevisions(target.groupId, moved.expense.id)).resolves.toMatchObject([
      { revision: 1, action: 'created', actor: { id: friend.user.uid } },
    ])
    await expect(friendRepository.activity.listForGroup(source.groupId)).resolves.toEqual(expect.arrayContaining([
      expect.objectContaining({ operationId: moveCommand.operationId, kind: 'expense.deleted', expenseId: added.expense.id }),
    ]))
    await expect(friendRepository.activity.listForGroup(target.groupId)).resolves.toEqual(expect.arrayContaining([
      expect.objectContaining({ operationId: `${moveCommand.operationId}.move-target`, kind: 'expense.created', expenseId: moved.expense.id }),
    ]))
  }, 45_000)

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

  emulatorIt('lets any active member materialize another creator series while preserving creator and audit provenance', async () => {
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
    await expect(friendRepository.groups.materializeDue(created.groupId, '2026-10-01')).resolves.toMatchObject({
      occurrences: [{
        id: `occ_${templateId}_2026-10-01`,
        createdBy: { id: owner.user.uid, displayName: 'Recurrence Owner' },
        updatedBy: { id: friend.user.uid, displayName: 'Recurrence Friend' },
      }],
      moreRemain: false,
    })
    await expect(friendRepository.commands.execute({
      kind: 'recurrence.materialize', operationId: `friend-replay-initial-${suffix}`, groupId: created.groupId, templateId, occurrenceDate: '2026-10-01',
    })).resolves.toMatchObject({ status: 'saved', occurrence: { id: `occ_${templateId}_2026-10-01`, createdBy: { id: owner.user.uid }, updatedBy: { id: friend.user.uid } } })

    await signOut(auth)
    await signInWithEmailAndPassword(auth, ownerEmail, password)
    const firstRace = ownerRepository.commands.execute({
      kind: 'recurrence.materialize', operationId: `race-a-${suffix}`, groupId: created.groupId, templateId, occurrenceDate: '2026-10-01',
    })
    const secondRace = ownerRepository.commands.execute({
      kind: 'recurrence.materialize', operationId: `race-b-${suffix}`, groupId: created.groupId, templateId, occurrenceDate: '2026-10-01',
    })
    const [first, second] = await Promise.all([firstRace, secondRace])
    expect(first).toMatchObject({ status: 'saved', occurrence: { id: `occ_${templateId}_2026-10-01` } })
    expect(second).toMatchObject({ status: 'saved', occurrence: { id: `occ_${templateId}_2026-10-01` } })
    await expect(ownerRepository.groups.listRecurring(created.groupId)).resolves.toEqual([
      expect.objectContaining({ id: templateId, nextDate: '2026-11-01', revision: 2, lastOccurrenceDate: '2026-10-01' }),
    ])
    const recurringExpenses = (await ownerRepository.expenses.listForGroup(created.groupId)).filter(({ recurringTemplateId }) => recurringTemplateId === templateId)
    expect(recurringExpenses).toHaveLength(2)
    expect(recurringExpenses.find(({ id }) => id === `occ_${templateId}_2026-10-01`)).toMatchObject({
      createdBy: { id: owner.user.uid, displayName: 'Recurrence Owner' },
      updatedBy: { id: friend.user.uid, displayName: 'Recurrence Friend' },
    })
    await expect(ownerRepository.groups.getBalanceSnapshot(created.groupId)).resolves.toMatchObject({
      pairwise: [{ fromParticipantId: friend.user.uid, toParticipantId: owner.user.uid, money: { currency: 'USD', minorAmount: 2000 } }],
    })
    expect((await ownerRepository.activity.listForGroup(created.groupId)).filter(({ expenseId }) => expenseId === `occ_${templateId}_2026-10-01`)).toHaveLength(1)

    await signOut(auth)
    await signInWithEmailAndPassword(auth, friendEmail, password)
    await expect(friendRepository.commands.execute({
      kind: 'recurrence.materialize', operationId: `friend-replay-${suffix}`, groupId: created.groupId, templateId, occurrenceDate: '2026-10-01',
    })).resolves.toMatchObject({ status: 'saved', occurrence: { id: `occ_${templateId}_2026-10-01`, createdBy: { id: owner.user.uid }, updatedBy: { id: friend.user.uid } } })
    expect((await friendRepository.activity.listForGroup(created.groupId)).filter(({ expenseId }) => expenseId === `occ_${templateId}_2026-10-01`)).toHaveLength(1)

    const creatorSeries = await friendRepository.expenses.add({
      kind: 'expense.add', operationId: `friend-series-${suffix}`, groupId: created.groupId, description: 'Creator-owned storage', date: '2026-09-15',
      total: { currency: 'USD' as const, minorAmount: 1600 }, payments: [{ participantId: friend.user.uid, money: { currency: 'USD' as const, minorAmount: 1600 } }],
      allocations: [
        { participantId: owner.user.uid, money: { currency: 'USD' as const, minorAmount: 800 } },
        { participantId: friend.user.uid, money: { currency: 'USD' as const, minorAmount: 800 } },
      ],
      category: 'Housing', splitMethod: { type: 'equal' as const, participantIds: [owner.user.uid, friend.user.uid] }, attachmentRefs: [],
      recurrence: { frequency: 'monthly' as const, anchor: { month: 9, day: 15 }, timeZone: 'America/Chicago' },
    })
    if (creatorSeries.status !== 'saved' || !creatorSeries.expense.recurringTemplateId) throw new Error('Expected friend-owned recurring series')
    const creatorTemplateId = creatorSeries.expense.recurringTemplateId
    const managerMaterialize = {
      kind: 'recurrence.materialize' as const, operationId: `manager-materialize-${suffix}`, groupId: created.groupId,
      templateId: creatorTemplateId, occurrenceDate: '2026-10-15',
    }

    await signOut(auth)
    await signInWithEmailAndPassword(auth, ownerEmail, password)
    const managerMaterialized = await ownerRepository.commands.execute(managerMaterialize)
    if (managerMaterialized.kind !== 'recurrence.materialize' || managerMaterialized.status !== 'saved') throw new Error('Expected manager materialization')
    expect(managerMaterialized.occurrence).toMatchObject({
      createdBy: { id: friend.user.uid, displayName: 'Recurrence Friend' },
      updatedBy: { id: owner.user.uid, displayName: 'Recurrence Owner' },
    })

    await signOut(auth)
    await signInWithEmailAndPassword(auth, friendEmail, password)
    const editedOccurrence = await friendRepository.expenses.edit({
      kind: 'expense.edit', operationId: `creator-occurrence-edit-${suffix}`, groupId: created.groupId,
      expenseId: managerMaterialized.occurrence.id, expectedRevision: 1,
      draft: {
        groupId: created.groupId, description: 'Creator-adjusted storage', date: '2026-10-16',
        total: { currency: 'USD' as const, minorAmount: 1600 }, payments: [{ participantId: friend.user.uid, money: { currency: 'USD' as const, minorAmount: 1600 } }],
        allocations: [
          { participantId: owner.user.uid, money: { currency: 'USD' as const, minorAmount: 800 } },
          { participantId: friend.user.uid, money: { currency: 'USD' as const, minorAmount: 800 } },
        ],
        category: 'Housing', splitMethod: { type: 'equal' as const, participantIds: [owner.user.uid, friend.user.uid] }, attachmentRefs: [],
        occurrenceEditScope: 'occurrence' as const,
      },
    })
    expect(editedOccurrence).toMatchObject({ status: 'saved', expense: { revision: 2, updatedBy: { id: friend.user.uid } } })

    await signOut(auth)
    await signInWithEmailAndPassword(auth, ownerEmail, password)
    const managerReplayRepository = createFirebaseRepository(configuration, owner.user.uid)
    await expect(managerReplayRepository.commands.execute(managerMaterialize)).resolves.toMatchObject({
      status: 'saved', occurrence: { id: managerMaterialized.occurrence.id, description: 'Creator-adjusted storage', revision: 2 },
    })
    await expect(managerReplayRepository.expenses.listRevisions(created.groupId, managerMaterialized.occurrence.id)).resolves.toMatchObject([
      {
        revision: 1, action: 'created', actor: { id: owner.user.uid, displayName: 'Recurrence Owner' },
        expense: { createdBy: { id: friend.user.uid, displayName: 'Recurrence Friend' }, updatedBy: { id: owner.user.uid, displayName: 'Recurrence Owner' } },
      },
      { revision: 2, action: 'updated', actor: { id: friend.user.uid, displayName: 'Recurrence Friend' } },
    ])
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

  emulatorIt('deletes a shared group for both accounts and restores its exact expense and payment ledger', async () => {
    const auth = getAuth(app)
    const suffix = crypto.randomUUID()
    const ownerEmail = `lifecycle-owner-${suffix}@example.com`
    const friendEmail = `lifecycle-friend-${suffix}@example.com`
    const password = 'SplitUnwise-Test-42!'

    const owner = await createUserWithEmailAndPassword(auth, ownerEmail, password)
    await updateProfile(owner.user, { displayName: 'Lifecycle Owner' })
    await bootstrapFirebaseProfile(configuration, owner.user)
    await synchronizeFirebaseProfile(configuration, owner.user)
    const created = await createSparkGroup(configuration, { operationId: `lifecycle-${suffix}`, name: 'Recoverable Trip', currency: 'USD' })
    const invitation = await createSparkInvitation(configuration, { groupId: created.groupId, canonicalOrigin: 'https://split-unwise-aditya.web.app' })
    const token = new URL(invitation.link).hash.slice('#token='.length)

    await signOut(auth)
    const friend = await createUserWithEmailAndPassword(auth, friendEmail, password)
    await updateProfile(friend.user, { displayName: 'Lifecycle Friend' })
    await bootstrapFirebaseProfile(configuration, friend.user)
    await synchronizeFirebaseProfile(configuration, friend.user)
    await acceptSparkInvitation(configuration, invitation.invitationId, token)

    await signOut(auth)
    await signInWithEmailAndPassword(auth, ownerEmail, password)
    const ownerRepository = createFirebaseRepository(configuration, owner.user.uid)
    await ownerRepository.expenses.add({
      kind: 'expense.add', operationId: `lifecycle-expense-${suffix}`, groupId: created.groupId, description: 'Train tickets', date: '2026-09-01',
      total: { currency: 'USD', minorAmount: 2000 }, payments: [{ participantId: owner.user.uid, money: { currency: 'USD', minorAmount: 2000 } }],
      allocations: [
        { participantId: owner.user.uid, money: { currency: 'USD', minorAmount: 1000 } },
        { participantId: friend.user.uid, money: { currency: 'USD', minorAmount: 1000 } },
      ],
      category: 'Transport', splitMethod: { type: 'equal', participantIds: [owner.user.uid, friend.user.uid] }, attachmentRefs: [],
    })
    await ownerRepository.settlements.record({
      kind: 'settlement.record', operationId: `lifecycle-payment-${suffix}`, groupId: created.groupId, expectedBalanceRevision: 1,
      basis: { kind: 'simplified', senderId: friend.user.uid, recipientId: owner.user.uid, currency: 'USD', debtMinor: 1000 },
      money: { currency: 'USD', minorAmount: 400 }, method: 'cash', occurredOn: '2026-09-01', outsidePaymentConfirmed: true,
    })
    const beforeExpenses = await ownerRepository.expenses.listForGroup(created.groupId)
    const beforeSettlements = await ownerRepository.settlements.listForGroup(created.groupId)

    await signOut(auth)
    await signInWithEmailAndPassword(auth, friendEmail, password)
    const friendRepository = createFirebaseRepository(configuration, friend.user.uid)
    await expect(friendRepository.groups.list()).resolves.toContainEqual(expect.objectContaining({ id: created.groupId }))
    await expect(friendRepository.commands.execute({ kind: 'group.delete', operationId: `friend-delete-${suffix}`, groupId: created.groupId })).rejects.toThrow(/manager/i)

    await signOut(auth)
    await signInWithEmailAndPassword(auth, ownerEmail, password)
    const deleteCommand = { kind: 'group.delete' as const, operationId: `delete-${suffix}`, groupId: created.groupId }
    const deleted = await ownerRepository.commands.execute(deleteCommand)
    await expect(ownerRepository.commands.execute(deleteCommand)).resolves.toEqual(deleted)
    await expect(ownerRepository.groups.list()).resolves.not.toContainEqual(expect.objectContaining({ id: created.groupId }))
    await expect(ownerRepository.groups.getById(created.groupId)).resolves.toBeUndefined()

    await signOut(auth)
    await signInWithEmailAndPassword(auth, friendEmail, password)
    await expect(friendRepository.groups.list()).resolves.not.toContainEqual(expect.objectContaining({ id: created.groupId }))
    await expect(friendRepository.groups.getById(created.groupId)).resolves.toBeUndefined()
    await expect(friendRepository.activity.listForAccount({ filter: 'all', limit: 100 })).resolves.toMatchObject({
      items: expect.arrayContaining([expect.objectContaining({ kind: 'group.deleted', operationId: deleteCommand.operationId })]),
    })
    await expect(friendRepository.commands.execute({ kind: 'group.restore', operationId: `friend-restore-${suffix}`, groupId: created.groupId })).rejects.toThrow(/manager/i)

    await signOut(auth)
    await signInWithEmailAndPassword(auth, ownerEmail, password)
    const restoreCommand = { kind: 'group.restore' as const, operationId: `restore-${suffix}`, groupId: created.groupId }
    const restored = await ownerRepository.commands.execute(restoreCommand)
    await expect(ownerRepository.commands.execute(restoreCommand)).resolves.toEqual(restored)
    await expect(ownerRepository.groups.list()).resolves.toContainEqual(expect.objectContaining({ id: created.groupId, name: 'Recoverable Trip' }))
    await expect(ownerRepository.expenses.listForGroup(created.groupId)).resolves.toEqual(beforeExpenses)
    await expect(ownerRepository.settlements.listForGroup(created.groupId)).resolves.toEqual(beforeSettlements)
    await expect(ownerRepository.activity.listForGroup(created.groupId)).resolves.toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'group.deleted', operationId: deleteCommand.operationId }),
      expect.objectContaining({ kind: 'group.restored', operationId: restoreCommand.operationId }),
    ]))

    await signOut(auth)
    await signInWithEmailAndPassword(auth, friendEmail, password)
    await expect(friendRepository.groups.list()).resolves.toContainEqual(expect.objectContaining({ id: created.groupId }))
    await expect(friendRepository.expenses.listForGroup(created.groupId)).resolves.toEqual(beforeExpenses)
    await expect(friendRepository.settlements.listForGroup(created.groupId)).resolves.toEqual(beforeSettlements)
  }, 45_000)
})

function pick(source: Readonly<Record<string, unknown>>, fields: readonly string[]): Readonly<Record<string, unknown>> {
  return Object.fromEntries(fields.map((field) => [field, source[field]]))
}
