import { iosTransitionAnimation, type AnimationBuilder } from '@ionic/vue'

export interface RouteMotionCapabilities {
  readonly matchMedia?: (query: string) => MediaQueryList
  /** True in a browser tab, where Safari's own edge swipe and back button already animate the page change. */
  readonly browserOwnsBack?: () => boolean
  /** When the browser last navigated through history without an in-page tap (edge swipe, toolbar back), in the same clock as `now`. */
  readonly lastBrowserBackAt?: () => number | undefined
  readonly now?: () => number
}

const routeDuration = 320
// A browser back gesture commits its popstate just before Ionic builds the pop transition.
const historyNavigationWindow = 1000

/** Keeps Ionic's native iOS push/pop behavior while enforcing the product route duration. */
export function createRouteAnimation(capabilities?: RouteMotionCapabilities): AnimationBuilder {
  const matchMedia = capabilities ? capabilities.matchMedia : browserMatchMedia()
  const browserOwnsBack = capabilities ? capabilities.browserOwnsBack : () => browserOwnsBackGesture()
  const lastBrowserBackAt = capabilities ? capabilities.lastBrowserBackAt : () => lastBrowserBack
  const now = capabilities?.now ?? clock
  return (baseEl, options) => {
    const animation = iosTransitionAnimation(baseEl, options)
    if (matchMedia?.('(prefers-reduced-motion: reduce)').matches) return animation.duration(0)
    // Safari already slid the previous page in; a second Ionic pop on top reads as a glitch mid-transition.
    const at = lastBrowserBackAt?.()
    if (options.direction === 'back' && browserOwnsBack?.() && at !== undefined && now() - at < historyNavigationWindow) return animation.duration(0)
    return animation.duration(routeDuration)
  }
}

/** A browser tab (not the home-screen app or the native shell) draws its own back gesture; Ionic's would fight it. */
export function browserOwnsBackGesture(native = false): boolean {
  if (native || typeof window === 'undefined') return false
  const standalone = (typeof window.matchMedia === 'function' && window.matchMedia('(display-mode: standalone)').matches)
    || (navigator as Navigator & { standalone?: boolean }).standalone === true
  return !standalone
}

// Ionic's own Back button also pops history, but it always follows a tap; Safari's edge swipe and toolbar back never deliver one.
const inPageTapWindow = 600
let lastTapAt = Number.NEGATIVE_INFINITY
let lastBrowserBack: number | undefined
if (typeof window !== 'undefined') {
  window.addEventListener('click', () => { lastTapAt = clock() }, { capture: true, passive: true })
  window.addEventListener('popstate', () => {
    const at = clock()
    lastBrowserBack = at - lastTapAt < inPageTapWindow ? undefined : at
  })
}

function clock(): number { return typeof performance === 'undefined' ? Date.now() : performance.now() }

function browserMatchMedia(): RouteMotionCapabilities['matchMedia'] | undefined {
  return typeof window !== 'undefined' && typeof window.matchMedia === 'function'
    ? window.matchMedia.bind(window)
    : undefined
}
