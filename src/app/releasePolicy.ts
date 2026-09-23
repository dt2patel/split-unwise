export type ReleaseOperationStatus = 'fresh' | 'stale' | 'pending' | 'failed' | 'conflicted'

export interface UpdatePromptState {
  readonly waiting: boolean
  readonly dismissed: boolean
}

export type UpdatePromptEvent = 'need-refresh' | 'later' | 'reopen' | 'activated'

export function shouldRegisterServiceWorker(environment: { readonly production: boolean; readonly native: boolean }): boolean {
  return environment.production && !environment.native
}

export interface UpdateOperation {
  readonly status: ReleaseOperationStatus
  readonly envelope: { readonly kind: string; readonly operationId: string }
  readonly error?: { readonly retryable: boolean }
}

/** Reading a notification or changing notification settings: losing one costs nothing, so it never holds an update. */
const HOUSEKEEPING_KINDS: ReadonlySet<string> = new Set(['notification.read', 'notification.read-all', 'notification.preferences'])

export function isHousekeepingOperation(kind: string): boolean { return HOUSEKEEPING_KINDS.has(kind) }

/** Failed changes that might still save if tried again; Update now pushes these before anything is discarded. */
export function retryableBeforeUpdate(operations: readonly UpdateOperation[]): readonly UpdateOperation[] {
  return operations.filter((operation) => operation.status === 'failed' && operation.error?.retryable === true)
}

/**
 * What still stands between the user and the update once retries are done. Pending changes aren't here: the queue
 * keeps them across the reload and replays them safely. Housekeeping failures are dropped without asking.
 */
export function unsyncedChangesAfterRetry(operations: readonly UpdateOperation[]): { readonly dropQuietly: readonly UpdateOperation[]; readonly needsDecision: readonly UpdateOperation[] } {
  const stuck = operations.filter((operation) => operation.status === 'failed' || operation.status === 'conflicted')
  return {
    dropQuietly: stuck.filter((operation) => isHousekeepingOperation(operation.envelope.kind)),
    needsDecision: stuck.filter((operation) => !isHousekeepingOperation(operation.envelope.kind)),
  }
}

/** "1 expense change and 2 comments": what the user is asked to discard, in their words rather than the queue's. */
export function describeUnsyncedChanges(operations: readonly UpdateOperation[]): string {
  const counts = new Map<string, number>()
  for (const operation of operations) {
    const noun = changeNoun(operation.envelope.kind)
    counts.set(noun, (counts.get(noun) ?? 0) + 1)
  }
  const parts = [...counts].map(([noun, count]) => `${count} ${noun}${count === 1 ? '' : 's'}`)
  return parts.length <= 1 ? parts.join('') : `${parts.slice(0, -1).join(', ')} and ${parts.at(-1)}`
}

function changeNoun(kind: string): string {
  if (kind.startsWith('expense.')) return 'expense change'
  if (kind.startsWith('settlement.')) return 'payment'
  if (kind.startsWith('comment.')) return 'comment'
  if (kind.startsWith('recurrence.')) return 'recurring expense change'
  if (kind.startsWith('group.')) return 'group change'
  if (kind === 'profile.update') return 'profile change'
  return 'change'
}

export function reduceUpdatePrompt(state: UpdatePromptState, event: UpdatePromptEvent): UpdatePromptState {
  if (event === 'need-refresh') return { waiting: true, dismissed: false }
  if (event === 'later') return state.waiting ? { waiting: true, dismissed: true } : state
  if (event === 'reopen') return state.waiting ? { waiting: true, dismissed: false } : state
  return { waiting: false, dismissed: false }
}
