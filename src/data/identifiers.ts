export const STRICT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/

export function isStrictId(value: unknown): value is string {
  return typeof value === 'string' && STRICT_ID_PATTERN.test(value)
}

/** Route query arrays are ambiguous and therefore fail closed. */
export function parseStrictScalarId(value: unknown): string | undefined {
  return isStrictId(value) ? value : undefined
}

export function requireStrictId(value: unknown, label: string): string {
  if (!isStrictId(value)) throw new Error(`${label} must be a valid structured ID`)
  return value
}
