export type LocalReceiptReference = `local-receipt:${string}`

export type ReceiptDurability =
  | { readonly status: 'local-only'; readonly reason: string }
  | { readonly status: 'upload-unavailable'; readonly reason: string }
  | { readonly status: 'uploaded'; readonly attachmentRef: string }

export interface ReceiptAsset {
  readonly reference: LocalReceiptReference
  readonly blob: Blob
  readonly fileName: string
  readonly mimeType: string
  readonly size: number
  readonly createdAt: string
  readonly durability: ReceiptDurability
  readonly commandOperationIds: readonly string[]
}

export interface ReceiptBlobStore {
  put(blob: Blob, metadata: { readonly fileName: string }): Promise<LocalReceiptReference>
  get(reference: LocalReceiptReference): Promise<ReceiptAsset | undefined>
  setDurability(reference: LocalReceiptReference, durability: ReceiptDurability): Promise<void>
  /** Prevents stale editor cleanup from deleting a local asset captured by a durable command. */
  claim(reference: LocalReceiptReference, operationId: string): Promise<void>
  delete(reference: LocalReceiptReference): Promise<void>
}

export interface ReceiptSuggestion {
  readonly description: string
  readonly amountText: string
}

export type ReceiptRecognitionResult =
  | { readonly status: 'suggestions'; readonly source: 'demo' | 'provider'; readonly items: readonly ReceiptSuggestion[] }
  | { readonly status: 'unavailable'; readonly reason: string }

export type ReceiptUploadResult =
  | { readonly status: 'uploaded'; readonly attachmentRef: string }
  | { readonly status: 'unavailable'; readonly reason: string }

export interface ReceiptProvider {
  upload(groupId: string, reference: LocalReceiptReference): Promise<ReceiptUploadResult>
  recognize(reference: LocalReceiptReference): Promise<ReceiptRecognitionResult>
  delete(attachmentRef: string): Promise<void>
}

export interface ReceiptStoreOptions {
  readonly id?: () => string
  readonly now?: () => string
  readonly namespace?: string
}

const LOCAL_ONLY_DURABILITY: ReceiptDurability = {
  status: 'local-only',
  reason: 'Receipt is stored only on this device until upload succeeds.',
}

export function createMemoryReceiptStore(options: ReceiptStoreOptions = {}): ReceiptBlobStore {
  const assets = new Map<LocalReceiptReference, ReceiptAsset>()
  const id = options.id ?? createReceiptId
  const now = options.now ?? (() => new Date().toISOString())
  return {
    async put(blob, metadata) {
      const fileName = validateReceipt(blob, metadata.fileName)
      const reference = referenceFor(id())
      assets.set(reference, { reference, blob, fileName, mimeType: blob.type.toLowerCase(), size: blob.size, createdAt: now(), durability: LOCAL_ONLY_DURABILITY, commandOperationIds: [] })
      return reference
    },
    async get(reference) { return assets.get(reference) },
    async setDurability(reference, durability) {
      const asset = assets.get(reference)
      if (asset) assets.set(reference, { ...asset, durability })
    },
    async claim(reference, operationId) {
      const asset = assets.get(reference)
      if (!asset) return
      const commandOperationIds = [...new Set([...asset.commandOperationIds, operationId])]
      assets.set(reference, { ...asset, commandOperationIds })
    },
    async delete(reference) {
      if (assets.get(reference)?.commandOperationIds.length) return
      assets.delete(reference)
    },
  }
}

export function createIndexedDbReceiptStore(options: ReceiptStoreOptions & { readonly indexedDb?: IDBFactory } = {}): ReceiptBlobStore {
  const indexedDb = options.indexedDb ?? globalThis.indexedDB
  const id = options.id ?? createReceiptId
  const now = options.now ?? (() => new Date().toISOString())
  let database: Promise<IDBDatabase> | undefined
  const getDatabase = () => database ??= openDatabase(indexedDb, options.namespace)
  return {
    async put(blob, metadata) {
      const fileName = validateReceipt(blob, metadata.fileName)
      const reference = referenceFor(id())
      const asset: ReceiptAsset = { reference, blob, fileName, mimeType: blob.type.toLowerCase(), size: blob.size, createdAt: now(), durability: LOCAL_ONLY_DURABILITY, commandOperationIds: [] }
      await requestFrom(getDatabase(), 'readwrite', (store) => store.put(asset))
      return reference
    },
    async get(reference) { return requestFrom(getDatabase(), 'readonly', (store) => store.get(reference)) as Promise<ReceiptAsset | undefined> },
    async setDurability(reference, durability) {
      const asset = await requestFrom(getDatabase(), 'readonly', (store) => store.get(reference)) as ReceiptAsset | undefined
      if (asset) await requestFrom(getDatabase(), 'readwrite', (store) => store.put({ ...asset, durability }))
    },
    async claim(reference, operationId) {
      const asset = await requestFrom(getDatabase(), 'readonly', (store) => store.get(reference)) as ReceiptAsset | undefined
      if (!asset) return
      const commandOperationIds = [...new Set([...(asset.commandOperationIds ?? []), operationId])]
      await requestFrom(getDatabase(), 'readwrite', (store) => store.put({ ...asset, commandOperationIds }))
    },
    async delete(reference) {
      const asset = await requestFrom(getDatabase(), 'readonly', (store) => store.get(reference)) as ReceiptAsset | undefined
      if (!asset || asset.commandOperationIds?.length) return
      await requestFrom(getDatabase(), 'readwrite', (store) => store.delete(reference))
    },
  }
}

