import { Capacitor } from '@capacitor/core'
import { reactive, readonly } from 'vue'
import { peekActiveAppSession } from '../data/session'
import { confirmAction } from './confirmDialog'
import { describeUnsyncedChanges, reduceUpdatePrompt, retryableBeforeUpdate, shouldRegisterServiceWorker, unsyncedChangesAfterRetry, type UpdateOperation, type UpdatePromptState } from './releasePolicy'

interface PwaState {
  prompt: UpdatePromptState
  offlineReady: boolean
  applying: boolean
  message: string
}

const state = reactive<PwaState>({ prompt: { waiting: false, dismissed: false }, offlineReady: false, applying: false, message: '' })
let updateServiceWorker: ((reloadPage?: boolean) => Promise<void>) | undefined
let registered = false
/** How long Update now gives failed changes to save on a retry before asking about them. */
const RETRY_WAIT_MS = 6000

type AppQueue = NonNullable<ReturnType<typeof peekActiveAppSession>>['queue']

export function usePwaStatus(): Readonly<PwaState> { return readonly(state) as Readonly<PwaState> }

export async function registerPwa(): Promise<void> {
  if (registered || !shouldRegisterServiceWorker({ production: import.meta.env.PROD, native: Capacitor.isNativePlatform() })) return
  registered = true
  try {
    const { registerSW } = await import('virtual:pwa-register')
    updateServiceWorker = registerSW({
      immediate: true,
      onNeedRefresh() { state.prompt = reduceUpdatePrompt(state.prompt, 'need-refresh'); state.message = '' },
      onOfflineReady() { state.offlineReady = true },
      onRegisterError() { state.message = 'Offline installation is unavailable. The online app still works.' },
    })
  } catch {
    state.message = 'Offline installation is unavailable. The online app still works.'
  }
}

export function dismissPwaUpdate(): void { state.prompt = reduceUpdatePrompt(state.prompt, 'later'); state.message = '' }
export function dismissOfflineReady(): void { state.offlineReady = false }

export async function activatePwaUpdate(): Promise<void> {
  if (!updateServiceWorker || state.applying) return
  const session = peekActiveAppSession()
  state.applying = true; state.message = ''
  let paused = false
  try {
    if (session) {
      await session.ready
      if (!(await settleBeforeUpdate(session.queue))) return
      // Changes still sending keep their place in the queue and replay safely after the reload.
      session.quiesce()
      paused = true
    }
    await updateServiceWorker(true)
    state.prompt = reduceUpdatePrompt(state.prompt, 'activated')
  } catch {
    if (paused) session?.resumeWork()
    state.message = 'The update could not be installed. Your saved work is unchanged.'
  } finally { state.applying = false }
}

/**
 * Update now resolves unsynced changes instead of refusing: it pushes what can still save, drops notification
 * housekeeping that can't, and asks before discarding anything real. Returns false when the user keeps them.
 */
async function settleBeforeUpdate(queue: AppQueue): Promise<boolean> {
  const retries = retryableBeforeUpdate(queue.snapshot()).map((operation) => queue.retry(operation.envelope.operationId).result().catch(() => undefined))
  if (retries.length) await Promise.race([Promise.allSettled(retries), new Promise((done) => setTimeout(done, RETRY_WAIT_MS))])
  const { dropQuietly, needsDecision } = unsyncedChangesAfterRetry(queue.snapshot())
  for (const operation of dropQuietly) await clearOperation(queue, operation)
  if (needsDecision.length === 0) return true
  const summary = describeUnsyncedChanges(needsDecision)
  const it = needsDecision.length === 1 ? 'it' : 'them'
  const discard = await confirmAction({
    header: 'Discard unsynced changes?',
    message: `${capitalize(summary)} couldn’t be saved. Update now and discard ${it}, or keep ${it} and retry first.`,
    confirmText: 'Discard and update',
    cancelText: 'Not now',
    destructive: true,
  })
  if (!discard) {
    state.message = `${capitalize(summary)} still ${needsDecision.length === 1 ? 'needs' : 'need'} to sync. Retry ${it} where you made ${it}, or tap Update now to discard ${it}.`
    return false
  }
  for (const operation of needsDecision) await clearOperation(queue, operation)
  return true
}

function clearOperation(queue: AppQueue, operation: UpdateOperation): Promise<boolean> {
  return operation.status === 'failed' ? queue.discard(operation.envelope.operationId) : queue.acknowledge(operation.envelope.operationId)
}

function capitalize(text: string): string { return text.charAt(0).toUpperCase() + text.slice(1) }

/** Tests stand in for vite-plugin-pwa's updater, which only exists in production builds. */
export function setPwaUpdaterForTesting(updater: ((reloadPage?: boolean) => Promise<void>) | undefined): void {
  updateServiceWorker = updater
  state.prompt = { waiting: Boolean(updater), dismissed: false }
  state.applying = false
  state.message = ''
}
