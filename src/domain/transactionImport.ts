import type { Money } from './model'
import { assertCurrencyCode, currencyExponent, toMinorUnits, type CurrencyCode } from './money'

const DEFAULT_MAX_BYTES = 2 * 1024 * 1024
const DEFAULT_MAX_ROWS = 500

export interface ImportedTransactionProposal {
  readonly fingerprint: `transaction-v1:${string}`
  readonly date: string
  readonly description: string
  readonly money: Money
  readonly sourceRow: number
}

export interface TransactionImportRejection {
  readonly sourceRow: number
  readonly reason: string
}

export interface TransactionImportResult {
  readonly proposals: readonly ImportedTransactionProposal[]
  readonly rejections: readonly TransactionImportRejection[]
}

export interface TransactionImportOptions {
  readonly defaultCurrency: CurrencyCode
  readonly maxBytes?: number
  readonly maxRows?: number
}

/**
 * Parses a bank statement locally. Results are proposals only and never ledger
 * commands; every accepted row still has to pass through the expense composer.
 */
export async function parseTransactionStatementCsv(source: string, options: TransactionImportOptions): Promise<TransactionImportResult> {
  assertCurrencyCode(options.defaultCurrency)
  const maximumBytes = positiveLimit(options.maxBytes, DEFAULT_MAX_BYTES, 'byte')
  const maximumRows = positiveLimit(options.maxRows, DEFAULT_MAX_ROWS, 'row')
  if (new TextEncoder().encode(source).byteLength > maximumBytes) throw new Error(`Statement is too large. Choose a CSV under ${maximumBytes} bytes.`)
  const rows = parseCsv(source.replace(/^\uFEFF/, '')).filter((row) => row.some((field) => field.trim()))
  if (rows.length < 2) throw new Error('Statement CSV needs a header and at least one transaction row.')
  if (rows.length - 1 > maximumRows) throw new Error(`Statement has too many rows. Import at most ${maximumRows} transactions at a time.`)

  const header = readHeader(rows[0]!)
  const proposals: ImportedTransactionProposal[] = []
  const rejections: TransactionImportRejection[] = []
  const fingerprints = new Set<string>()
  for (let index = 1; index < rows.length; index += 1) {
    const sourceRow = index + 1
    try {
      const row = rows[index]!
      if (row.length > rows[0]!.length || row.slice(rows[0]!.length).some((field) => field.trim())) throw new Error('Row has more values than the header.')
      const date = normalizeDate(valueAt(row, header.date))
      const description = normalizeDescription(valueAt(row, header.description))
      const currencyText = header.currency === undefined ? options.defaultCurrency : valueAt(row, header.currency).trim().toUpperCase() || options.defaultCurrency
      assertCurrencyCode(currencyText)
      const minorAmount = parseDebit(row, header, currencyText)
      const fingerprint = await createFingerprint(date, description, currencyText, minorAmount)
      if (fingerprints.has(fingerprint)) {
        rejections.push({ sourceRow, reason: 'Duplicate transaction in this statement.' })
        continue
      }
      fingerprints.add(fingerprint)
      proposals.push({ fingerprint, date, description, money: { currency: currencyText, minorAmount }, sourceRow })
    } catch (reason) {
      rejections.push({ sourceRow, reason: reason instanceof Error ? reason.message : 'Transaction row is invalid.' })
    }
  }
  return { proposals, rejections }
}