export function createDemoReceiptProvider(): ReceiptProvider {
  const unavailable = 'Receipt recognition is not configured. You can enter items manually.'
  return {
    async upload() { return { status: 'unavailable', reason: 'Receipt upload is not configured. The image remains saved on this device.' } },
    async recognize() { return { status: 'unavailable', reason: unavailable } },
    async delete() { /* no remote asset exists in demo mode */ },
  }
}

function referenceFor(id: string): LocalReceiptReference {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(id)) throw new Error('Receipt ID must be URL-safe')
  return `local-receipt:${id}`
}

function createReceiptId(): string {
  return globalThis.crypto?.randomUUID?.() ?? `receipt-${Date.now().toString(36)}`
}

const MAX_RECEIPT_BYTES = 15 * 1024 * 1024
const RECEIPT_MIME_TYPES = new Set(['image/heic', 'image/heif', 'image/jpeg', 'image/png', 'image/webp'])

function validateReceipt(blob: Blob, fileName: string): string {
  if (!(blob instanceof Blob)) throw new Error('Receipt content must be an image Blob')
  if (blob.size === 0) throw new Error('Receipt image cannot be empty')
  if (blob.size > MAX_RECEIPT_BYTES) throw new Error('Receipt images must be 15 MB or smaller')
  if (!RECEIPT_MIME_TYPES.has(blob.type.toLowerCase())) throw new Error('Receipt images must be JPEG, PNG, HEIC, or WebP')
  const normalizedName = fileName.trim()
  if (!normalizedName || normalizedName.length > 255 || /[\\/\u0000-\u001f\u007f]/.test(normalizedName)) throw new Error('Receipt file name is invalid')
  return normalizedName
}

function openDatabase(indexedDb: IDBFactory | undefined, namespace?: string): Promise<IDBDatabase> {
  if (!indexedDb) return Promise.reject(new Error('IndexedDB is unavailable on this device'))
  return new Promise((resolve, reject) => {
    const normalizedNamespace = namespace?.trim()
    const databaseName = normalizedNamespace ? `split-unwise-receipts:${normalizedNamespace}` : 'split-unwise-receipts'
    const request = indexedDb.open(databaseName, 1)
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains('receipts')) request.result.createObjectStore('receipts', { keyPath: 'reference' })
    }
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error ?? new Error('Receipt storage could not be opened'))
  })
}

async function requestFrom(
  database: Promise<IDBDatabase>,
  mode: IDBTransactionMode,
  request: (store: IDBObjectStore) => IDBRequest,
): Promise<unknown> {
  const db = await database
  return new Promise((resolve, reject) => {
    const transaction = db.transaction('receipts', mode)
    const result = request(transaction.objectStore('receipts'))
    let requestResult: unknown
    let requestSucceeded = false
    let settled = false
    const fail = (reason: unknown) => {
      if (settled) return
      settled = true
      reject(reason)
    }
    result.onsuccess = () => { requestSucceeded = true; requestResult = result.result }
    result.onerror = () => fail(result.error ?? new Error('Receipt storage operation failed'))
    transaction.oncomplete = () => {
      if (settled) return
      if (!requestSucceeded) { fail(new Error('Receipt storage transaction completed without a result')); return }
      settled = true
      resolve(requestResult)
    }
    transaction.onerror = () => fail(transaction.error ?? new Error('Receipt storage transaction failed'))
    transaction.onabort = () => fail(transaction.error ?? new Error('Receipt storage transaction was aborted'))
  })
}
