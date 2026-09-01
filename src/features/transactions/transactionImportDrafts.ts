import { appPrincipalKey, type AppPrincipal } from '../../data/principal'
import { validateImportedTransactionProposal, type ImportedTransactionProposal } from '../../domain/transactionImport'

const KEY_PREFIX = 'split-unwise:transaction-import-draft:v1'
const DEFAULT_TTL_MS = 15 * 60 * 1000
const DRAFT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/

interface DraftEnvelope {
  readonly schemaVersion: 1
  readonly owner: string
  readonly createdAt: number
  readonly expiresAt: number
  readonly proposal: ImportedTransactionProposal
}

interface DraftOptions {
  readonly storage?: Pick<Storage, 'getItem' | 'removeItem' | 'setItem'>
  readonly now?: () => number
}

interface StoreDraftOptions extends DraftOptions {
  readonly id?: () => string
  readonly ttlMs?: number
}

export function storeTransactionImportDraft(principal: AppPrincipal, proposal: ImportedTransactionProposal, options: StoreDraftOptions = {}): string {
  const owner = appPrincipalKey(principal)
  const validated = validateImportedTransactionProposal(proposal)
  const now = (options.now ?? Date.now)()
  const ttlMs = options.ttlMs ?? DEFAULT_TTL_MS
  if (!Number.isSafeInteger(now) || now < 0 || !Number.isSafeInteger(ttlMs) || ttlMs < 1 || ttlMs > DEFAULT_TTL_MS) throw new Error('Transaction import draft lifetime is invalid.')
  const draftId = (options.id ?? createDraftId)()
  if (!DRAFT_ID_PATTERN.test(draftId)) throw new Error('Transaction import draft ID is invalid.')
  const storage = options.storage ?? browserSessionStorage()
  if (!storage) throw new Error('This device cannot create a private transaction draft.')
  const envelope: DraftEnvelope = { schemaVersion: 1, owner, createdAt: now, expiresAt: now + ttlMs, proposal: validated }
  storage.setItem(keyFor(owner, draftId), JSON.stringify(envelope))
  return draftId
}

export function consumeTransactionImportDraft(principal: AppPrincipal, draftId: string, options: DraftOptions = {}): ImportedTransactionProposal | undefined {
  if (!DRAFT_ID_PATTERN.test(draftId)) return undefined
  const owner = appPrincipalKey(principal)
  const storage = options.storage ?? browserSessionStorage()
  if (!storage) return undefined
  const key = keyFor(owner, draftId)
  const raw = storage.getItem(key)
  if (!raw) return undefined
  storage.removeItem(key)
  try {
    const value: unknown = JSON.parse(raw)
    if (!isRecord(value) || value.schemaVersion !== 1 || value.owner !== owner || typeof value.createdAt !== 'number' || typeof value.expiresAt !== 'number') return undefined
    const now = (options.now ?? Date.now)()
    if (!Number.isSafeInteger(value.createdAt) || !Number.isSafeInteger(value.expiresAt) || value.expiresAt <= value.createdAt || value.expiresAt > value.createdAt + DEFAULT_TTL_MS || now > value.expiresAt) return undefined
    return validateImportedTransactionProposal(value.proposal)
  } catch { return undefined }
}

function keyFor(owner: string, draftId: string): string { return `${KEY_PREFIX}:${encodeURIComponent(owner)}:${draftId}` }
function createDraftId(): string { return globalThis.crypto?.randomUUID?.() ?? `draft-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}` }
function browserSessionStorage(): Storage | undefined { try { return typeof sessionStorage === 'undefined' ? undefined : sessionStorage } catch { return undefined } }
function isRecord(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === 'object' && !Array.isArray(value) }
