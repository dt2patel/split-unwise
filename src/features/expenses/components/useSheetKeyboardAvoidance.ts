import { onBeforeUnmount, onMounted, type Ref } from 'vue'

const FIELD_MARGIN = 20

export function useSheetKeyboardAvoidance(sheet: Ref<HTMLElement | undefined>): void {
  let release: (() => void) | undefined

  onMounted(() => {
    if (sheet.value) release = bindSheetKeyboardAvoidance(sheet.value)
  })
  onBeforeUnmount(() => release?.())
}

function bindSheetKeyboardAvoidance(sheet: HTMLElement, host: Window = window): () => void {
  const viewport = host.visualViewport
  let stopped = false

  function metrics(): { readonly height: number; readonly top: number; readonly bottom: number } {
    const height = viewport?.height ?? host.innerHeight
    const top = viewport?.offsetTop ?? 0
    return { height, top, bottom: top + height }
  }

  function ensureVisible(target: HTMLElement): void {
    const { top: visibleTop, bottom: visibleBottom } = metrics()
    const field = target.getBoundingClientRect()
    const below = field.bottom - (visibleBottom - FIELD_MARGIN)
    const above = (visibleTop + FIELD_MARGIN) - field.top
    const delta = below > 0 ? below : (above > 0 ? -above : 0)
    if (!delta) return

    const behavior: ScrollBehavior = typeof host.matchMedia === 'function' && host.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth'
    if (typeof sheet.scrollBy === 'function') sheet.scrollBy({ top: Math.ceil(delta), behavior })
    else sheet.scrollTop += Math.ceil(delta)
  }

  function scheduleVisibilityCheck(target: HTMLElement | null): void {
    if (!target || !sheet.contains(target)) return
    const check = () => { if (!stopped) ensureVisible(target) }
    if (typeof host.requestAnimationFrame === 'function') host.requestAnimationFrame(check)
    else check()
  }

  function updateViewport(): void {
    const { bottom } = metrics()
    const keyboardInset = Math.max(0, host.innerHeight - bottom)
    sheet.style.setProperty('--su-keyboard-inset', `${Math.round(keyboardInset)}px`)
    scheduleVisibilityCheck(host.document.activeElement instanceof HTMLElement ? host.document.activeElement : null)
  }

  function onFocus(event: FocusEvent): void {
    scheduleVisibilityCheck(event.target instanceof HTMLElement ? event.target : null)
  }

  sheet.addEventListener('focusin', onFocus)
  host.addEventListener('resize', updateViewport)
  viewport?.addEventListener('resize', updateViewport)
  viewport?.addEventListener('scroll', updateViewport)
  updateViewport()

  return () => {
    stopped = true
    sheet.removeEventListener('focusin', onFocus)
    host.removeEventListener('resize', updateViewport)
    viewport?.removeEventListener('resize', updateViewport)
    viewport?.removeEventListener('scroll', updateViewport)
  }
}
