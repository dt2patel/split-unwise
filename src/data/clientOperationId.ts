/** Creates an operation identity that remains unique across component remounts. */
export function createClientOperationId(prefix: string): string {
  const randomId = globalThis.crypto?.randomUUID?.()
  return randomId
    ? `${prefix}-${randomId}`
    : `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`
}
