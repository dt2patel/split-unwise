// @vitest-environment node
import { readFileSync } from 'node:fs'
import { initializeTestEnvironment, assertFails, assertSucceeds, type RulesTestEnvironment } from '@firebase/rules-unit-testing'
import { collection, collectionGroup, doc, getDoc, getDocs, limit, query, serverTimestamp, setDoc, Timestamp, updateDoc, writeBatch, type Firestore } from 'firebase/firestore'
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
    await setDoc(doc(db, 'groups/group-a'), { name: 'Group A', currency: 'USD', memberIds: ['active', 'removed'] })
    await setDoc(doc(db, 'groups/group-a/members/active'), { status: 'active' })
    await setDoc(doc(db, 'groups/group-a/members/removed'), { status: 'removed' })
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
