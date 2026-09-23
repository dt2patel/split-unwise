import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ToastButton } from '@ionic/vue'
import type { Router } from 'vue-router'
import { createAppRouter } from '../../app/router'
import * as pwaModule from '../../app/pwa'
import AppStatus from '../AppStatus.vue'

interface PwaTestState { prompt: { waiting: boolean; dismissed: boolean }; offlineReady: boolean; applying: boolean; message: string }

const pwaMocks = vi.hoisted(() => ({ activate: vi.fn(async () => undefined), dismissUpdate: vi.fn(), dismissOffline: vi.fn() }))
vi.mock('../../app/pwa', async () => {
  const { reactive } = await import('vue')
  const pwaTestState = reactive<PwaTestState>({ prompt: { waiting: false, dismissed: false }, offlineReady: false, applying: false, message: '' })
  return {
    pwaTestState,
    usePwaStatus: () => pwaTestState,
    activatePwaUpdate: pwaMocks.activate,
    dismissPwaUpdate: pwaMocks.dismissUpdate,
    dismissOfflineReady: pwaMocks.dismissOffline,
  }
})
const pwa = (pwaModule as unknown as { pwaTestState: PwaTestState }).pwaTestState

const openHistory: Array<{ readonly header: string | undefined; readonly isOpen: boolean }> = []
const IonToast = {
  name: 'IonToast',
  props: ['isOpen', 'header', 'message', 'buttons', 'duration', 'position', 'positionAnchor', 'layout', 'translucent'],
  watch: { isOpen(this: { header?: string }, isOpen: boolean) { openHistory.push({ header: this.header, isOpen }) } },
  template: '<div class="toast-stub" :data-open="String(Boolean(isOpen))" />',
}

beforeEach(() => {
  Object.assign(pwa, { prompt: { waiting: false, dismissed: false }, offlineReady: false, applying: false, message: '' })
  pwaMocks.activate.mockClear()
  pwaMocks.dismissUpdate.mockClear()
  pwaMocks.dismissOffline.mockClear()
  openHistory.length = 0
})
afterEach(() => vi.unstubAllGlobals())

describe('app status', () => {
  it('shows a waiting update as a persistent bottom toast with Later and Update now', async () => {
    pwa.prompt.waiting = true
    const { wrapper } = await mountStatus('/tabs/home')
    const toast = updateToast(wrapper)

    expect(toast.props()).toMatchObject({
      isOpen: true, header: 'Update ready', message: 'Install after your local work is safely settled.',
      duration: 0, position: 'bottom', layout: 'stacked',
    })
    const [later, update] = buttons(toast)
    expect(later).toMatchObject({ text: 'Later', role: 'cancel' })
    expect(update).toMatchObject({ text: 'Update now', htmlAttributes: {} })
    expect(update?.role).toBeUndefined()
    expect(offlineReadyToast(wrapper).props('isOpen')).toBe(false)

    await later?.handler?.()
    expect(pwaMocks.dismissUpdate).toHaveBeenCalledOnce()
    // Returning false keeps the toast up while the update is checked; it closes when the prompt state changes.
    expect(await update?.handler?.()).toBe(false)
    expect(pwaMocks.activate).toHaveBeenCalledOnce()
  })

  it('disables Update now while an update is being checked and ignores repeat taps', async () => {
    pwa.prompt.waiting = true
    pwa.applying = true
    const { wrapper } = await mountStatus('/tabs/home')
    const [, update] = buttons(updateToast(wrapper))

    expect(update).toMatchObject({ text: 'Checking…', htmlAttributes: { disabled: true, 'aria-disabled': 'true' } })
    expect(await update?.handler?.()).toBe(false)
    expect(pwaMocks.activate).not.toHaveBeenCalled()

    pwa.applying = false
    await flushPromises()
    expect(buttons(updateToast(wrapper))[1]).toMatchObject({ text: 'Update now', htmlAttributes: {} })
  })

  it('explains in the update toast why an update could not be installed yet', async () => {
    pwa.prompt.waiting = true
    pwa.message = 'Finish syncing 1 saved change before updating.'
    const { wrapper } = await mountStatus('/tabs/home')

    expect(updateToast(wrapper).props('message')).toBe('Finish syncing 1 saved change before updating.')
    expect(wrapper.find('.app-status__notice--warning').exists()).toBe(false)

    pwa.prompt.waiting = false
    pwa.prompt.dismissed = true
    await flushPromises()
    expect(updateToast(wrapper).props('isOpen')).toBe(false)
  })

  it('shows offline readiness with OK until dismissed, and only while no update is waiting', async () => {
    pwa.offlineReady = true
    const { wrapper } = await mountStatus('/tabs/home')
    const toast = offlineReadyToast(wrapper)

    expect(toast.props()).toMatchObject({ isOpen: true, message: 'Split Unwise is ready for offline use.', duration: 0, position: 'bottom' })
    const [ok] = buttons(toast)
    expect(ok).toMatchObject({ text: 'OK', role: 'cancel' })
    await ok?.handler?.()
    expect(pwaMocks.dismissOffline).toHaveBeenCalledOnce()

    pwa.prompt.waiting = true
    await flushPromises()
    expect(offlineReadyToast(wrapper).props('isOpen')).toBe(false)
    expect(updateToast(wrapper).props('isOpen')).toBe(true)
  })

  it('anchors above the tab bar only while one is showing and re-presents an open toast when that changes', async () => {
    pwa.prompt.waiting = true
    const { wrapper, router } = await mountStatus('/tabs/home')
    expect(updateToast(wrapper).props('positionAnchor')).toBe('app-tab-bar')
    openHistory.length = 0

    await router.push('/tabs/groups')
    await flushPromises()
    expect(updateToast(wrapper).props('positionAnchor')).toBe('app-tab-bar')
    expect(openHistory).toEqual([])

    await router.push('/tabs/groups/lake-house-weekend')
    await flushPromises()
    expect(updateToast(wrapper).props('positionAnchor')).toBeUndefined()
    expect(updateToast(wrapper).props('isOpen')).toBe(true)
    expect(openHistory).toEqual([{ header: 'Update ready', isOpen: false }, { header: 'Update ready', isOpen: true }])
    openHistory.length = 0

    await router.push('/tabs/groups/lake-house-weekend/settings')
    await flushPromises()
    expect(openHistory).toEqual([])

    await router.push('/auth')
    await flushPromises()
    expect(updateToast(wrapper).props('positionAnchor')).toBeUndefined()
    expect(updateToast(wrapper).props('isOpen')).toBe(true)
    expect(openHistory).toEqual([])
  })

  it('renders the toasts beside the fixed banner rather than inside it', async () => {
    pwa.offlineReady = true
    const { wrapper } = await mountStatus('/tabs/home')

    expect(wrapper.find('.app-status__banner .toast-stub').exists()).toBe(false)
    expect(wrapper.findAll('.toast-stub')).toHaveLength(2)
    // The hosted browser proof finds status actions under .app-status.
    expect(wrapper.findAll('.toast-stub').every((toast) => toast.classes('app-status'))).toBe(true)
  })

  it('keeps the offline notice and standalone warnings in the top banner', async () => {
    vi.stubGlobal('navigator', { onLine: false })
    pwa.message = 'Offline installation is unavailable. The online app still works.'
    const { wrapper } = await mountStatus('/tabs/home')
    const banner = wrapper.get('.app-status__banner')

    expect(banner.attributes('aria-live')).toBe('polite')
    expect(banner.get('.app-status__notice--offline').text()).toContain('Offline')
    expect(banner.get('.app-status__notice--warning').text()).toBe('Offline installation is unavailable. The online app still works.')
    expect(updateToast(wrapper).props('isOpen')).toBe(false)
    expect(offlineReadyToast(wrapper).props('isOpen')).toBe(false)
  })
})

