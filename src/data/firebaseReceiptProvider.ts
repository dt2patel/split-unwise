import type { FirebaseConfiguration } from './firebase'
import { getSplitUnwiseFirebaseApp, getSplitUnwiseFirebaseAuth } from './firebaseBootstrap'
import { callSplitUnwiseFunction } from './firebaseCallables'
import type { LocalReceiptReference, ReceiptBlobStore, ReceiptProvider, ReceiptRecognitionResult } from './receipts'

export function createFirebaseReceiptProvider(configuration: FirebaseConfiguration, store: ReceiptBlobStore): ReceiptProvider {
  const promoted = new Map<LocalReceiptReference, Promise<string>>()

  async function promote(groupId: string, reference: LocalReceiptReference): Promise<string> {
    let active = promoted.get(reference)
    if (!active) {
      active = (async () => {
        const asset = await store.get(reference)
        if (!asset) throw new Error('The local receipt is no longer available.')
        if (!configuration.storageBucket) throw new Error('Receipt upload is not configured for this build.')
        const [app, auth, storageModule] = await Promise.all([getSplitUnwiseFirebaseApp(configuration), getSplitUnwiseFirebaseAuth(configuration), import('firebase/storage')])
        const user = auth.currentUser
        if (!user) throw new Error('Sign in before uploading a receipt.')
        const operationId = await deterministicUuid(reference)
        const assetId = assetIdFor(reference)
        const target = storageModule.ref(storageModule.getStorage(app), `drafts/${user.uid}/${assetId}`)
        try {
          const existing = await storageModule.getMetadata(target)
          if (existing.customMetadata?.ownerUid !== user.uid || existing.customMetadata.operationId !== operationId || existing.customMetadata.purpose !== 'expense-receipt') throw new Error('An existing draft has conflicting receipt metadata.')
        } catch (error: unknown) {
          if (!isObjectMissing(error)) throw error
          await storageModule.uploadBytes(target, asset.blob, { contentType: asset.mimeType, customMetadata: { ownerUid: user.uid, operationId, purpose: 'expense-receipt' } })
        }
        const result = await callSplitUnwiseFunction('promoteDraft', { schemaVersion: 1, operationId, groupId, assetId, purpose: 'expense-receipt' }, { replayProtected: true })
        if (!isRecord(result) || result.status !== 'ready' || result.assetId !== assetId) throw new Error('Receipt promotion returned an invalid response.')
        return assetId
      })()
      promoted.set(reference, active)
    }
    try { return await active } catch (error) { promoted.delete(reference); throw error }
  }

  return {
    async upload(groupId, reference) {
      try { return { status: 'uploaded', attachmentRef: await promote(groupId, reference) } }
      catch (error) { return { status: 'unavailable', reason: message(error, 'Receipt upload is temporarily unavailable. The image remains on this device.') } }
    },
    async recognize(reference, groupId): Promise<ReceiptRecognitionResult> {
      if (!groupId) return { status: 'unavailable', reason: 'Choose a group before scanning this receipt.' }
      try {
        const assetId = await promote(groupId, reference)
        const result = await callSplitUnwiseFunction('createReceiptOcrJob', { schemaVersion: 1, operationId: uuid(), groupId, assetId }, { replayProtected: true })
        if (!isRecord(result) || typeof result.jobId !== 'string') throw new Error('Receipt scan job response is invalid.')
        const job = await waitForPrivateJob(configuration, result.jobId)
        if (job.status !== 'complete') return { status: 'unavailable', reason: 'Receipt recognition is not configured. You can enter items manually.' }
        const items = isRecord(job.suggestion) && Array.isArray(job.suggestion.items)
          ? job.suggestion.items.flatMap((item) => isRecord(item) && typeof item.description === 'string' && typeof item.amountText === 'string' ? [{ description: item.description, amountText: item.amountText }] : [])
          : []
        return items.length ? { status: 'suggestions', source: 'provider', items } : { status: 'unavailable', reason: 'No line items were recognized. You can enter them manually.' }
      } catch (error) { return { status: 'unavailable', reason: message(error, 'Receipt recognition is temporarily unavailable. You can enter items manually.') } }
    },
    async delete() { /* Promoted assets remain immutable audit inputs; removing a draft only detaches its reference. */ },
  }
}

export async function waitForPrivateJob(configuration: FirebaseConfiguration, jobId: string, timeoutMs = 120_000): Promise<Record<string, unknown>> {
  const [app, auth, firestore] = await Promise.all([getSplitUnwiseFirebaseApp(configuration), getSplitUnwiseFirebaseAuth(configuration), import('firebase/firestore')])
  const user = auth.currentUser
  if (!user) throw new Error('Sign in to monitor this job.')
  const reference = firestore.doc(firestore.getFirestore(app), 'users', user.uid, 'jobs', jobId)
  return new Promise((resolve, reject) => {
    let unsubscribe = (): void => undefined
    const timeout = setTimeout(() => { unsubscribe(); reject(new Error('The server job is taking longer than expected.')) }, timeoutMs)
    unsubscribe = firestore.onSnapshot(reference, (snapshot) => {
      if (!snapshot.exists()) return
      const data = snapshot.data()
      if (data.status === 'complete' || data.status === 'failed') { clearTimeout(timeout); unsubscribe(); resolve(data) }
    }, (error) => { clearTimeout(timeout); unsubscribe(); reject(error) })
  })
}

export async function downloadPrivateObject(configuration: FirebaseConfiguration, storagePath: string, fileName: string): Promise<void> {
  if (!configuration.storageBucket) throw new Error('Cloud Storage is not configured for this build.')
  if (!/^exports\/[A-Za-z0-9._:-]+\/[A-Za-z0-9._:-]+\/[A-Za-z0-9._-]+$/.test(storagePath)) throw new Error('Export storage path is invalid.')
  const [app, storageModule] = await Promise.all([getSplitUnwiseFirebaseApp(configuration), import('firebase/storage')])
  const url = await storageModule.getDownloadURL(storageModule.ref(storageModule.getStorage(app), storagePath))
  const anchor = document.createElement('a'); anchor.href = url; anchor.download = fileName; anchor.rel = 'noopener'; document.body.append(anchor)
  try { anchor.click() } finally { anchor.remove() }
}

function assetIdFor(reference: LocalReceiptReference): string { return `asset_${reference.slice('local-receipt:'.length)}` }
function uuid(): string {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID()
  const bytes = new Uint8Array(16); globalThis.crypto.getRandomValues(bytes); bytes[6] = (bytes[6] & 0x0f) | 0x40; bytes[8] = (bytes[8] & 0x3f) | 0x80
  const hex = [...bytes].map((value) => value.toString(16).padStart(2, '0')).join('')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}
async function deterministicUuid(value: string): Promise<string> { const bytes = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`split-unwise-receipt-v1\0${value}`))); const hex = [...bytes].map((item) => item.toString(16).padStart(2, '0')).join(''); return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}` }
function isObjectMissing(error: unknown): boolean { return isRecord(error) && typeof error.code === 'string' && error.code.endsWith('/object-not-found') }
function message(error: unknown, fallback: string): string { return error instanceof Error && error.message.trim() ? error.message : fallback }
function isRecord(value: unknown): value is Record<string, any> { return value !== null && typeof value === 'object' && !Array.isArray(value) }