export function validateImportedTransactionProposal(value: unknown): ImportedTransactionProposal {
  if (!isRecord(value)) throw new Error('Imported transaction draft is invalid.')
  if (typeof value.fingerprint !== 'string' || !/^transaction-v1:[a-f0-9]{64}$/.test(value.fingerprint)) throw new Error('Imported transaction fingerprint is invalid.')
  if (typeof value.date !== 'string' || normalizeDate(value.date) !== value.date) throw new Error('Imported transaction date is invalid.')
  if (typeof value.description !== 'string' || normalizeDescription(value.description) !== value.description) throw new Error('Imported transaction description is invalid.')
  if (!isRecord(value.money) || typeof value.money.currency !== 'string' || typeof value.money.minorAmount !== 'number') throw new Error('Imported transaction amount is invalid.')
  assertCurrencyCode(value.money.currency)
  if (!Number.isSafeInteger(value.money.minorAmount) || value.money.minorAmount <= 0) throw new Error('Imported transaction amount must be greater than zero.')
  const sourceRow = value.sourceRow
  if (typeof sourceRow !== 'number' || !Number.isSafeInteger(sourceRow) || sourceRow < 2) throw new Error('Imported transaction source row is invalid.')
  return {
    fingerprint: value.fingerprint as ImportedTransactionProposal['fingerprint'],
    date: value.date,
    description: value.description,
    money: { currency: value.money.currency, minorAmount: value.money.minorAmount },
    sourceRow,
  }
}

interface HeaderMap {
  readonly date: number
  readonly description: number
  readonly currency?: number
  readonly amount?: number
  readonly debit?: number
  readonly credit?: number
}

function readHeader(values: readonly string[]): HeaderMap {
  const headers = values.map((value) => value.trim().toLowerCase())
  if (new Set(headers).size !== headers.length) throw new Error('Statement CSV has duplicate headers.')
  const date = findHeader(headers, ['date', 'transaction date', 'posted date'])
  const description = findHeader(headers, ['description', 'merchant', 'name', 'memo'])
  const currency = optionalHeader(headers, ['currency', 'currency code'])
  const amount = optionalHeader(headers, ['amount'])
  const debit = optionalHeader(headers, ['debit', 'withdrawal'])
  const credit = optionalHeader(headers, ['credit', 'deposit'])
  if (amount !== undefined && debit !== undefined) throw new Error('Statement CSV must use either Amount or Debit, not both.')
  if (amount === undefined && debit === undefined) throw new Error('Statement CSV needs an Amount or Debit header.')
  return { date, description, currency, amount, debit, credit }
}

function parseDebit(row: readonly string[], header: HeaderMap, currency: CurrencyCode): number {
  if (header.amount !== undefined) {
    const signed = parseMoney(valueAt(row, header.amount), currency)
    if (signed >= 0) throw new Error(signed === 0 ? 'Transaction amount must be greater than zero.' : 'Credit or refund rows are not imported as expenses.')
    return Math.abs(signed)
  }
  const creditText = header.credit === undefined ? '' : valueAt(row, header.credit).trim()
  if (creditText) {
    const credit = parseMoney(creditText, currency)
    if (credit !== 0) throw new Error('Credit or refund rows are not imported as expenses.')
  }
  const debit = parseMoney(valueAt(row, header.debit!), currency)
  if (debit <= 0) throw new Error('Transaction amount must be greater than zero.')
  return debit
}

function parseMoney(source: string, currency: CurrencyCode): number {
  const trimmed = source.trim()
  if (!trimmed) throw new Error('Transaction amount is required.')
  const negativeParentheses = /^\(.*\)$/.test(trimmed)
  const normalized = trimmed
    .replace(/^\(/, '').replace(/\)$/, '')
    .replace(/^[\s$€£¥₹]+/, '').replace(/[\s$€£¥₹]+$/, '')
    .replace(/,/g, '')
  const signed = negativeParentheses && !normalized.startsWith('-') ? `-${normalized}` : normalized
  const match = /^[+-]?(\d+)(?:\.(\d+))?$/.exec(signed)
  if (!match) throw new Error('Transaction amount is not a valid decimal value.')
  if ((match[2]?.length ?? 0) > currencyExponent(currency)) throw new Error(`Transaction amount has too many decimal places for ${currency}.`)
  return toMinorUnits(signed, currency)
}

