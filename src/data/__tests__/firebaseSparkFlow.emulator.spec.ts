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
    expect((await getDoc(doc(getFirestore(app), `groups/${created.groupId}`))).exists()).toBe(true)
  }, 30_000)

  emulatorIt('adds one replay-stable expense that both members read with the same derived balance', async () => {
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
    await expect(friendRepository.groups.getBalanceSnapshot(created.groupId)).resolves.toMatchObject({
      simplified: [{ fromParticipantId: friend.user.uid, toParticipantId: owner.user.uid, money: { currency: 'USD', minorAmount: 1200 } }],
    })
  }, 30_000)
})
