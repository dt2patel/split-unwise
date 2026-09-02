import { describe, expect, it, vi } from 'vitest'
import { createMemoryReceiptStore, type ReceiptProvider } from '../receipts'
import { createOnDeviceReceiptProvider } from '../onDeviceReceiptProvider'

describe('on-device receipt recognition', () => {
  it('recognizes the locally stored image and returns editable rows without uploading it', async () => {
    const store = createMemoryReceiptStore({ id: () => 'device-scan' })
    const blob = new Blob(['private receipt pixels'], { type: 'image/jpeg' })
    const reference = await store.put(blob, { fileName: 'market.jpg' })
    const recognizeText = vi.fn(async (input: Blob) => {
      expect(input).toBe(blob)
      return 'Groceries 42.00\nIce 8.00\nTOTAL 50.00'
    })

    const provider = createOnDeviceReceiptProvider(store, { recognizeText })

    await expect(provider.recognize(reference)).resolves.toEqual({
      status: 'suggestions',
      source: 'device',
      items: [
        { description: 'Groceries', amountText: '42.00' },
        { description: 'Ice', amountText: '8.00' },
      ],
      totalAmountText: '50.00',
    })
    expect(recognizeText).toHaveBeenCalledOnce()
  })

  it('keeps the configured cloud upload boundary while recognition remains on device', async () => {
    const store = createMemoryReceiptStore({ id: () => 'hybrid-scan' })
    const reference = await store.put(new Blob(['pixels'], { type: 'image/png' }), { fileName: 'receipt.png' })
    const remote: ReceiptProvider = {
      upload: vi.fn(async () => ({ status: 'uploaded' as const, attachmentRef: 'asset_receipt' })),
      recognize: vi.fn(async () => ({ status: 'unavailable' as const, reason: 'Cloud OCR should not run.' })),
      delete: vi.fn(async () => undefined),
    }
    const provider = createOnDeviceReceiptProvider(store, {
      recognizeText: vi.fn(async () => 'Dinner 20.00\nTOTAL 20.00'),
      uploadProvider: remote,
    })

    await expect(provider.recognize(reference, 'group-1')).resolves.toMatchObject({ status: 'suggestions', source: 'device' })
    await expect(provider.upload('group-1', reference)).resolves.toEqual({ status: 'uploaded', attachmentRef: 'asset_receipt' })
    await provider.delete('asset_receipt')

    expect(remote.recognize).not.toHaveBeenCalled()
    expect(remote.upload).toHaveBeenCalledWith('group-1', reference)
    expect(remote.delete).toHaveBeenCalledWith('asset_receipt')
  })
})