describe('app status with the real Ionic toast', () => {
  it('disables Update now on the native toast button while checking, and Later dismisses through the cancel role', async () => {
    const router = createAppRouter()
    await router.push('/tabs/groups/lake-house-weekend')
    await router.isReady()
    const wrapper = mount(AppStatus, { global: { plugins: [router] }, attachTo: document.body })
    try {
      pwa.prompt.waiting = true
      const toast = () => Array.from(document.querySelectorAll<HTMLElement & { header?: string; presented?: boolean }>('ion-toast')).find((element) => element.header === 'Update ready')
      const nativeButton = (text: string) => Array.from(toast()?.shadowRoot?.querySelectorAll('button') ?? []).find((button) => button.textContent === text)
      await vi.waitFor(() => expect(toast()?.presented).toBe(true), { timeout: 3000 })
      expect(nativeButton('Later')?.getAttribute('part')).toBe('button cancel')
      expect(nativeButton('Update now')?.disabled).toBe(false)

      pwa.applying = true
      await vi.waitFor(() => expect(nativeButton('Checking…')?.disabled).toBe(true))
      expect(nativeButton('Checking…')?.getAttribute('aria-disabled')).toBe('true')
      nativeButton('Checking…')?.click()
      await flushPromises()
      expect(pwaMocks.activate).not.toHaveBeenCalled()

      pwa.applying = false
      await vi.waitFor(() => expect(nativeButton('Update now')?.disabled).toBe(false))
      nativeButton('Later')?.click()
      await vi.waitFor(() => expect(pwaMocks.dismissUpdate).toHaveBeenCalledOnce())
    } finally {
      wrapper.unmount()
    }
  })
})

async function mountStatus(path: string): Promise<{ readonly wrapper: VueWrapper; readonly router: Router }> {
  const router = createAppRouter()
  await router.push(path)
  await router.isReady()
  const wrapper = mount(AppStatus, { global: { plugins: [router], stubs: { IonToast } } })
  await flushPromises()
  return { wrapper, router }
}

function toasts(wrapper: VueWrapper) { return wrapper.findAllComponents({ name: 'IonToast' }) }
function updateToast(wrapper: VueWrapper) {
  const toast = toasts(wrapper).find((candidate) => candidate.props('header') === 'Update ready')
  if (!toast) throw new Error('Missing the update toast')
  return toast
}
function offlineReadyToast(wrapper: VueWrapper) {
  const toast = toasts(wrapper).find((candidate) => candidate.props('header') === undefined)
  if (!toast) throw new Error('Missing the offline-ready toast')
  return toast
}
function buttons(toast: VueWrapper): ToastButton[] { return (toast.props() as { readonly buttons: ToastButton[] }).buttons }
