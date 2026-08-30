export type CsvCell = boolean | null | number | string | undefined
export type CsvRow = Readonly<Record<string, CsvCell>>

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
  return `${JSON.stringify(stableJsonValue(value), null, 2)}\n`
}

function stableJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableJsonValue)
  if (value !== null && typeof value === 'object') {
    const record = value as Readonly<Record<string, unknown>>
    return Object.fromEntries(
      Object.keys(record)
        .sort(compareStrings)
        .filter((key) => record[key] !== undefined)
        .map((key) => [key, stableJsonValue(record[key])]),
    )
  }
  return value
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
