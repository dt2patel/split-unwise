export type CsvCell = boolean | null | number | string | undefined
export type CsvRow = Readonly<Record<string, CsvCell>>

export const CLIENT_EXPORT_ROW_LIMIT = 5_000
export const CLIENT_EXPORT_BYTE_LIMIT = 5 * 1024 * 1024

export type ClientExportAssessment =
  | { readonly status: 'ready'; readonly rowCount: number; readonly byteLength: number }
  | { readonly status: 'server-required'; readonly reason: 'row-limit' | 'byte-limit'; readonly rowCount: number; readonly byteLength: number }

/** Exports rows in input order with lexicographically ordered columns unless columns are supplied. */
export function toCsv(rows: readonly CsvRow[], columns?: readonly string[]): string {
  const selectedColumns = columns ? [...columns] : [...new Set(rows.flatMap((row) => Object.keys(row)))].sort(compareStrings)
  if (selectedColumns.length === 0) return ''

  const lines = [selectedColumns.map(escapeCsv).join(',')]
  for (const row of rows) {
    lines.push(selectedColumns.map((column) => escapeCsv(toCellText(row[column]))).join(','))
  }
  return `${lines.join('\n')}\n`
}

/** Serializes JSON-compatible values with recursively sorted object keys and a trailing newline. */
export function toJson(value: unknown): string {
  if (value === undefined || value === null || typeof value !== 'object') throw new Error('JSON export top-level value must be an object or array')
  return `${JSON.stringify(stableJsonValue(value, new Set()), null, 2)}\n`
}

export function protectCsvText(value: string): string {
  return /^\s*[=+\-@\t\r]/u.test(value) ? `'${value}` : value
}

export function assessClientExport(content: string, rowCount: number): ClientExportAssessment {
  if (!Number.isSafeInteger(rowCount) || rowCount < 0) throw new Error('Export row count must be a non-negative safe integer')
  const byteLength = new TextEncoder().encode(content).byteLength
  if (rowCount > CLIENT_EXPORT_ROW_LIMIT) return { status: 'server-required', reason: 'row-limit', rowCount, byteLength }
  if (byteLength > CLIENT_EXPORT_BYTE_LIMIT) return { status: 'server-required', reason: 'byte-limit', rowCount, byteLength }
  return { status: 'ready', rowCount, byteLength }
}

function stableJsonValue(value: unknown, path: Set<object>): unknown {
  if (value === undefined) throw new Error('JSON export cannot contain undefined values')
  if (typeof value === 'number' && !Number.isFinite(value)) throw new Error('JSON export numbers must be finite')
  if (typeof value === 'function' || typeof value === 'symbol' || typeof value === 'bigint') throw new Error('JSON export contains an unsupported value')
  if (Array.isArray(value)) {
    assertNotCyclic(value, path)
    const result = value.map((item) => stableJsonValue(item, path))
    path.delete(value)
    return result
  }
  if (value !== null && typeof value === 'object') {
    assertNotCyclic(value, path)
    if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) throw new Error('JSON export objects must be plain records')
    const record = value as Readonly<Record<string, unknown>>
    const entries = Object.keys(record).sort(compareStrings).map((key) => {
      if (isPrivateKey(key)) throw new Error(`JSON export contains private field: ${key}`)
      return [key, stableJsonValue(record[key], path)] as const
    })
    path.delete(value)
    return Object.fromEntries(entries)
  }
  return value
}

function assertNotCyclic(value: object, path: Set<object>): void {
  if (path.has(value)) throw new Error('JSON export cannot contain cyclic values')
  path.add(value)
}

function isPrivateKey(key: string): boolean {
  return /(password|secret|token|providerpayload|storagepath|downloadurl|objecturl|temporaryurl|rawblob|blob|localreference)/i.test(key.replace(/[^a-z]/gi, ''))
}

function toCellText(value: CsvCell): string {
  return value === null || value === undefined ? '' : String(value)
}

function escapeCsv(value: string): string {
  return /[",\n\r]/.test(value) ? `"${value.replaceAll('"', '""')}"` : value
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}
