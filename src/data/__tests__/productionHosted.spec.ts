// @vitest-environment node
import { afterAll, expect, it } from 'vitest'
import { createUserWithEmailAndPassword, deleteUser, getAuth, signInWithEmailAndPassword, signOut, updateProfile } from 'firebase/auth'
import { deleteApp } from 'firebase/app'
import { collection, doc, getDoc, getDocs, getFirestore, limit, query } from 'firebase/firestore'
import { acceptSparkInvitation, bootstrapFirebaseProfile, createSparkGroup, createSparkInvitation, synchronizeFirebaseProfile } from '../firebaseSparkMutations'
import { getSplitUnwiseFirebaseApp, resetFirebaseBootstrapForTesting } from '../firebaseBootstrap'
import { createFirebaseRepository } from '../firebaseRepository'
import type { FirebaseConfiguration } from '../firebase'

const suffix = process.env.LIVE_PROOF_SUFFIX ?? 'disabled'
const hostedIt = process.env.LIVE_PROOF_SUFFIX ? it : it.skip
const password = 'SplitUnwise-Live-Proof-42!'
const ownerEmail = `live-owner-${suffix}@example.com`
const friendEmail = `live-friend-${suffix}@example.com`
let app: Awaited<ReturnType<typeof getSplitUnwiseFirebaseApp>> | undefined

afterAll(async () => {
  if (!app) return
  const auth = getAuth(app)
  for (const email of [friendEmail, ownerEmail]) {
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
  const response = await fetch('https://split-unwise-aditya.web.app/__/firebase/init.json', { cache: 'no-store' })
  if (!response.ok) throw new Error(`Hosting init failed with ${response.status}`)
  const configuration = await response.json() as FirebaseConfiguration
  expect(configuration.projectId).toBe('split-unwise-aditya')
  resetFirebaseBootstrapForTesting()
  app = await getSplitUnwiseFirebaseApp(configuration)
  const auth = getAuth(app)

  const owner = await createUserWithEmailAndPassword(auth, ownerEmail, password)
  await updateProfile(owner.user, { displayName: 'Live Original Owner' })
  await bootstrapFirebaseProfile(configuration, owner.user)
  await synchronizeFirebaseProfile(configuration, owner.user)
  const group = await createSparkGroup(configuration, { operationId: `live-${suffix}`, name: 'Live Account Proof', currency: 'USD' })
  const db = getFirestore(app)
  await expect(getDoc(doc(db, `groups/${group.groupId}`))).resolves.toMatchObject({ exists: expect.any(Function) })
  const invitation = await createSparkInvitation(configuration, { groupId: group.groupId, canonicalOrigin: 'https://split-unwise-aditya.web.app' })
  const token = new URL(invitation.link).hash.slice('#token='.length)

  await signOut(auth)
  const friend = await createUserWithEmailAndPassword(auth, friendEmail, password)
  await updateProfile(friend.user, { displayName: 'Live Proof Friend' })
  await bootstrapFirebaseProfile(configuration, friend.user)
  await synchronizeFirebaseProfile(configuration, friend.user)
  await acceptSparkInvitation(configuration, invitation.invitationId, token)
  await expect(getDoc(doc(db, `groups/${group.groupId}`))).resolves.toMatchObject({ exists: expect.any(Function) })

  await signOut(auth)
  await signInWithEmailAndPassword(auth, ownerEmail, password)
  const ownerRepository = createFirebaseRepository(configuration, owner.user.uid)
  const profileCommand = { kind: 'profile.update' as const, operationId: `live-rename-${suffix}`, displayName: 'Live Renamed Owner', initials: 'LR' }
  await expect(ownerRepository.app.updateProfile(profileCommand)).resolves.toEqual({
    kind: 'profile.update', operationId: profileCommand.operationId, status: 'saved', resourceId: owner.user.uid,
  })
  await expect(ownerRepository.app.updateProfile(profileCommand)).resolves.toMatchObject({ status: 'saved' })
  const preferencesCommand = { kind: 'notification.preferences' as const, operationId: `live-preferences-${suffix}`, preferences: { emailEnabled: false, pushEnabled: true } }
  await expect(ownerRepository.notifications.updatePreferences(preferencesCommand)).resolves.toEqual({
    kind: 'notification.preferences', operationId: preferencesCommand.operationId, status: 'saved', preferences: preferencesCommand.preferences,
  })
  await expect(ownerRepository.notifications.getPreferences()).resolves.toEqual(preferencesCommand.preferences)

  await signOut(auth)
  await signInWithEmailAndPassword(auth, friendEmail, password)
  const friendRepository = createFirebaseRepository(configuration, friend.user.uid)
  console.log('LIVE_PROOF_RESOURCES', JSON.stringify({ ownerUid: owner.user.uid, friendUid: friend.user.uid, groupId: group.groupId, invitationId: invitation.invitationId, ownerEmail, friendEmail }))
  await expect(getDocs(query(collection(db, `users/${friend.user.uid}/groups`), limit(100)))).resolves.toMatchObject({ size: 1 })
  await expect(getDoc(doc(db, `groups/${group.groupId}`))).resolves.toMatchObject({ exists: expect.any(Function) })
  await expect(getDoc(doc(db, `groups/${group.groupId}/members/${friend.user.uid}`))).resolves.toMatchObject({ exists: expect.any(Function) })
  await expect(getDocs(query(collection(db, `groups/${group.groupId}/members`), limit(100)))).resolves.toMatchObject({ size: 2 })
  await expect(friendRepository.groups.list()).resolves.toEqual([expect.objectContaining({ id: group.groupId, name: 'Live Account Proof' })])
  await expect(friendRepository.groups.listMembers(group.groupId)).resolves.toEqual(expect.arrayContaining([
    expect.objectContaining({ id: owner.user.uid, displayName: 'Live Renamed Owner', initials: 'LR' }),
    expect.objectContaining({ id: friend.user.uid, displayName: 'Live Proof Friend' }),
  ]))
}, 30_000)
