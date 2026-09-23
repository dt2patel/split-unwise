import type { SettlementMethod } from '../data/repositories'
import type { CurrencyCode } from '../domain/money'

/**
 * Hand-off for WebMCP write tools. An agent never saves anything itself: it offers a draft, the app opens the real
 * editor prefilled with it, and the agent waits here for what the user decided there (Save, Record, or leaving).
 */
export interface AgentExpenseDraft {
  readonly kind: 'expense'
  readonly groupId: string
  readonly description?: string
  readonly amountText?: string
  readonly currency?: CurrencyCode
  readonly date?: string
  readonly category?: string
  readonly notes?: string
  readonly paidBy?: string
  readonly participantIds?: readonly string[]
}

export interface AgentSettlementDraft {
  readonly kind: 'settlement'
  readonly groupId: string
  readonly amountText: string
  readonly method?: SettlementMethod
  readonly occurredOn?: string
  readonly note?: string
}

export type AgentDraft = AgentExpenseDraft | AgentSettlementDraft

export type AgentDraftCancelReason = 'left' | 'replaced' | 'expired' | 'aborted' | 'signed-out'

export type AgentDraftOutcome =
  | { readonly status: 'saved'; readonly id: string }
  | { readonly status: 'queued'; readonly operationId: string }
  | { readonly status: 'cancelled'; readonly reason: AgentDraftCancelReason }

export interface AgentDraftOffer {
  readonly id: string
  readonly outcome: Promise<AgentDraftOutcome>
}

/** How long the app has to open the editor for a draft before the offer lapses. */
const OPEN_WINDOW_MS = 2 * 60 * 1000
/** A save this device accepted but the server hasn't confirmed yet (e.g. offline) is reported as queued after this long. */
const CONFIRMATION_WAIT_MS = 8_000
const DRAFT_ID_PATTERN = /^agent-[A-Za-z0-9-]{8,64}$/

interface PendingDraft {
  readonly id: string
  readonly owner: string
  readonly draft: AgentDraft
  claimed: boolean
  settled: boolean
  queuedOperationId?: string
  readonly timers: ReturnType<typeof setTimeout>[]
  readonly resolve: (outcome: AgentDraftOutcome) => void
}

// One draft at a time: a newer offer replaces an older one, which then reports `replaced` to its agent.
let active: PendingDraft | undefined

export function offerAgentDraft(owner: string, draft: AgentDraft, options: { readonly openWindowMs?: number } = {}): AgentDraftOffer {
  if (active) settle(active, { status: 'cancelled', reason: 'replaced' })
  let resolve!: (outcome: AgentDraftOutcome) => void
  const outcome = new Promise<AgentDraftOutcome>((done) => { resolve = done })
  const pending: PendingDraft = { id: createDraftId(), owner, draft, claimed: false, settled: false, timers: [], resolve }
  pending.timers.push(setTimeout(() => { if (!pending.claimed) settle(pending, { status: 'cancelled', reason: 'expired' }) }, options.openWindowMs ?? OPEN_WINDOW_MS))
  active = pending
  return { id: pending.id, outcome }
}

/** The editor takes a draft exactly once, and only for the account and kind it was offered for. */
export function claimAgentDraft<K extends AgentDraft['kind']>(owner: string, id: unknown, kind: K): Extract<AgentDraft, { readonly kind: K }> | undefined {
  const pending = find(id)
  if (!pending || pending.claimed || pending.owner !== owner || pending.draft.kind !== kind) return undefined
  pending.claimed = true
  return pending.draft as Extract<AgentDraft, { readonly kind: K }>
}

/** The user's Save or Record was confirmed by the server. */
export function reportAgentDraftSaved(id: string | undefined, resourceId: string): void {
  const pending = find(id)
  if (pending?.claimed) settle(pending, { status: 'saved', id: resourceId })
}

/** The user saved and this device queued it; give the server a moment to confirm before telling the agent it's queued. */
export function reportAgentDraftQueued(id: string | undefined, operationId: string): void {
  const pending = find(id)
  if (!pending?.claimed) return
  pending.queuedOperationId = operationId
  pending.timers.push(setTimeout(() => settle(pending, { status: 'queued', operationId }), CONFIRMATION_WAIT_MS))
}

/** The user left the editor. A save that is already queued still counts as saved on this device. */
export function reportAgentDraftLeft(id: string | undefined): void {
  const pending = find(id)
  if (!pending?.claimed) return
  settle(pending, pending.queuedOperationId ? { status: 'queued', operationId: pending.queuedOperationId } : { status: 'cancelled', reason: 'left' })
}

/** The agent stopped waiting. Whatever is on screen stays for the user; only the agent's wait ends. */
export function abandonAgentDraft(id: string): void {
  const pending = find(id)
  if (pending) settle(pending, { status: 'cancelled', reason: 'aborted' })
}

/** Signing out or switching accounts ends every wait. */
export function clearAgentDrafts(): void {
  if (active) settle(active, { status: 'cancelled', reason: 'signed-out' })
}

function find(id: unknown): PendingDraft | undefined {
  return typeof id === 'string' && active && !active.settled && active.id === id ? active : undefined
}

function settle(pending: PendingDraft, outcome: AgentDraftOutcome): void {
  if (pending.settled) return
  pending.settled = true
  for (const timer of pending.timers) clearTimeout(timer)
  if (active === pending) active = undefined
  pending.resolve(outcome)
}

export function isAgentDraftId(value: unknown): value is string {
  return typeof value === 'string' && DRAFT_ID_PATTERN.test(value)
}

function createDraftId(): string {
  const random = globalThis.crypto?.randomUUID?.() ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`
  return `agent-${random}`
}
