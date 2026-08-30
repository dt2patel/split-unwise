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

    const { availableWidth, contentWidth } = measureUnreflowed(element, isReflow.value)
    if (isReflow.value && !contentChanged && availableWidth === lastMeasuredWidth) return

    isReflow.value = contentWidth > availableWidth
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

/**
 * The reflow class intentionally removes the narrow financial grid, so measuring it while
 * active can hide the overflow that originally required reflow. Remove and restore it in the
 * same JavaScript task to read the intrinsic grid without presenting an intermediate layout.
 */
function measureUnreflowed(element: HTMLElement, isReflowed: boolean): { availableWidth: number; contentWidth: number } {
  const reflowClass = 'expense-row--reflow'
  const hadReflowClass = isReflowed && element.classList.contains(reflowClass)
  if (hadReflowClass) element.classList.remove(reflowClass)

  const measurement = { availableWidth: element.clientWidth, contentWidth: element.scrollWidth }

  if (hadReflowClass) element.classList.add(reflowClass)
  return measurement
}

function requestFrame(callback: FrameRequestCallback): number {
  return typeof requestAnimationFrame === 'function' ? requestAnimationFrame(callback) : window.setTimeout(() => callback(0), 0)
}

function cancelFrame(frame: number): void {
  if (typeof cancelAnimationFrame === 'function') cancelAnimationFrame(frame)
  else window.clearTimeout(frame)
}
