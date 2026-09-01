import type { Recurrence } from './model'

const STRICT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/

/**
 * Produces the deterministic document ID for one recurrence occurrence.
 * The SHA-256 prefix keeps the identifier safely bounded even for maximum-length template IDs.
 */
export function recurringOccurrenceId(templateId: string, occurrenceDate: string): string {
  if (!STRICT_ID_PATTERN.test(templateId)) throw new Error('Recurring template ID must be a strict ID')
  parseIsoDate(occurrenceDate)
  return `occ_${sha256Hex(`${templateId}\0${occurrenceDate}`).slice(0, 32)}`
}

/**
 * Computes one calendar occurrence from an ISO date without a time zone.
 * Monthly and yearly rules retain their explicit original anchor and otherwise use the target month's final day.
 */
export function nextOccurrence(date: string, recurrence: Recurrence): string {
  const source = parseIsoDate(date)
  assertAnchor(recurrence.anchor)
  switch (recurrence.frequency) {
    case 'weekly':
      source.setUTCDate(source.getUTCDate() + 7)
      return formatIsoDate(source)
    case 'fortnightly':
      source.setUTCDate(source.getUTCDate() + 14)
      return formatIsoDate(source)
    case 'monthly':
      return formatIsoDate(addClampedMonths(source, 1, recurrence.anchor.day))
    case 'yearly':
      return formatIsoDate(addClampedYear(source, recurrence.anchor.month, recurrence.anchor.day))
  }
}

function addClampedMonths(source: Date, months: number, day: number): Date {
  const year = source.getUTCFullYear()
  const month = source.getUTCMonth() + months
  const lastDay = new Date(Date.UTC(year, month + 1, 0)).getUTCDate()
  return new Date(Date.UTC(year, month, Math.min(day, lastDay)))
}

function addClampedYear(source: Date, month: number, day: number): Date {
  const year = source.getUTCFullYear() + 1
  const targetMonth = month - 1
  const lastDay = new Date(Date.UTC(year, targetMonth + 1, 0)).getUTCDate()
  return new Date(Date.UTC(year, targetMonth, Math.min(day, lastDay)))
}

function parseIsoDate(value: string): Date {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value)
  if (!match) throw new Error('Date must use YYYY-MM-DD')
  const [, yearText, monthText, dayText] = match
  const date = new Date(Date.UTC(Number(yearText), Number(monthText) - 1, Number(dayText)))
  if (formatIsoDate(date) !== value) throw new Error('Date must be a valid calendar date')
  return date
}

function formatIsoDate(date: Date): string {
  return date.toISOString().slice(0, 10)
}

function assertAnchor(anchor: Recurrence['anchor']): void {
  if (!Number.isInteger(anchor.month) || anchor.month < 1 || anchor.month > 12) {
    throw new Error('Recurrence anchor month must be between 1 and 12')
  }
  if (!Number.isInteger(anchor.day) || anchor.day < 1) throw new Error('Recurrence anchor day must be positive')
  const maximumDay = new Date(Date.UTC(2024, anchor.month, 0)).getUTCDate()
  if (anchor.day > maximumDay) throw new Error('Recurrence anchor day must exist in its month')
}

function sha256Hex(input: string): string {
  const bytes = new TextEncoder().encode(input)
  const padded = new Uint8Array(Math.ceil((bytes.length + 9) / 64) * 64)
  padded.set(bytes)
  padded[bytes.length] = 0x80
  let bitLength = BigInt(bytes.length) * 8n
  for (let index = padded.length - 1; index >= padded.length - 8; index -= 1) {
    padded[index] = Number(bitLength & 0xffn)
    bitLength >>= 8n
  }

  let a0 = 0x6a09e667
  let b0 = 0xbb67ae85
  let c0 = 0x3c6ef372
  let d0 = 0xa54ff53a
  let e0 = 0x510e527f
  let f0 = 0x9b05688c
  let g0 = 0x1f83d9ab
  let h0 = 0x5be0cd19
  for (let offset = 0; offset < padded.length; offset += 64) {
    const words = new Uint32Array(64)
    for (let index = 0; index < 16; index += 1) {
      const start = offset + index * 4
      words[index] = (padded[start]! << 24) | (padded[start + 1]! << 16) | (padded[start + 2]! << 8) | padded[start + 3]!
    }
    for (let index = 16; index < 64; index += 1) {
      const left = words[index - 15]!
      const right = words[index - 2]!
      words[index] = (words[index - 16]! + (rotateRight(left, 7) ^ rotateRight(left, 18) ^ (left >>> 3)) + words[index - 7]! + (rotateRight(right, 17) ^ rotateRight(right, 19) ^ (right >>> 10))) >>> 0
    }
    let a = a0; let b = b0; let c = c0; let d = d0; let e = e0; let f = f0; let g = g0; let h = h0
    for (let index = 0; index < 64; index += 1) {
      const sigma1 = rotateRight(e, 6) ^ rotateRight(e, 11) ^ rotateRight(e, 25)
      const choice = (e & f) ^ (~e & g)
      const temp1 = (h + sigma1 + choice + SHA256_CONSTANTS[index]! + words[index]!) >>> 0
      const sigma0 = rotateRight(a, 2) ^ rotateRight(a, 13) ^ rotateRight(a, 22)
      const majority = (a & b) ^ (a & c) ^ (b & c)
      const temp2 = (sigma0 + majority) >>> 0
      h = g; g = f; f = e; e = (d + temp1) >>> 0; d = c; c = b; b = a; a = (temp1 + temp2) >>> 0
    }
    a0 = (a0 + a) >>> 0; b0 = (b0 + b) >>> 0; c0 = (c0 + c) >>> 0; d0 = (d0 + d) >>> 0
    e0 = (e0 + e) >>> 0; f0 = (f0 + f) >>> 0; g0 = (g0 + g) >>> 0; h0 = (h0 + h) >>> 0
  }
  return [a0, b0, c0, d0, e0, f0, g0, h0].map((word) => word.toString(16).padStart(8, '0')).join('')
}

function rotateRight(value: number, amount: number): number { return (value >>> amount) | (value << (32 - amount)) }

const SHA256_CONSTANTS = [
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
] as const
