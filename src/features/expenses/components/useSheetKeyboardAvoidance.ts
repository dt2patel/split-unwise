import { onBeforeUnmount, onMounted, type Ref } from 'vue'

const FIELD_MARGIN = 20

export interface SheetKeyboardAvoidanceOptions {
  readonly resolveScrollHost?: (sheet: HTMLElement) => HTMLElement | Promise<HTMLElement>
}

export function resolveSheetScrollHost(sheet: HTMLElement): HTMLElement | Promise<HTMLElement> {
  const content = sheet.closest('ion-content') as (HTMLElement & { getScrollElement?: () => Promise<HTMLElement> }) | null
  return content?.getScrollElement?.() ?? sheet
}

export function useSheetKeyboardAvoidance(sheet: Ref<HTMLElement | undefined>, options: SheetKeyboardAvoidanceOptions = {}): void {
  let release: (() => void) | undefined
  let stopped = false

  onMounted(() => {
    const element = sheet.value
    if (!element) return
    const resolved = (options.resolveScrollHost ?? resolveSheetScrollHost)(element)
    if (resolved instanceof Promise) {
      void resolved.then((scrollHost) => { if (!stopped) release = bindSheetKeyboardAvoidance(element, window, scrollHost) })
      return
    }
    release = bindSheetKeyboardAvoidance(element, window, resolved)
  })
  onBeforeUnmount(() => { stopped = true; release?.() })
}

export function bindSheetKeyboardAvoidance(sheet: HTMLElement, host: Window = window, scrollHost: HTMLElement = sheet): () => void {
  const viewport = host.visualViewport
  let stopped = false

  function metrics(): { readonly height: number; readonly top: number; readonly bottom: number } {
    const height = viewport?.height ?? host.innerHeight
    const top = viewport?.offsetTop ?? 0
    return { height, top, bottom: top + height }
  }

  function visibleBounds(): { readonly top: number; readonly bottom: number; readonly sheetBottom: number } {
    const viewportMetrics = metrics()
    const sheetBounds = scrollHost.getBoundingClientRect()
    // jsdom and detached host fallbacks expose an empty rectangle; window metrics
    // remain the truthful available surface in that case.
    if (sheetBounds.height <= 0 || sheetBounds.bottom <= sheetBounds.top) {
      return { top: viewportMetrics.top, bottom: viewportMetrics.bottom, sheetBottom: host.innerHeight }
    }
    const header = sheet.querySelector<HTMLElement>('.expense-sheet__header, header')
    const headerBottom = header?.getBoundingClientRect().bottom ?? sheetBounds.top
    return {
      top: Math.max(viewportMetrics.top, sheetBounds.top, headerBottom) + FIELD_MARGIN,
      bottom: Math.min(viewportMetrics.bottom, sheetBounds.bottom) - FIELD_MARGIN,
      sheetBottom: sheetBounds.bottom,
    }
  }

  function ensureVisible(target: HTMLElement): void {
    const { top: visibleTop, bottom: visibleBottom } = visibleBounds()
    const field = target.getBoundingClientRect()
    const below = field.bottom - visibleBottom
    const above = visibleTop - field.top
    const delta = below > 0 ? below : (above > 0 ? -above : 0)
    if (!delta) return

    const behavior: ScrollBehavior = typeof host.matchMedia === 'function' && host.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth'
    if (typeof scrollHost.scrollBy === 'function') scrollHost.scrollBy({ top: Math.ceil(delta), behavior })
    else scrollHost.scrollTop += Math.ceil(delta)
  }

  function scheduleVisibilityCheck(target: HTMLElement | null): void {
    if (!target || !sheet.contains(target)) return
    const check = () => { if (!stopped) ensureVisible(target) }
    if (typeof host.requestAnimationFrame === 'function') host.requestAnimationFrame(check)
    else check()
  }

  function updateViewport(): void {
    const { bottom, sheetBottom } = visibleBounds()
    const keyboardInset = Math.max(0, sheetBottom - bottom)
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
