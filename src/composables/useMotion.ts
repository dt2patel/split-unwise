import { computed, onMounted, onUnmounted, ref } from 'vue'

export interface MotionCapabilities {
  readonly matchMedia?: (query: string) => MediaQueryList
}

export interface MotionTimings {
  readonly fast: number
  readonly route: number
  readonly row: number
  readonly press: number
}

const standardTimings: MotionTimings = { fast: 180, route: 320, row: 200, press: 160 }
const immediateTimings: MotionTimings = { fast: 0, route: 0, row: 0, press: 0 }

/** Provides custom-motion timings while respecting the system motion preference. */
export function useMotion(capabilities?: MotionCapabilities) {
  const matchMedia = capabilities ? capabilities.matchMedia : browserMatchMedia()
  const mediaQuery = matchMedia?.('(prefers-reduced-motion: reduce)')
  const reducedMotion = ref(mediaQuery?.matches ?? false)
  const updatePreference = (event: MediaQueryListEvent) => { reducedMotion.value = event.matches }

  onMounted(() => mediaQuery?.addEventListener?.('change', updatePreference))
  onUnmounted(() => mediaQuery?.removeEventListener?.('change', updatePreference))

  const timings = computed<MotionTimings>(() => reducedMotion.value ? immediateTimings : standardTimings)
  const className = computed(() => reducedMotion.value ? 'su-motion--reduced' : 'su-motion--standard')
  const transitionStyle = computed(() => `transition-duration: ${timings.value.fast}ms`)

  return { reducedMotion, timings, className, transitionStyle }
}

function browserMatchMedia(): MotionCapabilities['matchMedia'] | undefined {
  return typeof window !== 'undefined' && typeof window.matchMedia === 'function'
    ? window.matchMedia.bind(window)
    : undefined
}
