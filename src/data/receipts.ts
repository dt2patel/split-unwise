export type LocalReceiptReference = `local-receipt:${string}`

export interface ReceiptAsset {
  readonly reference: LocalReceiptReference
  readonly blob: Blob
  readonly fileName: string
  readonly mimeType: string
  readonly size: number
  readonly createdAt: string
}

export interface ReceiptBlobStore {
  put(blob: Blob, metadata: { readonly fileName: string }): Promise<LocalReceiptReference>
  get(reference: LocalReceiptReference): Promise<ReceiptAsset | undefined>
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
}

export function createMemoryReceiptStore(options: ReceiptStoreOptions = {}): ReceiptBlobStore {
  const assets = new Map<LocalReceiptReference, ReceiptAsset>()
  const id = options.id ?? createReceiptId
  const now = options.now ?? (() => new Date().toISOString())
  return {
    async put(blob, metadata) {
      const reference = referenceFor(id())
      assets.set(reference, { reference, blob, fileName: metadata.fileName, mimeType: blob.type || 'application/octet-stream', size: blob.size, createdAt: now() })
      return reference
    },
    async get(reference) { return assets.get(reference) },
    async delete(reference) { assets.delete(reference) },
  }
}

export function createIndexedDbReceiptStore(options: ReceiptStoreOptions & { readonly indexedDb?: IDBFactory } = {}): ReceiptBlobStore {
  const indexedDb = options.indexedDb ?? globalThis.indexedDB
  const id = options.id ?? createReceiptId
  const now = options.now ?? (() => new Date().toISOString())
  let database: Promise<IDBDatabase> | undefined
  const getDatabase = () => database ??= openDatabase(indexedDb)
  return {
    async put(blob, metadata) {
      const reference = referenceFor(id())
      const asset: ReceiptAsset = { reference, blob, fileName: metadata.fileName, mimeType: blob.type || 'application/octet-stream', size: blob.size, createdAt: now() }
      await requestFrom(getDatabase(), 'readwrite', (store) => store.put(asset))
      return reference
    },
    async get(reference) { return requestFrom(getDatabase(), 'readonly', (store) => store.get(reference)) as Promise<ReceiptAsset | undefined> },
    async delete(reference) { await requestFrom(getDatabase(), 'readwrite', (store) => store.delete(reference)) },
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

function openDatabase(indexedDb: IDBFactory | undefined): Promise<IDBDatabase> {
  if (!indexedDb) return Promise.reject(new Error('IndexedDB is unavailable on this device'))
  return new Promise((resolve, reject) => {
    const request = indexedDb.open('split-unwise-receipts', 1)
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
    result.onsuccess = () => resolve(result.result)
    result.onerror = () => reject(result.error ?? new Error('Receipt storage operation failed'))
    transaction.onabort = () => reject(transaction.error ?? new Error('Receipt storage transaction was aborted'))
  })
}
