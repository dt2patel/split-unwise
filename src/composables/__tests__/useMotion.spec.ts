import { defineComponent } from 'vue'
import { mount } from '@vue/test-utils'
import { describe, expect, it, vi } from 'vitest'
import { useHaptics } from '../useHaptics'
import { useMotion } from '../useMotion'
import { useNetwork } from '../useNetwork'

function mountComposable<T>(useValue: () => T) {
  let value: T | undefined
  mount(defineComponent({ setup() { value = useValue(); return () => null } }))
  return () => value as T
}

describe('useMotion', () => {
  it('switches to immediate motion and a reduced class when the user prefers reduced motion', () => {
    const listeners = new Set<(event: MediaQueryListEvent) => void>()
    const mediaQuery = {
      matches: true,
      addEventListener: vi.fn((_event: string, listener: (event: MediaQueryListEvent) => void) => listeners.add(listener)),
      removeEventListener: vi.fn((_event: string, listener: (event: MediaQueryListEvent) => void) => listeners.delete(listener)),
    }
    const read = mountComposable(() => useMotion({ matchMedia: vi.fn(() => mediaQuery as unknown as MediaQueryList) }))

    expect(read().className.value).toBe('su-motion--reduced')
    expect(read().timings.value).toEqual({ fast: 0, route: 0, row: 0, press: 0 })
    expect(read().transitionStyle.value).toBe('transition-duration: 0ms')
  })

  it('does not access matchMedia during module import and unregisters its listener on unmount', () => {
    const addEventListener = vi.fn()
    const removeEventListener = vi.fn()
    const wrapper = mount(defineComponent({
      setup() {
        useMotion({ matchMedia: () => ({ matches: false, addEventListener, removeEventListener } as unknown as MediaQueryList) })
        return () => null
      },
    }))

    expect(addEventListener).toHaveBeenCalledWith('change', expect.any(Function))
    wrapper.unmount()
    expect(removeEventListener).toHaveBeenCalledWith('change', expect.any(Function))
  })
})

describe('capability composables', () => {
  it('are safe without browser capabilities and do not turn connectivity into a write-success claim', async () => {
    const motion = mountComposable(() => useMotion({}))
    const network = mountComposable(() => useNetwork({}))
    const haptics = useHaptics({})

    expect(motion().reducedMotion.value).toBe(false)
    expect(network().status.value).toBe('unknown')
    expect(network().canAttemptNetwork.value).toBe(false)
    expect('writeSucceeded' in network()).toBe(false)
    await expect(haptics.light()).resolves.toBe(false)
  })

  it('cleans up online and offline listeners when the network consumer unmounts', () => {
    const addEventListener = vi.fn()
    const removeEventListener = vi.fn()
    const browserWindow = { addEventListener, removeEventListener }
    const wrapper = mount(defineComponent({
      setup() {
        useNetwork({ window: browserWindow, navigator: { onLine: true } })
        return () => null
      },
    }))

    expect(addEventListener).toHaveBeenCalledWith('online', expect.any(Function))
    expect(addEventListener).toHaveBeenCalledWith('offline', expect.any(Function))
    wrapper.unmount()
    expect(removeEventListener).toHaveBeenCalledWith('online', expect.any(Function))
    expect(removeEventListener).toHaveBeenCalledWith('offline', expect.any(Function))
  })
})
