import { describe, expect, it } from 'vitest'
import { toCsv, toJson } from '../exports'

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
})
