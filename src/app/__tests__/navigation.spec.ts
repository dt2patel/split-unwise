import { describe, expect, it } from 'vitest'
import { createRouteAnimation } from '../navigation'

describe('route navigation animation', () => {
  it('uses a 320ms Ionic animation for normal iOS navigation', () => {
    const animation = createRouteAnimation({ matchMedia: () => ({ matches: false } as MediaQueryList) })(document.createElement('div'), {
      enteringEl: document.createElement('div'),
      leavingEl: document.createElement('div'),
      direction: 'forward',
    })

    expect(animation.getDuration()).toBe(320)
  })

  it('reads the current reduced-motion preference at navigation time', () => {
    let reduced = false
    const builder = createRouteAnimation({ matchMedia: () => ({ get matches() { return reduced } } as MediaQueryList) })

    expect(builder(document.createElement('div'), { enteringEl: document.createElement('div'), leavingEl: document.createElement('div'), direction: 'forward' }).getDuration()).toBe(320)
    reduced = true
    // Ionic's public animation API clamps a requested 0ms duration to one immediate frame.
    expect(builder(document.createElement('div'), { enteringEl: document.createElement('div'), leavingEl: document.createElement('div'), direction: 'back' }).getDuration()).toBe(1)
  })
})
