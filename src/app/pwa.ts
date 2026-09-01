import { Capacitor } from '@capacitor/core'
import { reactive, readonly } from 'vue'
import { peekActiveAppSession } from '../data/session'
import { describeUpdateBlockers, reduceUpdatePrompt, shouldRegisterServiceWorker, type UpdatePromptState } from './releasePolicy'

interface PwaState {
  prompt: UpdatePromptState
  offlineReady: boolean
  applying: boolean
  message: string
}

const state = reactive<PwaState>({ prompt: { waiting: false, dismissed: false }, offlineReady: false, applying: false, message: '' })
let updateServiceWorker: ((reloadPage?: boolean) => Promise<void>) | undefined
let registered = false

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
  try {
    if (session) {
      await session.ready
      const receiptDrafts = await session.receipts.countUnuploaded?.() ?? 0
      const blockers = describeUpdateBlockers(session.queue.snapshot(), receiptDrafts)
      if (blockers.blocked) { state.message = blockers.message; return }
      const paused = session.quiesce()
      if (paused.total > 0) { session.resumeWork(); state.message = describeUpdateBlockers(session.queue.snapshot(), receiptDrafts).message; return }
    }
    await updateServiceWorker(true)
    state.prompt = reduceUpdatePrompt(state.prompt, 'activated')
  } catch {
    session?.resumeWork()
    state.message = 'The update could not be installed. Your saved work is unchanged.'
  } finally { state.applying = false }
}
