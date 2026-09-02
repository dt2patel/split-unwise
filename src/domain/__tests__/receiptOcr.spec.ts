import { describe, expect, it, vi } from 'vitest'
import { parseReceiptText, recognizeReceiptBlob, type ReceiptOcrAssetPaths } from '../receiptOcr'

describe('receipt OCR parsing', () => {
  it('turns recognized receipt rows into editable items while keeping the charged total separate', () => {
    const result = parseReceiptText(`
      LAKE HOUSE MARKET
      September 2, 2026
      Order 1042
      Groceries                 $42.00
      Ice                         8.00
      Snacks                     15.00
      Tax                         5.00
      TOTAL                     $70.00
      VISA 4242
    `)

    expect(result).toEqual({
      items: [
        { description: 'Groceries', amountText: '42.00' },
        { description: 'Ice', amountText: '8.00' },
        { description: 'Snacks', amountText: '15.00' },
        { description: 'Tax', amountText: '5.00' },
      ],
      totalAmountText: '70.00',
    })
  })

  it('recombines labels and amounts emitted on alternating sparse-text lines', () => {
    expect(parseReceiptText(`
      LAKE HOUSE MARKET
      Groceries
      42.00
      Ice
      8.00
      Snacks
      15.00
      Tax
      5.00
      TOTAL
      70.00
    `)).toEqual({
      items: [
        { description: 'Groceries', amountText: '42.00' },
        { description: 'Ice', amountText: '8.00' },
        { description: 'Snacks', amountText: '15.00' },
        { description: 'Tax', amountText: '5.00' },
      ],
      totalAmountText: '70.00',
    })
  })

  it('runs the local worker against the image and releases it after recognition', async () => {
    const originalUrl = location.href
    history.replaceState({}, '', '/tabs/groups/expenses/new?groupId=lake-house-weekend')
    const blob = new Blob(['receipt pixels'], { type: 'image/jpeg' })
    const recognize = vi.fn(async (input: Blob) => {
      expect(input).toBe(blob)
      return { data: { text: 'Groceries 42.00\nTOTAL 42.00' } }
    })
    const setParameters = vi.fn(async () => undefined)
    const terminate = vi.fn(async () => undefined)
    const createWorker = vi.fn(async (_paths: ReceiptOcrAssetPaths) => ({ recognize, setParameters, terminate }))

    try {
      await expect(recognizeReceiptBlob(blob, { createWorker })).resolves.toBe('Groceries 42.00\nTOTAL 42.00')

      const paths = createWorker.mock.calls[0][0]
      expect(new URL(paths.workerPath).pathname).toBe('/ocr/worker.min.js')
      expect(new URL(paths.corePath).pathname).toBe('/ocr/core')
      expect(new URL(paths.langPath).pathname).toBe('/ocr/lang')
      expect(setParameters).toHaveBeenCalledWith({
        preserve_interword_spaces: '1',
        tessedit_pageseg_mode: '11',
        user_defined_dpi: '300',
      })
      expect(terminate).toHaveBeenCalledOnce()
    } finally {
      history.replaceState({}, '', originalUrl)
    }
  })

  it('releases the local worker when recognition fails', async () => {
    const terminate = vi.fn(async () => undefined)
    const createWorker = vi.fn(async (_paths: ReceiptOcrAssetPaths) => ({
      recognize: vi.fn(async () => { throw new Error('Unreadable image') }),
      setParameters: vi.fn(async () => undefined),
      terminate,
    }))

    await expect(recognizeReceiptBlob(new Blob(['x'], { type: 'image/png' }), { createWorker })).rejects.toThrow('Unreadable image')
    expect(terminate).toHaveBeenCalledOnce()
  })
})
