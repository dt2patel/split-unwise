import { flushPromises, mount } from '@vue/test-utils'
import { defineComponent, h } from 'vue'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createMemoryHistory } from 'vue-router'
import { IonApp, IonPage, IonRouterOutlet, IonicVue } from '@ionic/vue'
import { createRouter } from '@ionic/vue-router'

const page = (label: string) => defineComponent({ name: `Page${label}`, render: () => h(IonPage, () => h('p', { 'data-page': label }, label)) })

interface Deferred { readonly promise: Promise<boolean>; resolve(value: boolean): void }
function deferred(): Deferred {
  let resolve!: (value: boolean) => void
  const promise = new Promise<boolean>((done) => { resolve = done })
  return { promise, resolve }
}

type SwipeHandler = { canStart(): boolean; onStart(): Promise<void>; onEnd(shouldContinue: boolean): void }
type OutletElement = HTMLElement & { swipeHandler?: SwipeHandler; commit: (entering: HTMLElement, leaving: HTMLElement, options: { progressAnimation?: boolean }) => Promise<boolean> }

async function mountStack() {
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [{ path: '/', redirect: '/home' }, { path: '/home', component: page('home') }, { path: '/group', component: page('group') }],
  })
  await router.push('/home')
  await router.isReady()
  const wrapper = mount(defineComponent({ render: () => h(IonApp, () => h(IonRouterOutlet)) }), { global: { plugins: [IonicVue, router] }, attachTo: document.body })
  await flushPromises()
  mounted.push(wrapper)
  const outlet = wrapper.element.querySelector('ion-router-outlet') as OutletElement
  // The real ion-router-outlet animates with Web Animations; stand in for a committed transition exactly as core ends one.
  const swipeCommit = { current: undefined as Deferred | undefined }
  // Mirrors core's transition: both pages are un-hidden when it starts, the entering page stops being invisible when it ends.
  const reveal = (el: HTMLElement) => { el.classList.remove('ion-page-hidden'); el.removeAttribute('aria-hidden') }
  const commit = vi.fn(async (entering: HTMLElement, leaving: HTMLElement, options: { progressAnimation?: boolean }) => {
    reveal(entering)
    if (leaving) reveal(leaving)
    const done = options.progressAnimation ? await (swipeCommit.current = deferred()).promise : true
    if (done) entering.classList.remove('ion-page-invisible')
    return done
  })
  outlet.commit = commit
  return { router, wrapper, outlet, commit, swipeCommit }
}

const mounted: Array<{ unmount(): void }> = []
afterEach(() => { while (mounted.length) mounted.pop()!.unmount() })

const visiblePage = (root: Element, label: string) => {
  const el = root.querySelector(`[data-page="${label}"]`)?.closest('.ion-page')
  return el ? !el.classList.contains('ion-page-invisible') && !el.classList.contains('ion-page-hidden') : false
}

describe('Ionic swipe-back racing a browser back navigation', () => {
  it('shows the page on the next navigation after iOS navigated back during an Ionic swipe', async () => {
    const { router, wrapper, outlet, commit, swipeCommit } = await mountStack()
    await router.push('/group')
    await flushPromises()
    expect(visiblePage(wrapper.element, 'group')).toBe(true)

    // Ionic's edge swipe starts an interactive back transition...
    const handler = outlet.swipeHandler!
    expect(handler.canStart()).toBe(true)
    const swiping = handler.onStart()
    await flushPromises()
    // ...and iOS's own back gesture pops history underneath it before Ionic's animation finishes.
    router.back()
    await flushPromises()
    // Ionic finishes its animation, then reports the completed swipe.
    swipeCommit.current!.resolve(true)
    await swiping
    handler.onEnd(true)
    await flushPromises()
    expect(router.currentRoute.value.path).toBe('/home')

    // Re-opening the group must run a real transition and leave it visible (the blank-screen bug skipped it).
    commit.mockClear()
    await router.push('/group')
    await flushPromises()
    expect(commit).toHaveBeenCalled()
    expect(visiblePage(wrapper.element, 'group')).toBe(true)
  })

  it('still skips the duplicate transition when Ionic alone completes the swipe', async () => {
    const { router, wrapper, outlet, commit, swipeCommit } = await mountStack()
    await router.push('/group')
    await flushPromises()

    const handler = outlet.swipeHandler!
    const swiping = handler.onStart()
    await flushPromises()
    swipeCommit.current!.resolve(true)
    await swiping
    commit.mockClear()
    handler.onEnd(true)
    await flushPromises()

    expect(router.currentRoute.value.path).toBe('/home')
    // The swipe already animated this pair; the route change it triggers must not animate it again.
    expect(commit).not.toHaveBeenCalled()
    expect(visiblePage(wrapper.element, 'home')).toBe(true)

    await router.push('/group')
    await flushPromises()
    expect(commit).toHaveBeenCalled()
    expect(visiblePage(wrapper.element, 'group')).toBe(true)
  })
})
