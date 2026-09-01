// @vitest-environment node
import { afterAll, expect, it } from 'vitest'
import { createUserWithEmailAndPassword, deleteUser, getAuth, signInWithEmailAndPassword, signOut, updateProfile } from 'firebase/auth'
import { deleteApp } from 'firebase/app'
import { collection, doc, getDoc, getDocs, getFirestore, limit, query } from 'firebase/firestore'
import { acceptSparkInvitation, bootstrapFirebaseProfile, createSparkFriendship, createSparkGroup, createSparkInvitation, inspectSparkInvitation, synchronizeFirebaseProfile } from '../firebaseSparkMutations'
import { getSplitUnwiseFirebaseApp, resetFirebaseBootstrapForTesting } from '../firebaseBootstrap'
import { createFirebaseRepository } from '../firebaseRepository'
import type { FirebaseConfiguration } from '../firebase'

const suffix = process.env.LIVE_PROOF_SUFFIX ?? 'disabled'
const hostedIt = process.env.LIVE_PROOF_SUFFIX ? it : it.skip
const keepLiveProof = process.env.KEEP_LIVE_PROOF === '1'
const password = 'SplitUnwise-Live-Proof-42!'
const ownerEmail = `live-owner-${suffix}@example.com`
const friendEmail = `live-friend-${suffix}@example.com`
const thirdEmail = `live-third-${suffix}@example.com`
const usePreverifiedAccounts = process.env.LIVE_PREVERIFIED_ACCOUNTS === '1'
let app: Awaited<ReturnType<typeof getSplitUnwiseFirebaseApp>> | undefined

async function restartHostedClient(configuration: FirebaseConfiguration) {
  if (app) await deleteApp(app)
  resetFirebaseBootstrapForTesting()
  app = await getSplitUnwiseFirebaseApp(configuration)
  return { auth: getAuth(app), db: getFirestore(app) }
}

afterAll(async () => {
  if (!app) return
  if (keepLiveProof) {
    await deleteApp(app)
    resetFirebaseBootstrapForTesting()
    return
  }
  const auth = getAuth(app)
  for (const email of [thirdEmail, friendEmail, ownerEmail]) {
    try {
      await signOut(auth)
      const credential = await signInWithEmailAndPassword(auth, email, password)
      await deleteUser(credential.user)
    } catch { /* best-effort Auth cleanup; Firestore cleanup is admin-verified separately */ }
  }
  await deleteApp(app)
  resetFirebaseBootstrapForTesting()
})

