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

  it('skips only the back transition that Safari already animated', () => {
    const els = () => ({ enteringEl: document.createElement('div'), leavingEl: document.createElement('div') })
    let browserBackAt: number | undefined = 1000
    let time = 1200
    const builder = createRouteAnimation({
      matchMedia: () => ({ matches: false } as MediaQueryList),
      browserOwnsBack: () => true,
      lastBrowserBackAt: () => browserBackAt,
      now: () => time,
    })

    expect(builder(document.createElement('div'), { ...els(), direction: 'back' }).getDuration()).toBe(1)
    expect(builder(document.createElement('div'), { ...els(), direction: 'forward' }).getDuration()).toBe(540)
    time = 2500
    expect(builder(document.createElement('div'), { ...els(), direction: 'back' }).getDuration()).toBe(540)
    browserBackAt = undefined
    time = 1200
    expect(builder(document.createElement('div'), { ...els(), direction: 'back' }).getDuration()).toBe(540)
  })

  it('keeps Ionic back transitions where the browser has no gesture of its own', () => {
    const builder = createRouteAnimation({
      matchMedia: () => ({ matches: false } as MediaQueryList),
      browserOwnsBack: () => false,
      lastBrowserBackAt: () => 1000,
      now: () => 1100,
    })
    expect(builder(document.createElement('div'), { enteringEl: document.createElement('div'), leavingEl: document.createElement('div'), direction: 'back' }).getDuration()).toBe(540)
  })

  it('treats a popstate right after an in-page tap as the app Back button, not the browser gesture', async () => {
    vi.resetModules()
    const now = vi.spyOn(performance, 'now')
    const { browserOwnsBackGesture: _unused, createRouteAnimation: create } = await import('../navigation')
    const builder = create()
    const back = () => builder(document.createElement('div'), { enteringEl: document.createElement('div'), leavingEl: document.createElement('div'), direction: 'back' }).getDuration()

    now.mockReturnValue(5000); window.dispatchEvent(new PopStateEvent('popstate'))
    now.mockReturnValue(5100)
    expect(back()).toBe(1)

    now.mockReturnValue(9000); window.dispatchEvent(new MouseEvent('click'))
    now.mockReturnValue(9200); window.dispatchEvent(new PopStateEvent('popstate'))
    now.mockReturnValue(9300)
    expect(back()).toBe(540)
    now.mockRestore()
  })
})
