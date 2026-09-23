import { describe, expect, it, vi } from 'vitest'
import { createRouteAnimation } from '../navigation'

describe('route navigation animation', () => {
  it("uses Ionic's native iOS transition duration for normal navigation", () => {
    const animation = createRouteAnimation({ matchMedia: () => ({ matches: false } as MediaQueryList) })(document.createElement('div'), {
      enteringEl: document.createElement('div'),
      leavingEl: document.createElement('div'),
      direction: 'forward',
    })

    expect(animation.getDuration()).toBe(540)
  })

  it('reads the current reduced-motion preference at navigation time', () => {
    let reduced = false
    const builder = createRouteAnimation({ matchMedia: () => ({ get matches() { return reduced } } as MediaQueryList) })

    expect(builder(document.createElement('div'), { enteringEl: document.createElement('div'), leavingEl: document.createElement('div'), direction: 'forward' }).getDuration()).toBe(540)
    reduced = true
    // Ionic's public animation API clamps a requested 0ms duration to one immediate frame.
    expect(builder(document.createElement('div'), { enteringEl: document.createElement('div'), leavingEl: document.createElement('div'), direction: 'back' }).getDuration()).toBe(1)
  })

  it('skips the one transition the browser already animated, back or forward', () => {
    const els = () => ({ enteringEl: document.createElement('div'), leavingEl: document.createElement('div') })
    let pending: number | undefined
    let time = 1200
    const builder = createRouteAnimation({
      matchMedia: () => ({ matches: false } as MediaQueryList),
      browserOwnsBack: () => true,
      takeBrowserHistoryNavigation: () => { const at = pending; pending = undefined; return at },
      now: () => time,
    })
    const duration = (direction: 'back' | 'forward') => builder(document.createElement('div'), { ...els(), direction }).getDuration()

    pending = 1000
    expect(duration('back')).toBe(1)
    // The marker was used up by that transition, so the next one animates.
    expect(duration('back')).toBe(540)
    pending = 1000
    expect(duration('forward')).toBe(1)
    pending = 1000
    time = 2500
    expect(duration('back')).toBe(540)
    expect(duration('forward')).toBe(540)
  })

  it('keeps Ionic transitions where the browser has no gesture of its own', () => {
    const builder = createRouteAnimation({
      matchMedia: () => ({ matches: false } as MediaQueryList),
      browserOwnsBack: () => false,
      takeBrowserHistoryNavigation: () => 1000,
      now: () => 1100,
    })
    expect(builder(document.createElement('div'), { enteringEl: document.createElement('div'), leavingEl: document.createElement('div'), direction: 'back' }).getDuration()).toBe(540)
    expect(builder(document.createElement('div'), { enteringEl: document.createElement('div'), leavingEl: document.createElement('div'), direction: 'forward' }).getDuration()).toBe(540)
  })

  it('tells browser history gestures apart from taps', async () => {
    vi.resetModules()
    const now = vi.spyOn(performance, 'now')
    const { createRouteAnimation: create } = await import('../navigation')
    const builder = create()
    const duration = (direction: 'back' | 'forward') => builder(document.createElement('div'), { enteringEl: document.createElement('div'), leavingEl: document.createElement('div'), direction }).getDuration()

    // iOS edge swipe back: popstate with no tap first.
    now.mockReturnValue(5000); window.dispatchEvent(new PopStateEvent('popstate'))
    now.mockReturnValue(5100)
    expect(duration('back')).toBe(1)

    // iOS edge swipe forward.
    now.mockReturnValue(6000); window.dispatchEvent(new PopStateEvent('popstate'))
    now.mockReturnValue(6100)
    expect(duration('forward')).toBe(1)

    // A tap right after a swipe (617ms apart on device) starts its own navigation, which must animate.
    now.mockReturnValue(7000); window.dispatchEvent(new PopStateEvent('popstate'))
    now.mockReturnValue(7617); window.dispatchEvent(new MouseEvent('click'))
    now.mockReturnValue(7650)
    expect(duration('forward')).toBe(540)

    // The app's Back button pops history right after a tap: Ionic animates it.
    now.mockReturnValue(9000); window.dispatchEvent(new MouseEvent('click'))
    now.mockReturnValue(9200); window.dispatchEvent(new PopStateEvent('popstate'))
    now.mockReturnValue(9300)
    expect(duration('back')).toBe(540)
    now.mockRestore()
  })

  it('leaves the back gesture to the browser in every web context and to Ionic only in the native shell', async () => {
    const { browserOwnsBackGesture } = await import('../navigation')
    expect(browserOwnsBackGesture()).toBe(true)
    expect(browserOwnsBackGesture(false)).toBe(true)
    expect(browserOwnsBackGesture(true)).toBe(false)
  })
})
