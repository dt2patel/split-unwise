import { parseReceiptText, recognizeReceiptBlob } from '../domain/receiptOcr'
import type { ReceiptBlobStore, ReceiptProvider } from './receipts'

export interface OnDeviceReceiptProviderOptions {
  readonly recognizeText?: (blob: Blob) => Promise<string>
  readonly uploadProvider?: Pick<ReceiptProvider, 'delete' | 'upload'>
}

export function createOnDeviceReceiptProvider(
  store: ReceiptBlobStore,
  options: OnDeviceReceiptProviderOptions = {},
): ReceiptProvider {
  return {
    async upload(groupId, reference) {
      return options.uploadProvider?.upload(groupId, reference)
        ?? { status: 'local-only', reason: 'Cloud receipt upload is not configured. The receipt stays on this device.' }
    },
    async recognize(reference) {
      try {
        const asset = await store.get(reference)
        if (!asset) return { status: 'unavailable', reason: 'The attached receipt is no longer available on this device.' }
        const recognized = parseReceiptText(await (options.recognizeText ?? recognizeReceiptBlob)(asset.blob))
        if (!recognized.items.length) return { status: 'unavailable', reason: 'No line items were recognized. You can enter them manually.' }
        return {
          status: 'suggestions', source: 'device', items: recognized.items,
          ...(recognized.totalAmountText ? { totalAmountText: recognized.totalAmountText } : {}),
        }
      } catch (reason) {
        return { status: 'unavailable', reason: reason instanceof Error && reason.message ? `${reason.message} You can enter items manually.` : 'Receipt recognition failed. You can enter items manually.' }
      }
    },
    async delete(attachmentRef) { await options.uploadProvider?.delete(attachmentRef) },
  }
}
