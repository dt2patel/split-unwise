// @vitest-environment node
import { readFileSync } from 'node:fs'
import { initializeTestEnvironment, assertFails, assertSucceeds, type RulesTestEnvironment } from '@firebase/rules-unit-testing'
import { collection, collectionGroup, doc, getDoc, getDocs, limit, query, setDoc } from 'firebase/firestore'
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
