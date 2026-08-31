import { describe, expect, it } from 'vitest'
import { assessClientExport, protectCsvText, toCsv, toJson } from '../exports'

describe('stable exports', () => {
  it('quotes CSV fields containing commas and quotes with deterministic columns', () => {
    expect(toCsv([
      {
        paid: true,
        description: 'He said "hi", then left',
        amount: 123,
        missing: null,
      },
    ])).toBe('amount,description,missing,paid\n123,"He said ""hi"", then left",,true\n')
  })

  it('serializes object keys recursively in stable order while preserving array order', () => {
    expect(toJson({
      z: 1,
      a: { y: [{ b: 2, a: 1 }], x: null },
    })).toBe(`{
  "a": {
    "x": null,
    "y": [
      {
        "a": 1,
        "b": 2
      }
    ]
  },
  "z": 1
}\n`)
  })

  it.each(['=SUM(A1:A2)', ' +cmd', '\t@payload', '\r-danger'])('protects CSV text whose first non-whitespace character can trigger a spreadsheet formula: %s', (value) => {
    expect(protectCsvText(value)).toBe(`'${value}`)
  })

  it('rejects invalid or private JSON instead of silently coercing it', () => {
    expect(() => toJson(undefined)).toThrow('top-level')
    expect(() => toJson({ amount: Number.NaN })).toThrow('finite')
    expect(() => toJson({ providerToken: 'secret' })).toThrow('private')
    const cyclic: Record<string, unknown> = {}
    cyclic.self = cyclic
    expect(() => toJson(cyclic)).toThrow('cyclic')
  })

  it('requires both row and encoded-byte limits before client download creation', () => {
    expect(assessClientExport('x', 5_000)).toMatchObject({ status: 'ready', rowCount: 5_000, byteLength: 1 })
    expect(assessClientExport('x', 5_001)).toEqual({ status: 'server-required', reason: 'row-limit', rowCount: 5_001, byteLength: 1 })
    const exact = 'x'.repeat(5 * 1024 * 1024)
    expect(assessClientExport(exact, 1)).toMatchObject({ status: 'ready', byteLength: 5 * 1024 * 1024 })
    expect(assessClientExport(`${exact}x`, 1)).toMatchObject({ status: 'server-required', reason: 'byte-limit' })
  })
})
