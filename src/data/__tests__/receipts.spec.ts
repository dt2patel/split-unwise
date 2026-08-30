import { describe, expect, it } from 'vitest'
import { createDemoReceiptProvider, createMemoryReceiptStore } from '../receipts'

describe('receipt ports', () => {
  it('keeps blobs behind a durable local reference and deletes them explicitly', async () => {
    const store = createMemoryReceiptStore({ id: () => 'receipt-001', now: () => '2026-08-30T12:00:00.000Z' })
    const reference = await store.put(new Blob(['receipt bytes'], { type: 'image/jpeg' }), { fileName: 'cabin.jpg' })

    expect(reference).toBe('local-receipt:receipt-001')
    expect(JSON.stringify({ attachmentRefs: [reference] })).toBe('{"attachmentRefs":["local-receipt:receipt-001"]}')
    await expect(store.get(reference)).resolves.toMatchObject({ reference, fileName: 'cabin.jpg', mimeType: 'image/jpeg', size: 13 })
    await store.delete(reference)
    await expect(store.get(reference)).resolves.toBeUndefined()
  })

  it('labels demo recognition as unavailable instead of claiming OCR output', async () => {
    const provider = createDemoReceiptProvider()
    await expect(provider.recognize('local-receipt:receipt-001')).resolves.toEqual({
      status: 'unavailable',
      reason: 'Receipt recognition is not configured. You can enter items manually.',
    })
  })
})
