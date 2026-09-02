import type { ReceiptSuggestion } from '../data/receipts'

export interface ParsedReceiptText {
  readonly items: readonly ReceiptSuggestion[]
  readonly totalAmountText?: string
}

export interface ReceiptOcrAssetPaths {
  readonly workerPath: string
  readonly corePath: string
  readonly langPath: string
}

interface ReceiptOcrWorker {
  recognize(blob: Blob): Promise<{ readonly data: { readonly text: string } }>
  setParameters(parameters: Readonly<Record<string, string>>): Promise<unknown>
  terminate(): Promise<unknown>
}

export interface ReceiptOcrOptions {
  readonly createWorker?: (paths: ReceiptOcrAssetPaths) => Promise<ReceiptOcrWorker>
}

const TOTAL_LABEL = /^(?:grand\s+)?(?:total|amount\s+due|balance\s+due)$/i
const SUMMARY_LABEL = /^(?:sub\s*total|subtotal|cash|change|tendered|visa|mastercard|amex|debit|credit)$/i
const RECEIPT_ROW = /^(.*?)\s+(?:[$€£¥]\s*)?((?:\d{1,3}(?:,\d{3})+|\d+)[.,]\d{2})\s*$/
const RECEIPT_AMOUNT = /^(?:[$€£¥]\s*)?((?:\d{1,3}(?:,\d{3})+|\d+)[.,]\d{2})\s*$/

export function parseReceiptText(text: string): ParsedReceiptText {
  const items: ReceiptSuggestion[] = []
  let totalAmountText: string | undefined
  const lines = text.replace(/\r/g, '').split('\n').slice(0, 400)
    .map((line) => line.replace(/[|¦]/g, ' ').replace(/\s+/g, ' ').trim())
    .filter(Boolean)

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]
    const inline = RECEIPT_ROW.exec(line)
    const followingAmount = inline ? undefined : RECEIPT_AMOUNT.exec(lines[index + 1] ?? '')
    if (!inline && (!followingAmount || !/[A-Za-z]/.test(line))) continue
    const description = (inline?.[1] ?? line).replace(/^[•·*#-]+\s*/, '').trim()
    const amountText = normalizeRecognizedAmount((inline?.[2] ?? followingAmount?.[1])!)
    if (!description || !amountText) continue
    if (!inline) index += 1
    if (TOTAL_LABEL.test(description)) { totalAmountText = amountText; continue }
    if (SUMMARY_LABEL.test(description)) continue
    if (items.length < 100) items.push({ description: description.slice(0, 120), amountText })
  }

  return { items, ...(totalAmountText ? { totalAmountText } : {}) }
}

export async function recognizeReceiptBlob(blob: Blob, options: ReceiptOcrOptions = {}): Promise<string> {
  const base = globalThis.document?.baseURI ?? 'http://localhost/'
  const paths = {
    workerPath: new URL('/ocr/worker.min.js', base).href,
    corePath: new URL('/ocr/core', base).href.replace(/\/$/, ''),
    langPath: new URL('/ocr/lang', base).href.replace(/\/$/, ''),
  }
  const worker = await (options.createWorker ?? createLocalReceiptWorker)(paths)
  try {
    await worker.setParameters({
      preserve_interword_spaces: '1',
      tessedit_pageseg_mode: '11',
      user_defined_dpi: '300',
    })
    const result = await worker.recognize(blob)
    if (typeof result.data.text !== 'string') throw new Error('The receipt scanner returned invalid text.')
    return result.data.text
  } finally {
    await worker.terminate()
  }
}

async function createLocalReceiptWorker(paths: ReceiptOcrAssetPaths): Promise<ReceiptOcrWorker> {
  const tesseract = await import('tesseract.js')
  return tesseract.createWorker('eng', tesseract.OEM.LSTM_ONLY, {
    ...paths,
    cacheMethod: 'write',
    workerBlobURL: false,
  }) as unknown as Promise<ReceiptOcrWorker>
}

function normalizeRecognizedAmount(value: string): string | undefined {
  const compact = value.replace(/\s/g, '')
  const decimalSeparator = compact.lastIndexOf(',') > compact.lastIndexOf('.') ? ',' : '.'
  const digits = compact.replace(/[.,]/g, '')
  if (!/^\d{3,}$/.test(digits)) return undefined
  const minor = digits.slice(-2)
  const major = digits.slice(0, -2).replace(/^0+(?=\d)/, '') || '0'
  if (decimalSeparator !== ',' && decimalSeparator !== '.') return undefined
  return `${major}.${minor}`
}
