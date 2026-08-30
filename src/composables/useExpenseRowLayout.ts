import { onMounted, onUnmounted, ref } from 'vue'

/** Switches an expense row to its vertical layout only after real rendered overflow is observed. */
export function useExpenseRowLayout() {
  const row = ref<HTMLElement | null>(null)
  const isReflow = ref(false)
  let observer: ResizeObserver | undefined
  let frame: number | undefined

  const measure = () => {
    const element = row.value
    if (element) isReflow.value = element.scrollWidth > element.clientWidth
  }
  const scheduleMeasure = () => {
    if (frame !== undefined) cancelFrame(frame)
    frame = requestFrame(() => { frame = undefined; measure() })
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

  return { row, isReflow }
}

function requestFrame(callback: FrameRequestCallback): number {
  return typeof requestAnimationFrame === 'function' ? requestAnimationFrame(callback) : window.setTimeout(() => callback(0), 0)
}

function cancelFrame(frame: number): void {
  if (typeof cancelAnimationFrame === 'function') cancelAnimationFrame(frame)
  else window.clearTimeout(frame)
}
