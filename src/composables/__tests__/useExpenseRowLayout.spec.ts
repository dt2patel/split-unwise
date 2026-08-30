import { defineComponent, h, nextTick } from 'vue'
import { mount } from '@vue/test-utils'
import { describe, expect, it, vi } from 'vitest'
import { useExpenseRowLayout } from '../useExpenseRowLayout'

class ResizeObserverHarness {
  static instances: ResizeObserverHarness[] = []
  readonly observe = vi.fn()
  readonly disconnect = vi.fn()
  constructor(private readonly callback: ResizeObserverCallback) { ResizeObserverHarness.instances.push(this) }
  trigger() { this.callback([], this as unknown as ResizeObserver) }
}

describe('useExpenseRowLayout', () => {
  it('switches a 390px row to reflow only when measured content overflows and cleans up', async () => {
    ResizeObserverHarness.instances = []
    vi.stubGlobal('ResizeObserver', ResizeObserverHarness)
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { callback(0); return 1 })
    let state: ReturnType<typeof useExpenseRowLayout> | undefined
    const wrapper = mount(defineComponent({
      setup() {
        const layout = useExpenseRowLayout()
        state = layout
        return () => h('article', { ref: layout.row })
      },
    }))
    const element = wrapper.get('article').element
    Object.defineProperties(element, { clientWidth: { configurable: true, value: 390 }, scrollWidth: { configurable: true, value: 390 } })
    ResizeObserverHarness.instances[0].trigger()
    await nextTick()
    expect(state?.isReflow.value).toBe(false)

    Object.defineProperty(element, 'scrollWidth', { configurable: true, value: 434 })
    ResizeObserverHarness.instances[0].trigger()
    await nextTick()
    expect(state?.isReflow.value).toBe(true)

    Object.defineProperty(element, 'scrollWidth', { configurable: true, value: 390 })
    ResizeObserverHarness.instances[0].trigger()
    await nextTick()
    expect(state?.isReflow.value).toBe(true)

    wrapper.unmount()
    expect(ResizeObserverHarness.instances[0].disconnect).toHaveBeenCalledOnce()
  })

  it('probes unreflowed content for invalidation and width changes without dropping the reflow class', async () => {
    ResizeObserverHarness.instances = []
    vi.stubGlobal('ResizeObserver', ResizeObserverHarness)
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { callback(0); return 1 })
    let state: ReturnType<typeof useExpenseRowLayout> | undefined
    const wrapper = mount(defineComponent({
      setup() {
        const layout = useExpenseRowLayout()
        state = layout
        return () => h('article', { ref: layout.row, class: { 'expense-row--reflow': layout.isReflow.value } })
      },
    }))
    const element = wrapper.get('article').element
    let availableWidth = 390
    let unreflowedScrollWidth = 434
    Object.defineProperties(element, {
      clientWidth: { configurable: true, get: () => availableWidth },
      scrollWidth: { configurable: true, get: () => element.classList.contains('expense-row--reflow') ? availableWidth : unreflowedScrollWidth },
    })

    ResizeObserverHarness.instances[0].trigger()
    await nextTick()
    expect(state?.isReflow.value).toBe(true)
    expect(element.classList.contains('expense-row--reflow')).toBe(true)

    state?.invalidateContent()
    await nextTick()
    expect(state?.isReflow.value).toBe(true)
    expect(element.classList.contains('expense-row--reflow')).toBe(true)

    unreflowedScrollWidth = 390
    state?.invalidateContent()
    await nextTick()
    expect(state?.isReflow.value).toBe(false)

    unreflowedScrollWidth = 434
    state?.invalidateContent()
    await nextTick()
    expect(state?.isReflow.value).toBe(true)

    availableWidth = 450
    ResizeObserverHarness.instances[0].trigger()
    await nextTick()
    expect(state?.isReflow.value).toBe(false)

    availableWidth = 390
    ResizeObserverHarness.instances[0].trigger()
    await nextTick()
    expect(state?.isReflow.value).toBe(true)
    expect(element.classList.contains('expense-row--reflow')).toBe(true)

    wrapper.unmount()
    expect(ResizeObserverHarness.instances[0].disconnect).toHaveBeenCalledOnce()
  })
})
