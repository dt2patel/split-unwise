import { afterEach, describe, expect, it } from 'vitest'
import { restoreInteractiveFocus } from '../focus'

afterEach(() => { document.body.replaceChildren() })

describe('restoreInteractiveFocus', () => {
  it('focuses a native trigger directly', () => {
    const trigger = document.createElement('button')
    document.body.append(trigger)

    restoreInteractiveFocus(trigger)

    expect(document.activeElement).toBe(trigger)
  })

  it('focuses the native button inside an Ionic-style Shadow DOM trigger', () => {
    const trigger = document.createElement('div')
    const shadow = trigger.attachShadow({ mode: 'open' })
    const nativeButton = document.createElement('button')
    shadow.append(nativeButton)
    document.body.append(trigger)

    restoreInteractiveFocus(trigger)

    expect(document.activeElement).toBe(trigger)
    expect(shadow.activeElement).toBe(nativeButton)
  })
})
