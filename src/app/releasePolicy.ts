export type ReleaseOperationStatus = 'fresh' | 'stale' | 'pending' | 'failed' | 'conflicted'

export interface UpdateBlockers {
  readonly blocked: boolean
  readonly commands: number
  readonly receipts: number
  readonly message: string
}

export interface UpdatePromptState {
  readonly waiting: boolean
  readonly dismissed: boolean
}

export type UpdatePromptEvent = 'need-refresh' | 'later' | 'reopen' | 'activated'

export function shouldRegisterServiceWorker(environment: { readonly production: boolean; readonly native: boolean }): boolean {
  return environment.production && !environment.native
}

export function describeUpdateBlockers(operations: readonly { readonly status: ReleaseOperationStatus }[], unuploadedReceipts: number): UpdateBlockers {
  const commands = operations.filter(({ status }) => status === 'pending' || status === 'failed' || status === 'conflicted').length
  const receipts = Number.isSafeInteger(unuploadedReceipts) && unuploadedReceipts > 0 ? unuploadedReceipts : 0
  const parts = [
    commands ? `${commands} unresolved ${commands === 1 ? 'change' : 'changes'}` : '',
    receipts ? `${receipts} local ${receipts === 1 ? 'receipt' : 'receipts'}` : '',
  ].filter(Boolean)
  return { blocked: commands + receipts > 0, commands, receipts, message: parts.length ? `Finish or discard ${parts.join(' and ')} before updating.` : '' }
}

export function reduceUpdatePrompt(state: UpdatePromptState, event: UpdatePromptEvent): UpdatePromptState {
  if (event === 'need-refresh') return { waiting: true, dismissed: false }
  if (event === 'later') return state.waiting ? { waiting: true, dismissed: true } : state
  if (event === 'reopen') return state.waiting ? { waiting: true, dismissed: false } : state
  return { waiting: false, dismissed: false }
}