hostedIt('proves the deployed two-account and private-account paths', async () => {
  const shell = await fetch('https://split-unwise-aditya.web.app', { cache: 'no-store' })
  expect(shell.status).toBe(200)
  expect(await shell.text()).toContain('id="app"')
  const response = await fetch('https://split-unwise-aditya.web.app/__/firebase/init.json', { cache: 'no-store' })
  if (!response.ok) throw new Error(`Hosting init failed with ${response.status}`)
  const configuration = await response.json() as FirebaseConfiguration
  expect(configuration.projectId).toBe('split-unwise-aditya')
  let { auth, db } = await restartHostedClient(configuration)

  const owner = await createUserWithEmailAndPassword(auth, ownerEmail, password)
  const ownerUid = owner.user.uid
  await updateProfile(owner.user, { displayName: 'Live Original Owner' })
  await bootstrapFirebaseProfile(configuration, owner.user)
  await synchronizeFirebaseProfile(configuration, owner.user)
  const group = await createSparkGroup(configuration, { operationId: `live-${suffix}`, name: 'Live Account Proof', currency: 'USD' })
  await expect(getDoc(doc(db, `groups/${group.groupId}`))).resolves.toMatchObject({ exists: expect.any(Function) })
  const invitation = await createSparkInvitation(configuration, { groupId: group.groupId, canonicalOrigin: 'https://split-unwise-aditya.web.app' })
  const token = new URL(invitation.link).hash.slice('#token='.length)
  const friendship = await createSparkFriendship(configuration, {
    operationId: `live-friendship-${suffix}`, displayName: 'Live Proof Friend', email: friendEmail, currency: 'USD',
    canonicalOrigin: 'https://split-unwise-aditya.web.app',
  })
  if (friendship.status !== 'ready') throw new Error(`Friendship invitation was not created: ${friendship.reason}`)
  const friendshipInvitation = friendship.invitation
  const friendshipToken = new URL(friendshipInvitation.link).hash.slice('#token='.length)
  const thirdInvitation = await createSparkInvitation(configuration, { groupId: friendship.groupId, canonicalOrigin: 'https://split-unwise-aditya.web.app', targetEmail: thirdEmail })
  const thirdToken = new URL(thirdInvitation.link).hash.slice('#token='.length)
  await expect(createFirebaseRepository(configuration, ownerUid).groups.list()).resolves.toEqual(expect.arrayContaining([
    expect.objectContaining({ id: group.groupId, kind: 'group' }),
    expect.objectContaining({ id: friendship.groupId, kind: 'friendship', memberIds: [ownerUid] }),
  ]))

  ;({ auth, db } = await restartHostedClient(configuration))
  const friend = usePreverifiedAccounts
    ? await signInWithEmailAndPassword(auth, friendEmail, password)
    : await createUserWithEmailAndPassword(auth, friendEmail, password)
  const friendUid = friend.user.uid
  await updateProfile(friend.user, { displayName: 'Live Proof Friend' })
  await bootstrapFirebaseProfile(configuration, friend.user)
  await synchronizeFirebaseProfile(configuration, friend.user)
  if (!usePreverifiedAccounts) await expect(inspectSparkInvitation(configuration, friendshipInvitation.invitationId, friendshipToken)).rejects.toThrow(/verified email/i)
  else {
    await expect(inspectSparkInvitation(configuration, friendshipInvitation.invitationId, friendshipToken)).resolves.toMatchObject({ groupId: friendship.groupId })
    await expect(acceptSparkInvitation(configuration, friendshipInvitation.invitationId, friendshipToken)).resolves.toEqual({ groupId: friendship.groupId })
  }
  await acceptSparkInvitation(configuration, invitation.invitationId, token)
  await expect(getDoc(doc(db, `groups/${group.groupId}`))).resolves.toMatchObject({ exists: expect.any(Function) })

  ;({ auth, db } = await restartHostedClient(configuration))
  const third = usePreverifiedAccounts
    ? await signInWithEmailAndPassword(auth, thirdEmail, password)
    : await createUserWithEmailAndPassword(auth, thirdEmail, password)
  const thirdUid = third.user.uid
  await updateProfile(third.user, { displayName: 'Live Third Person' })
  await bootstrapFirebaseProfile(configuration, third.user)
  await synchronizeFirebaseProfile(configuration, third.user)
  if (usePreverifiedAccounts) {
    await expect(inspectSparkInvitation(configuration, thirdInvitation.invitationId, thirdToken)).resolves.toMatchObject({ groupId: friendship.groupId })
    await expect(acceptSparkInvitation(configuration, thirdInvitation.invitationId, thirdToken)).rejects.toThrow(/permission|friendship|two people/i)
  }

  ;({ auth, db } = await restartHostedClient(configuration))
  await signInWithEmailAndPassword(auth, ownerEmail, password)
  const ownerRepository = createFirebaseRepository(configuration, ownerUid)
  const profileCommand = { kind: 'profile.update' as const, operationId: `live-rename-${suffix}`, displayName: 'Live Renamed Owner', initials: 'LR' }
  await expect(ownerRepository.app.updateProfile(profileCommand)).resolves.toEqual({
    kind: 'profile.update', operationId: profileCommand.operationId, status: 'saved', resourceId: ownerUid,
  })
  await expect(ownerRepository.app.updateProfile(profileCommand)).resolves.toMatchObject({ status: 'saved' })
  const preferencesCommand = { kind: 'notification.preferences' as const, operationId: `live-preferences-${suffix}`, preferences: { emailEnabled: false, pushEnabled: true } }
  await expect(ownerRepository.notifications.updatePreferences(preferencesCommand)).resolves.toEqual({
    kind: 'notification.preferences', operationId: preferencesCommand.operationId, status: 'saved', preferences: preferencesCommand.preferences,
  })
  await expect(ownerRepository.notifications.getPreferences()).resolves.toEqual(preferencesCommand.preferences)

  ;({ auth, db } = await restartHostedClient(configuration))
  await signInWithEmailAndPassword(auth, friendEmail, password)
  const friendRepository = createFirebaseRepository(configuration, friendUid)
  const ledgerGroupId = usePreverifiedAccounts ? friendship.groupId : group.groupId
  console.log('LIVE_PROOF_RESOURCES', JSON.stringify({ ownerUid, friendUid, thirdUid, groupId: group.groupId, invitationId: invitation.invitationId, friendshipId: friendship.groupId, friendshipInvitationId: friendshipInvitation.invitationId, thirdInvitationId: thirdInvitation.invitationId, ownerEmail, friendEmail, thirdEmail }))
  await expect(getDocs(query(collection(db, `users/${friendUid}/groups`), limit(100)))).resolves.toMatchObject({ size: usePreverifiedAccounts ? 2 : 1 })
  await expect(getDoc(doc(db, `groups/${ledgerGroupId}`))).resolves.toMatchObject({ exists: expect.any(Function) })
  await expect(getDoc(doc(db, `groups/${ledgerGroupId}/members/${friendUid}`))).resolves.toMatchObject({ exists: expect.any(Function) })
  await expect(getDocs(query(collection(db, `groups/${ledgerGroupId}/members`), limit(100)))).resolves.toMatchObject({ size: 2 })
  await expect(friendRepository.groups.list()).resolves.toEqual(expect.arrayContaining([
    expect.objectContaining({ id: group.groupId, name: 'Live Account Proof' }),
    ...(usePreverifiedAccounts ? [expect.objectContaining({ id: ledgerGroupId, kind: 'friendship', name: 'Live Renamed Owner' })] : []),
  ]))
  await expect(friendRepository.groups.listMembers(ledgerGroupId)).resolves.toEqual(expect.arrayContaining([
    expect.objectContaining({ id: ownerUid, displayName: 'Live Renamed Owner', initials: 'LR' }),
    expect.objectContaining({ id: friendUid, displayName: 'Live Proof Friend' }),
  ]))
  const expenseCommand = {
    kind: 'expense.add' as const, operationId: `live-expense-${suffix}`, groupId: ledgerGroupId,
    description: 'Hosted mobile dinner', date: '2026-09-01', total: { currency: 'USD' as const, minorAmount: 2400 },
    payments: [{ participantId: friendUid, money: { currency: 'USD' as const, minorAmount: 2400 } }],
    allocations: [
      { participantId: ownerUid, money: { currency: 'USD' as const, minorAmount: 1200 } },
      { participantId: friendUid, money: { currency: 'USD' as const, minorAmount: 1200 } },
    ],
    category: 'Food', splitMethod: { type: 'equal' as const, participantIds: [ownerUid, friendUid] }, attachmentRefs: [],
  }
  const added = await friendRepository.expenses.add(expenseCommand)
  await expect(friendRepository.expenses.add(expenseCommand)).resolves.toEqual(added)
  if (added.status !== 'saved') throw new Error('Expected hosted expense creation to save')
  const editCommand = {
    kind: 'expense.edit' as const, operationId: `live-expense-edit-${suffix}`, groupId: ledgerGroupId,
    expenseId: added.expense.id, expectedRevision: 1,
    draft: {
      groupId: ledgerGroupId, description: 'Hosted mobile dinner and dessert', date: '2026-09-01',
      total: { currency: 'USD' as const, minorAmount: 3000 },
      payments: [{ participantId: friendUid, money: { currency: 'USD' as const, minorAmount: 3000 } }],
      allocations: [
        { participantId: ownerUid, money: { currency: 'USD' as const, minorAmount: 1500 } },
        { participantId: friendUid, money: { currency: 'USD' as const, minorAmount: 1500 } },
      ],
      category: 'Food', splitMethod: { type: 'equal' as const, participantIds: [ownerUid, friendUid] }, attachmentRefs: [],
    },
  }
  const edited = await friendRepository.expenses.edit(editCommand)
  await expect(friendRepository.expenses.edit(editCommand)).resolves.toEqual(edited)
  const readStartedAt = performance.now()
  const [loadedGroup, loadedProfile, loadedMembers, loadedExpenses, loadedActivity] = await Promise.all([
    friendRepository.groups.getById(ledgerGroupId),
    friendRepository.app.getCurrentUser(),
    friendRepository.groups.listMembers(ledgerGroupId),
    friendRepository.expenses.listForGroup(ledgerGroupId),
    friendRepository.activity.listForGroup(ledgerGroupId),
  ])
  const groupReadMs = Math.round(performance.now() - readStartedAt)
  console.log('HOSTED_GROUP_READ_MS', groupReadMs)
  expect(groupReadMs).toBeLessThan(10_000)
  expect(loadedGroup).toMatchObject(usePreverifiedAccounts
    ? { id: ledgerGroupId, kind: 'friendship', name: 'Live Renamed Owner' }
    : { id: ledgerGroupId, kind: 'group', name: 'Live Account Proof' })
  expect(loadedProfile).toMatchObject({ id: friendUid, displayName: 'Live Proof Friend' })
  expect(loadedMembers).toHaveLength(2)
  expect(loadedExpenses).toEqual([expect.objectContaining({ id: added.expense.id, description: 'Hosted mobile dinner and dessert', revision: 2 })])
  expect(loadedActivity).toEqual(expect.arrayContaining([
    expect.objectContaining({ kind: 'expense.created', operationId: expenseCommand.operationId, expenseId: added.expense.id, revision: 1 }),
    expect.objectContaining({ kind: 'expense.updated', operationId: editCommand.operationId, expenseId: added.expense.id, revision: 2 }),
  ]))
  const beforeSettlement = await friendRepository.groups.getBalanceSnapshot(ledgerGroupId)
  await expect(friendRepository.groups.getTotals(ledgerGroupId)).resolves.toEqual([{
    currency: 'USD', totalPaid: 3000, currentUserPaid: 3000, currentUserShare: 1500, currentUserNet: 1500,
  }])
  const debt = beforeSettlement.simplified[0]
  expect(debt).toEqual({ fromParticipantId: ownerUid, toParticipantId: friendUid, money: { currency: 'USD', minorAmount: 1500 } })
  const settlementCommand = {
    kind: 'settlement.record' as const, operationId: `live-settlement-${suffix}`, groupId: ledgerGroupId,
    expectedBalanceRevision: beforeSettlement.balanceRevision,
    basis: { kind: 'simplified' as const, senderId: ownerUid, recipientId: friendUid, currency: 'USD' as const, debtMinor: 1500 },
    money: { currency: 'USD' as const, minorAmount: 500 }, method: 'cash' as const, occurredOn: '2026-09-01',
    note: 'Hosted payment proof', outsidePaymentConfirmed: true as const,
  }
  const settlement = await friendRepository.settlements.record(settlementCommand)
  await expect(friendRepository.settlements.record(settlementCommand)).resolves.toEqual(settlement)
  if (settlement.status !== 'saved') throw new Error('Expected hosted settlement creation to save')
  expect(settlement).toMatchObject({ settlement: { revision: 1 }, balanceSnapshot: { balanceRevision: 3 }, activity: { kind: 'settlement.created' } })
  const voidCommand = {
    kind: 'settlement.void' as const, operationId: `live-settlement-void-${suffix}`, groupId: ledgerGroupId,
    settlementId: settlement.settlement.settlementId, expectedRevision: 1,
    expectedBalanceRevision: settlement.balanceSnapshot.balanceRevision, reason: 'Hosted void proof.',
  }
  const voided = await friendRepository.settlements.void(voidCommand)
  await expect(friendRepository.settlements.void(voidCommand)).resolves.toEqual(voided)
  expect(voided).toMatchObject({ settlement: { revision: 2, void: { reason: voidCommand.reason } }, balanceSnapshot: { balanceRevision: 4 }, activity: { kind: 'settlement.voided' } })
  await expect(friendRepository.activity.listForGroup(ledgerGroupId)).resolves.toEqual(expect.arrayContaining([
    expect.objectContaining({ kind: 'settlement.created', operationId: settlementCommand.operationId, settlementId: settlement.settlement.settlementId }),
    expect.objectContaining({ kind: 'settlement.voided', operationId: voidCommand.operationId, settlementId: settlement.settlement.settlementId }),
  ]))
  await expect(friendRepository.notifications.list({ limit: 100 })).resolves.toEqual({ items: [] })

  ;({ auth, db } = await restartHostedClient(configuration))
  await signInWithEmailAndPassword(auth, ownerEmail, password)
  const ownerNotificationRepository = createFirebaseRepository(configuration, ownerUid)
  const notificationPage = await ownerNotificationRepository.notifications.list({ limit: 100 })
  expect(notificationPage.items).toHaveLength(4)
  expect(notificationPage.items).toEqual(expect.arrayContaining([
    expect.objectContaining({ principalId: ownerUid, groupId: ledgerGroupId, actor: expect.objectContaining({ id: friendUid }), kind: 'expense.created' }),
    expect.objectContaining({ principalId: ownerUid, groupId: ledgerGroupId, actor: expect.objectContaining({ id: friendUid }), kind: 'expense.updated' }),
    expect.objectContaining({ principalId: ownerUid, groupId: ledgerGroupId, actor: expect.objectContaining({ id: friendUid }), kind: 'settlement.created' }),
    expect.objectContaining({ principalId: ownerUid, groupId: ledgerGroupId, actor: expect.objectContaining({ id: friendUid }), kind: 'settlement.voided' }),
  ]))
  await expect(ownerNotificationRepository.groups.getTotals(ledgerGroupId)).resolves.toEqual([{
    currency: 'USD', totalPaid: 3000, currentUserPaid: 0, currentUserShare: 1500, currentUserNet: -1500,
  }])
  await expect(ownerNotificationRepository.notifications.unreadCount()).resolves.toBe(4)

  const individual = notificationPage.items.at(-1)!
  const readCommand = { kind: 'notification.read' as const, operationId: `live-notification-read-${suffix}`, notificationId: individual.notificationId }
  const read = await ownerNotificationRepository.notifications.markRead(readCommand)
  await expect(ownerNotificationRepository.notifications.markRead(readCommand)).resolves.toEqual(read)
  expect(read).toMatchObject({ status: 'saved', notification: { notificationId: individual.notificationId, readAt: expect.any(String) } })
  await expect(ownerNotificationRepository.notifications.unreadCount()).resolves.toBe(3)

  const latest = notificationPage.items[0]!
  const cutoff = { createdAt: latest.createdAt, id: latest.notificationId }
  const readAllCommand = { kind: 'notification.read-all' as const, operationId: `live-notification-read-all-${suffix}`, cutoff }
  const readAll = await ownerNotificationRepository.notifications.markAllRead(readAllCommand)
  await expect(ownerNotificationRepository.notifications.markAllRead(readAllCommand)).resolves.toEqual(readAll)
  expect(readAll).toMatchObject({ status: 'saved', cutoff, readNotificationIds: expect.arrayContaining(notificationPage.items.slice(0, -1).map(({ notificationId }) => notificationId)) })
  await expect(ownerNotificationRepository.notifications.unreadCount()).resolves.toBe(0)
  expect((await ownerNotificationRepository.notifications.list({ limit: 100 })).items.every(({ readAt }) => typeof readAt === 'string')).toBe(true)
}, 90_000)
