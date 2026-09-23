import { iosTransitionAnimation, type AnimationBuilder } from '@ionic/vue'

export interface RouteMotionCapabilities {
  readonly matchMedia?: (query: string) => MediaQueryList
  /** True in a browser tab, where Safari's own edge swipe and back button already animate the page change. */
  readonly browserOwnsBack?: () => boolean
  /** Takes (and clears) when the browser itself last moved through history — edge swipe back or forward, toolbar arrows — in the same clock as `now`. */
  readonly takeBrowserHistoryNavigation?: () => number | undefined
  readonly now?: () => number
}

// A browser history gesture commits its popstate just before Ionic builds the matching transition.
const historyNavigationWindow = 1000

/** Ionic's native iOS push/pop at its own duration, minus the motion that reduced-motion or a browser-drawn history gesture already covers. */
export function createRouteAnimation(capabilities?: RouteMotionCapabilities): AnimationBuilder {
  const matchMedia = capabilities ? capabilities.matchMedia : browserMatchMedia()
  const browserOwnsBack = capabilities ? capabilities.browserOwnsBack : () => browserOwnsBackGesture()
  const takeBrowserHistoryNavigation = capabilities ? capabilities.takeBrowserHistoryNavigation : takePendingBrowserHistoryNavigation
  const now = capabilities?.now ?? clock
  return (baseEl, options) => {
    const animation = iosTransitionAnimation(baseEl, options)
    if (matchMedia?.('(prefers-reduced-motion: reduce)').matches) return animation.duration(0)
    // iOS already slid the page in (edge swipe back or forward); a second Ionic slide on top reads as a glitch.
    // The marker belongs to that one transition, so it is taken here and a later tap-driven navigation still animates.
    if (browserOwnsBack?.()) {
      const at = takeBrowserHistoryNavigation?.()
      if (at !== undefined && now() - at < historyNavigationWindow) return animation.duration(0)
    }
    return animation
  }
}

/**
 * On the web the browser owns edge-swipe back: Safari tabs and, as recorded on iOS 27, home-screen web apps too
 * (the system gesture pops history before Ionic's own swipe finishes). Only the native shell has no system gesture.
 */
export function browserOwnsBackGesture(native = false): boolean {
  return !native && typeof window !== 'undefined'
}

// Ionic's own Back button also pops history, but it always follows a tap; iOS's edge swipes and toolbar arrows never deliver one.
const inPageTapWindow = 600
let lastTapAt = Number.NEGATIVE_INFINITY
let pendingBrowserHistoryNavigation: number | undefined
if (typeof window !== 'undefined') {
  // A tap starts an app-driven navigation, so it cancels any browser history move still waiting for its transition.
  window.addEventListener('click', () => { lastTapAt = clock(); pendingBrowserHistoryNavigation = undefined }, { capture: true, passive: true })
  window.addEventListener('popstate', () => {
    const at = clock()
    pendingBrowserHistoryNavigation = at - lastTapAt < inPageTapWindow ? undefined : at
  })
}

function takePendingBrowserHistoryNavigation(): number | undefined {
  const at = pendingBrowserHistoryNavigation
  pendingBrowserHistoryNavigation = undefined
  return at
}

function clock(): number { return typeof performance === 'undefined' ? Date.now() : performance.now() }

function browserMatchMedia(): RouteMotionCapabilities['matchMedia'] | undefined {
  return typeof window !== 'undefined' && typeof window.matchMedia === 'function'
    ? window.matchMedia.bind(window)
    : undefined
}
