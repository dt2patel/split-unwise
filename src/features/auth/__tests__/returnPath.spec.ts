import { describe, expect, it } from 'vitest'
import { consumeReturnPath, sanitizeInternalReturnPath, storeReturnPath } from '../returnPath'

describe('auth return paths', () => {
  it.each(['https://evil.example', '//evil.example', '/\\evil', '/tabs/home#token=secret', '/auth', '/unknown'])('rejects unsafe or unknown path %s', (path) => {
    const resolve = (value: string) => ({ matched: value.startsWith('/tabs/') ? [{}] : [] })
    expect(sanitizeInternalReturnPath(path, resolve)).toBeUndefined()
  })

  it('stores a safe path and consumes it exactly once', () => {
    const map = new Map<string, string>()
    const storage = { getItem: (key: string) => map.get(key) ?? null, setItem: (key: string, value: string) => map.set(key, value), removeItem: (key: string) => { map.delete(key) } }
    storeReturnPath('/tabs/groups?sort=recent', storage)
    expect(consumeReturnPath(storage)).toBe('/tabs/groups?sort=recent')
    expect(consumeReturnPath(storage)).toBeUndefined()
  })
})
