import { describe, expect, it } from 'vitest'
import { createDemoReceiptProvider, createIndexedDbReceiptStore, createMemoryReceiptStore } from '../receipts'

describe('receipt ports', () => {
  it('keeps blobs behind a durable local reference and deletes them explicitly', async () => {
    const store = createMemoryReceiptStore({ id: () => 'receipt-001', now: () => '2026-08-30T12:00:00.000Z' })
    const reference = await store.put(new Blob(['receipt bytes'], { type: 'image/jpeg' }), { fileName: 'cabin.jpg' })

    expect(reference).toBe('local-receipt:receipt-001')
    expect(JSON.stringify({ attachmentRefs: [reference] })).toBe('{"attachmentRefs":["local-receipt:receipt-001"]}')
    await expect(store.get(reference)).resolves.toMatchObject({
      reference,
      fileName: 'cabin.jpg',
      mimeType: 'image/jpeg',
      size: 13,
      durability: {
        status: 'local-only',
        reason: 'Receipt is stored only on this device until upload succeeds.',
      },
    })
    await store.delete(reference)
    await expect(store.get(reference)).resolves.toBeUndefined()
  })

  it('persists the provider reason until a later promotion succeeds', async () => {
    const store = createMemoryReceiptStore({ id: () => 'promotion-state' })
    const reference = await store.put(new Blob(['receipt'], { type: 'image/png' }), { fileName: 'receipt.png' })

    await store.setDurability(reference, { status: 'upload-unavailable', reason: 'Offline. Try again later.' })
    await expect(store.get(reference)).resolves.toMatchObject({
      durability: { status: 'upload-unavailable', reason: 'Offline. Try again later.' },
    })

    await store.setDurability(reference, { status: 'uploaded', attachmentRef: 'remote-receipt:promotion-state' })
    await expect(store.get(reference)).resolves.toMatchObject({
      durability: { status: 'uploaded', attachmentRef: 'remote-receipt:promotion-state' },
    })
  })

  it('labels demo recognition as unavailable instead of claiming OCR output', async () => {
    const provider = createDemoReceiptProvider()
    await expect(provider.recognize('local-receipt:receipt-001')).resolves.toEqual({
      status: 'unavailable',
      reason: 'Receipt recognition is not configured. You can enter items manually.',
    })
  })

  it('rejects empty, unsupported, oversized, or unsafe local receipt blobs at the storage boundary', async () => {
    const store = createMemoryReceiptStore({ id: () => 'validated-receipt' })

    await expect(store.put(new Blob([], { type: 'image/jpeg' }), { fileName: 'empty.jpg' })).rejects.toThrow('empty')
    await expect(store.put(new Blob(['plain'], { type: 'text/plain' }), { fileName: 'receipt.txt' })).rejects.toThrow('JPEG, PNG, HEIC, or WebP')
    await expect(store.put(new Blob([new Uint8Array(15 * 1024 * 1024 + 1)], { type: 'image/png' }), { fileName: 'large.png' })).rejects.toThrow('15 MB')
    await expect(store.put(new Blob(['image'], { type: 'image/webp' }), { fileName: '../receipt.webp' })).rejects.toThrow('file name')
  })

  it('does not report an IndexedDB write as durable before its transaction completes', async () => {
    const database = fakeIndexedDb()
    const store = createIndexedDbReceiptStore({ indexedDb: database.factory, id: () => 'durable-write', now: () => '2026-08-30T12:00:00.000Z' })
    let settled = false

    const write = store.put(new Blob(['image'], { type: 'image/jpeg' }), { fileName: 'receipt.jpg' }).then((value) => { settled = true; return value })
    await database.flushRequest()
    await Promise.resolve()
    expect(settled).toBe(false)
    database.complete()

    await expect(write).resolves.toBe('local-receipt:durable-write')
  })

  it('rejects an IndexedDB write that aborts after its request succeeds', async () => {
    const database = fakeIndexedDb()
    const store = createIndexedDbReceiptStore({ indexedDb: database.factory, id: () => 'aborted-write' })
    const write = store.put(new Blob(['image'], { type: 'image/png' }), { fileName: 'receipt.png' })

    await database.flushRequest()
    database.abort(new Error('quota transaction aborted'))

    await expect(write).rejects.toThrow('quota transaction aborted')
  })

  it('opens an IndexedDB database scoped to the complete principal namespace', async () => {
    const database = fakeIndexedDb()
    const store = createIndexedDbReceiptStore({
      indexedDb: database.factory,
      namespace: 'demo:split-unwise:maya-p',
      id: () => 'principal-scoped',
    })
    const write = store.put(new Blob(['image'], { type: 'image/jpeg' }), { fileName: 'receipt.jpg' })

    await database.flushRequest()
    database.complete()
    await write

    expect(database.openedNames).toEqual(['split-unwise-receipts:demo:split-unwise:maya-p'])
  })
})

function fakeIndexedDb() {
  const openedNames: string[] = []
  let activeTransaction: {
    oncomplete: ((event: Event) => void) | null
    onabort: ((event: Event) => void) | null
    onerror: ((event: Event) => void) | null
    error: Error | null
  } | undefined
  let requestReady!: () => void
  const ready = new Promise<void>((resolve) => { requestReady = resolve })
  let flushRequest = async () => undefined
  const objectStore = {
    put() { return request(undefined) },
    get() { return request(undefined) },
    delete() { return request(undefined) },
  }
  const db = {
    objectStoreNames: { contains: () => true },
    createObjectStore: () => objectStore,
    transaction() {
      activeTransaction = { oncomplete: null, onabort: null, onerror: null, error: null }
      return Object.assign(activeTransaction, { objectStore: () => objectStore })
    },
  }
  const factory = {
    open(name: string) {
      openedNames.push(name)
      const openRequest = { result: db, error: null, onupgradeneeded: null as ((event: Event) => void) | null, onsuccess: null as ((event: Event) => void) | null, onerror: null as ((event: Event) => void) | null }
      queueMicrotask(() => openRequest.onsuccess?.(new Event('success')))
      return openRequest
    },
  } as unknown as IDBFactory

  function request(result: unknown) {
    const value = { result, error: null, onsuccess: null as ((event: Event) => void) | null, onerror: null as ((event: Event) => void) | null }
    flushRequest = async () => {
      value.onsuccess?.(new Event('success'))
      await Promise.resolve()
    }
    requestReady()
    return value
  }

  return {
    factory,
    openedNames,
    flushRequest: async () => { await ready; await flushRequest() },
    complete: () => activeTransaction?.oncomplete?.(new Event('complete')),
    abort: (error: Error) => { if (activeTransaction) { activeTransaction.error = error; activeTransaction.onabort?.(new Event('abort')) } },
  }
}
