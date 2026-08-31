import { describe, expect, it } from 'vitest'
import { createBrowserPrincipalLocalDataPort } from '../localData'
import { appPrincipalKey } from '../principal'

describe('principal local data clearing', () => {
  it('removes only exact principal-owned keys', async () => {
    const principal = { mode: 'firebase', projectId: 'split-unwise', uid: 'maya' } as const
    const other = { ...principal, uid: 'alex' }
    const own = `split-unwise:command-queue:v6:${encodeURIComponent(appPrincipalKey(principal))}`
    const foreign = `split-unwise:command-queue:v6:${encodeURIComponent(appPrincipalKey(other))}`
    const map = new Map([[own, 'own'], [foreign, 'foreign'], ['unrelated', 'keep']])
    const storage = {
      get length() { return map.size }, key: (index: number) => [...map.keys()][index] ?? null,
      getItem: (key: string) => map.get(key) ?? null, setItem: (key: string, value: string) => map.set(key, value), removeItem: (key: string) => { map.delete(key) }, clear: () => map.clear(),
    } as Storage
    await createBrowserPrincipalLocalDataPort({ storage, indexedDb: undefined }).clear(principal)
    expect(map.has(own)).toBe(false)
    expect(map.get(foreign)).toBe('foreign')
    expect(map.get('unrelated')).toBe('keep')
  })
})
