import type { LocalReceiptReference, ReceiptAsset } from '../receipts'

type RequestKind = 'delete' | 'get' | 'put'

interface ControlledRequest {
  result: unknown
  error: Error | null
  onsuccess: ((event: Event) => void) | null
  onerror: ((event: Event) => void) | null
}

interface PendingRequest {
  readonly kind: RequestKind
  readonly key?: LocalReceiptReference
  readonly value?: ReceiptAsset
  readonly request: ControlledRequest
}

interface ControlledTransaction {
  readonly mode: IDBTransactionMode
  readonly requests: PendingRequest[]
  processed: boolean
  error: Error | null
  oncomplete: ((event: Event) => void) | null
  onabort: ((event: Event) => void) | null
  onerror: ((event: Event) => void) | null
}

/**
 * Models the IndexedDB ordering relevant to receipt ownership: readonly
 * transactions may observe the same snapshot, while readwrite transactions
 * execute to completion in creation order.
 */
export function createInterleavingIndexedDb(initialAssets: readonly ReceiptAsset[]) {
  let assets = new Map(initialAssets.map((asset) => [asset.reference, copyAsset(asset)]))
  const transactions: ControlledTransaction[] = []
  const objectStoreNames = { contains: (name: string) => name === 'receipts' }

  const database = {
    objectStoreNames,
    createObjectStore: () => { throw new Error('The receipt store should already exist') },
    transaction(_name: string, mode: IDBTransactionMode = 'readonly') {
      const transaction: ControlledTransaction = {
        mode,
        requests: [],
        processed: false,
        error: null,
        oncomplete: null,
        onabort: null,
        onerror: null,
      }
      const objectStore = {
        get(key: LocalReceiptReference) { return enqueue(transaction, { kind: 'get', key }) },
        put(value: ReceiptAsset) { return enqueue(transaction, { kind: 'put', value: copyAsset(value) }) },
        delete(key: LocalReceiptReference) { return enqueue(transaction, { kind: 'delete', key }) },
      }
      transactions.push(transaction)
      return Object.assign(transaction, { objectStore: () => objectStore })
    },
  }

  const factory = {
    open() {
      const request = {
        result: database,
        error: null,
        onupgradeneeded: null as ((event: Event) => void) | null,
        onsuccess: null as ((event: Event) => void) | null,
        onerror: null as ((event: Event) => void) | null,
      }
      queueMicrotask(() => request.onsuccess?.(new Event('success')))
      return request
    },
  } as unknown as IDBFactory

  return {
    factory,
    async runToIdle(): Promise<void> {
      let idleRounds = 0
      for (let round = 0; round < 100; round += 1) {
        await Promise.resolve()
        await Promise.resolve()
        const pending = transactions.filter((transaction) => !transaction.processed)
        if (pending.length === 0) {
          idleRounds += 1
          if (idleRounds >= 8) return
          continue
        }
        idleRounds = 0
        for (const transaction of pending.filter(({ mode }) => mode === 'readonly')) process(transaction)
        for (const transaction of pending.filter(({ mode }) => mode === 'readwrite')) process(transaction)
      }
      throw new Error('Controlled IndexedDB did not become idle')
    },
    read(reference: LocalReceiptReference): ReceiptAsset | undefined {
      const asset = assets.get(reference)
      return asset ? copyAsset(asset) : undefined
    },
  }

  function process(transaction: ControlledTransaction): void {
    const transactionAssets = new Map([...assets].map(([reference, asset]) => [reference, copyAsset(asset)]))
    for (let index = 0; index < transaction.requests.length; index += 1) {
      const pending = transaction.requests[index]
      if (pending.kind === 'get') {
        const asset = transactionAssets.get(pending.key!)
        pending.request.result = asset ? copyAsset(asset) : undefined
      } else if (pending.kind === 'put') {
        transactionAssets.set(pending.value!.reference, copyAsset(pending.value!))
        pending.request.result = pending.value!.reference
      } else {
        transactionAssets.delete(pending.key!)
        pending.request.result = undefined
      }
      pending.request.onsuccess?.(new Event('success'))
    }
    if (transaction.mode === 'readwrite') assets = transactionAssets
    transaction.processed = true
    transaction.oncomplete?.(new Event('complete'))
  }
}

function enqueue(transaction: ControlledTransaction, input: Omit<PendingRequest, 'request'>): IDBRequest {
  const request: ControlledRequest = { result: undefined, error: null, onsuccess: null, onerror: null }
  transaction.requests.push({ ...input, request })
  return request as unknown as IDBRequest
}

function copyAsset(asset: ReceiptAsset): ReceiptAsset {
  return { ...asset, commandOperationIds: [...asset.commandOperationIds] }
}