function normalizeDate(source: string): string {
  const value = source.trim()
  let iso = value
  const us = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(value)
  if (us) iso = `${us[3]}-${us[1]!.padStart(2, '0')}-${us[2]!.padStart(2, '0')}`
  if (!/^\d{4}-\d{2}-\d{2}$/.test(iso)) throw new Error('Transaction date must be YYYY-MM-DD or MM/DD/YYYY.')
  const parsed = new Date(`${iso}T00:00:00.000Z`)
  if (Number.isNaN(parsed.valueOf()) || parsed.toISOString().slice(0, 10) !== iso) throw new Error('Transaction date is invalid.')
  return iso
}

function normalizeDescription(source: string): string {
  const value = source.replace(/\s+/g, ' ').trim()
  if (!value) throw new Error('Transaction description is required.')
  if (value.length > 160) throw new Error('Transaction description is too long.')
  if (/[\u0000-\u001F\u007F]/.test(value)) throw new Error('Transaction description contains unsupported characters.')
  return value
}

async function createFingerprint(date: string, description: string, currency: CurrencyCode, minorAmount: number): Promise<ImportedTransactionProposal['fingerprint']> {
  const canonical = JSON.stringify(['transaction-v1', date, description.toLocaleLowerCase('en-US'), currency, minorAmount])
  const bytes = new TextEncoder().encode(canonical)
  const digest = globalThis.crypto?.subtle ? new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256', bytes)) : fallbackDigest(bytes)
  return `transaction-v1:${[...digest].map((value) => value.toString(16).padStart(2, '0')).join('')}`
}

function fallbackDigest(bytes: Uint8Array): Uint8Array {
  const output = new Uint8Array(32)
  for (let lane = 0; lane < 8; lane += 1) {
    let hash = (0x811c9dc5 ^ (lane * 0x9e3779b9)) >>> 0
    for (const byte of bytes) { hash ^= byte; hash = Math.imul(hash, 0x01000193) >>> 0 }
    new DataView(output.buffer).setUint32(lane * 4, hash)
  }
  return output
}

function parseCsv(source: string): string[][] {
  const rows: string[][] = []
  let row: string[] = []
  let field = ''
  let state: 'plain' | 'quoted' | 'after-quote' = 'plain'
  const endField = () => { row.push(field); field = '' }
  const endRow = () => { endField(); rows.push(row); row = [] }
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index]!
    if (state === 'quoted') {
      if (character !== '"') { field += character; continue }
      if (source[index + 1] === '"') { field += '"'; index += 1; continue }
      state = 'after-quote'; continue
    }
    if (state === 'after-quote') {
      if (character === ',') { endField(); state = 'plain'; continue }
      if (character === '\n') { endRow(); state = 'plain'; continue }
      if (character === '\r' && source[index + 1] === '\n') { endRow(); state = 'plain'; index += 1; continue }
      throw new Error('Statement CSV has unexpected text after a quoted field.')
    }
    if (character === '"') {
      if (field) throw new Error('Statement CSV has a malformed quoted field.')
      state = 'quoted'; continue
    }
    if (character === ',') { endField(); continue }
    if (character === '\n') { endRow(); continue }
    if (character === '\r' && source[index + 1] === '\n') { endRow(); index += 1; continue }
    field += character
  }
  if (state === 'quoted') throw new Error('Statement CSV has an unterminated quoted field.')
  if (field || row.length) endRow()
  return rows
}

function findHeader(headers: readonly string[], choices: readonly string[]): number {
  const index = optionalHeader(headers, choices)
  if (index === undefined) throw new Error(`Statement CSV needs a ${choices[0]} header.`)
  return index
}
function optionalHeader(headers: readonly string[], choices: readonly string[]): number | undefined {
  const matches = headers.flatMap((header, index) => choices.includes(header) ? [index] : [])
  if (matches.length > 1) throw new Error(`Statement CSV has ambiguous ${choices[0]} headers.`)
  return matches[0]
}
function valueAt(row: readonly string[], index: number): string { return row[index] ?? '' }
function positiveLimit(value: number | undefined, fallback: number, label: string): number {
  const result = value ?? fallback
  if (!Number.isSafeInteger(result) || result <= 0) throw new Error(`Statement ${label} limit is invalid.`)
  return result
}
function isRecord(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === 'object' && !Array.isArray(value) }
