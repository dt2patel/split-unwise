import { appPrincipalKey, type AppPrincipal } from './principal'
import { clearCurrencyPreferences } from '../features/account/currencyPreferences'

export interface PrincipalLocalDataPort {
  clear(principal: AppPrincipal): Promise<{ readonly commandKeys: number; readonly receiptDatabase: boolean; readonly preferences: boolean }>
}

/** Clears only keys/databases named by the exact mode/project/UID principal. */
export function createBrowserPrincipalLocalDataPort(options: { readonly storage?: Storage; readonly indexedDb?: IDBFactory } = {}): PrincipalLocalDataPort {
  const storage = options.storage ?? browserStorage()
  const indexedDb = options.indexedDb ?? globalThis.indexedDB
  return {
    async clear(principal) {
      const namespace = appPrincipalKey(principal)
      const encoded = encodeURIComponent(namespace)
      let commandKeys = 0
      if (storage) {
        const keys = Array.from({ length: storage.length }, (_, index) => storage.key(index)).filter((key): key is string => Boolean(key))
        for (const key of keys) {
          if ((key.startsWith('split-unwise:command-queue:') || key.startsWith('split-unwise:feature-cache:')) && key.endsWith(`:${encoded}`)) {
            storage.removeItem(key)
            commandKeys += 1
          }
        }
        clearCurrencyPreferences(principal, storage)
      }
      const receiptDatabase = await deleteDatabase(indexedDb, `split-unwise-receipts:${namespace}`)
      return { commandKeys, receiptDatabase, preferences: Boolean(storage) }
    },
  }
}

function deleteDatabase(indexedDb: IDBFactory | undefined, name: string): Promise<boolean> {
  if (!indexedDb) return Promise.resolve(false)
  return new Promise((resolve, reject) => {
    const request = indexedDb.deleteDatabase(name)
    request.onsuccess = () => resolve(true)
    request.onerror = () => reject(request.error ?? new Error('Local receipt data could not be cleared'))
    request.onblocked = () => reject(new Error('Close other Split Unwise tabs before clearing local receipts'))
  })
}

function browserStorage(): Storage | undefined { try { return typeof localStorage === 'undefined' ? undefined : localStorage } catch { return undefined } }
