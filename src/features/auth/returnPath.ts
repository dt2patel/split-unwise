const RETURN_PATH_KEY = 'split-unwise:auth:return-path:v1'

/** A return path is internal, fragment-free, and cannot loop through Auth. */
export function sanitizeInternalReturnPath(value: unknown, resolve?: (path: string) => { matched: readonly unknown[] }): string | undefined {
  if (typeof value !== 'string' || !value.startsWith('/') || value.startsWith('//')) return undefined
  if (/[\\\u0000-\u001F\u007F#]/.test(value)) return undefined
  let url: URL
  try { url = new URL(value, 'https://split-unwise.invalid') } catch { return undefined }
  if (url.origin !== 'https://split-unwise.invalid' || url.pathname === '/auth' || url.pathname.startsWith('/auth/')) return undefined
  if (resolve && resolve(`${url.pathname}${url.search}`).matched.length === 0) return undefined
  return `${url.pathname}${url.search}`
}

export function storeReturnPath(path: string, storage: Pick<Storage, 'setItem'> | undefined = browserSessionStorage()): void {
  const safe = sanitizeInternalReturnPath(path)
  if (!safe || !storage) return
  try { storage.setItem(RETURN_PATH_KEY, safe) } catch { /* blocked storage does not weaken routing */ }
}

export function consumeReturnPath(storage: Pick<Storage, 'getItem' | 'removeItem'> | undefined = browserSessionStorage()): string | undefined {
  if (!storage) return undefined
  try {
    const value = storage.getItem(RETURN_PATH_KEY)
    storage.removeItem(RETURN_PATH_KEY)
    return sanitizeInternalReturnPath(value)
  } catch { return undefined }
}

function browserSessionStorage(): Storage | undefined {
  try { return typeof sessionStorage === 'undefined' ? undefined : sessionStorage } catch { return undefined }
}
