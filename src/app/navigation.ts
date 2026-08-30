import { iosTransitionAnimation, type AnimationBuilder } from '@ionic/vue'

export interface RouteMotionCapabilities {
  readonly matchMedia?: (query: string) => MediaQueryList
}

const routeDuration = 320

/** Keeps Ionic's native iOS push/pop behavior while enforcing the product route duration. */
export function createRouteAnimation(capabilities?: RouteMotionCapabilities): AnimationBuilder {
  const matchMedia = capabilities ? capabilities.matchMedia : browserMatchMedia()
  return (baseEl, options) => {
    const animation = iosTransitionAnimation(baseEl, options)
    return animation.duration(matchMedia?.('(prefers-reduced-motion: reduce)').matches ? 0 : routeDuration)
  }
}

function browserMatchMedia(): RouteMotionCapabilities['matchMedia'] | undefined {
  return typeof window !== 'undefined' && typeof window.matchMedia === 'function'
    ? window.matchMedia.bind(window)
    : undefined
}
