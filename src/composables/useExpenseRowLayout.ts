import { onMounted, onUnmounted, ref } from 'vue'

/** Switches an expense row to its vertical layout only after real rendered overflow is observed. */
export function useExpenseRowLayout() {
  const row = ref<HTMLElement | null>(null)
  const isReflow = ref(false)
  let observer: ResizeObserver | undefined
  let frame: number | undefined
  let lastMeasuredWidth: number | undefined
  let contentChanged = true

  const measure = () => {
    const element = row.value
    if (!element) return

    const availableWidth = element.clientWidth
    if (isReflow.value && !contentChanged && availableWidth === lastMeasuredWidth) return

    isReflow.value = element.scrollWidth > availableWidth
    lastMeasuredWidth = availableWidth
    contentChanged = false
  }
  const scheduleMeasure = () => {
    if (frame !== undefined) cancelFrame(frame)
    frame = requestFrame(() => { frame = undefined; measure() })
  }
  const invalidateContent = () => {
    contentChanged = true
    scheduleMeasure()
  }

  onMounted(() => {
    const element = row.value
    if (!element || typeof ResizeObserver === 'undefined') return
    observer = new ResizeObserver(scheduleMeasure)
    observer.observe(element)
    scheduleMeasure()
  })
  onUnmounted(() => {
    observer?.disconnect()
    if (frame !== undefined) cancelFrame(frame)
  })

  return { row, isReflow, invalidateContent }
}

function requestFrame(callback: FrameRequestCallback): number {
  return typeof requestAnimationFrame === 'function' ? requestAnimationFrame(callback) : window.setTimeout(() => callback(0), 0)
}

function cancelFrame(frame: number): void {
  if (typeof cancelAnimationFrame === 'function') cancelAnimationFrame(frame)
  else window.clearTimeout(frame)
}
