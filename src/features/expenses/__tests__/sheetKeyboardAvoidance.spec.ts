import { mount } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import ReceiptReview from '../components/ReceiptReview.vue'
import { bindSheetKeyboardAvoidance } from '../components/useSheetKeyboardAvoidance'

const members = [
  { id: 'maya-p', displayName: 'Maya P.', initials: 'MP', isCurrentUser: true },
]

class TestVisualViewport extends EventTarget {
  height = 844
  offsetTop = 0
}

let originalVisualViewport: PropertyDescriptor | undefined
let originalInnerHeight: PropertyDescriptor | undefined

beforeEach(() => {
  originalVisualViewport = Object.getOwnPropertyDescriptor(window, 'visualViewport')
  originalInnerHeight = Object.getOwnPropertyDescriptor(window, 'innerHeight')
  Object.defineProperty(window, 'innerHeight', { configurable: true, value: 844 })
  vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => {
    callback(0)
    return 1
  })
})

afterEach(() => {
  vi.restoreAllMocks()
  if (originalVisualViewport) Object.defineProperty(window, 'visualViewport', originalVisualViewport)
  else Reflect.deleteProperty(window, 'visualViewport')
  if (originalInnerHeight) Object.defineProperty(window, 'innerHeight', originalInnerHeight)
})

describe('expense sheet keyboard avoidance', () => {
  it('uses a distinct Ionic scroll host with non-zero layout bounds under VisualViewport', () => {
    const viewport = new TestVisualViewport()
    viewport.height = 500
    viewport.offsetTop = 50
    Object.defineProperty(window, 'visualViewport', { configurable: true, value: viewport })
    const sheet = document.createElement('section')
    const scrollHost = document.createElement('div')
    const field = document.createElement('textarea')
    scrollHost.append(field)
    sheet.append(scrollHost)
    document.body.append(sheet)
    vi.spyOn(sheet, 'getBoundingClientRect').mockReturnValue(rect({ top: 100, bottom: 900 }))
    vi.spyOn(scrollHost, 'getBoundingClientRect').mockReturnValue(rect({ top: 120, bottom: 760 }))
    vi.spyOn(field, 'getBoundingClientRect').mockReturnValue(rect({ top: 690, bottom: 734 }))
    const scrollBy = vi.fn()
    Object.defineProperty(scrollHost, 'scrollBy', { configurable: true, value: scrollBy })

    const release = bindSheetKeyboardAvoidance(sheet, window, scrollHost)
    field.focus()

    expect(sheet.style.getPropertyValue('--su-keyboard-inset')).toBe('230px')
    expect(scrollBy).toHaveBeenCalledWith({ top: 204, behavior: 'smooth' })
    release()
    sheet.remove()
  })

  it('updates the real keyboard inset and scrolls a focused bottom field into the visual viewport', () => {
    const viewport = new TestVisualViewport()
    Object.defineProperty(window, 'visualViewport', { configurable: true, value: viewport })
    const wrapper = mount(ReceiptReview, { attachTo: document.body, props: {
      modelValue: [], members, currency: 'USD', totalMinorAmount: 1000,
    } })
    const sheet = wrapper.get<HTMLElement>('[data-sheet-scroll]').element
    const tip = wrapper.get<HTMLInputElement>('[data-testid="receipt-tip"]').element
    let scrollBehavior: ScrollBehavior | undefined
    Object.defineProperty(sheet, 'scrollBy', { configurable: true, value: (options: ScrollToOptions) => {
      sheet.scrollTop += options.top ?? 0
      scrollBehavior = options.behavior
    } })
    vi.spyOn(tip, 'getBoundingClientRect').mockReturnValue(rect({ top: 700, bottom: 744 }))
    tip.focus()

    viewport.height = 500
    viewport.dispatchEvent(new Event('resize'))

    expect(sheet.style.getPropertyValue('--su-keyboard-inset')).toBe('344px')
    expect(sheet.style.getPropertyValue('--su-visual-viewport-height')).toBe('')
    expect(sheet.scrollTop).toBeGreaterThanOrEqual(244)
    expect(scrollBehavior).toBe('smooth')
    wrapper.unmount()
  })

  it('scrolls a newly focused bottom field when the visual viewport is already reduced', () => {
    const viewport = new TestVisualViewport()
    viewport.height = 500
    Object.defineProperty(window, 'visualViewport', { configurable: true, value: viewport })
    const wrapper = mount(ReceiptReview, { attachTo: document.body, props: {
      modelValue: [], members, currency: 'USD', totalMinorAmount: 1000,
    } })
    const sheet = wrapper.get<HTMLElement>('[data-sheet-scroll]').element
    const tip = wrapper.get<HTMLInputElement>('[data-testid="receipt-tip"]').element
    let scrollBehavior: ScrollBehavior | undefined
    Object.defineProperty(sheet, 'scrollBy', { configurable: true, value: (options: ScrollToOptions) => {
      sheet.scrollTop += options.top ?? 0
      scrollBehavior = options.behavior
    } })
    vi.spyOn(tip, 'getBoundingClientRect').mockReturnValue(rect({ top: 700, bottom: 744 }))

    tip.focus()

    expect(sheet.scrollTop).toBeGreaterThanOrEqual(244)
    expect(scrollBehavior).toBe('smooth')
    wrapper.unmount()
  })

  it('uses sheet bounds and its sticky header to reveal a focused field hidden under the header', () => {
    const viewport = new TestVisualViewport()
    viewport.height = 500
    Object.defineProperty(window, 'visualViewport', { configurable: true, value: viewport })
    const wrapper = mount(ReceiptReview, { attachTo: document.body, props: {
      modelValue: [], members, currency: 'USD', totalMinorAmount: 1000,
    } })
    const sheet = wrapper.get<HTMLElement>('[data-sheet-scroll]').element
    const header = wrapper.get<HTMLElement>('header').element
    const tip = wrapper.get<HTMLInputElement>('[data-testid="receipt-tip"]').element
    let scrollDelta = 0
    Object.defineProperty(sheet, 'scrollBy', { configurable: true, value: (options: ScrollToOptions) => { scrollDelta += options.top ?? 0 } })
    vi.spyOn(sheet, 'getBoundingClientRect').mockReturnValue(rect({ top: 300, bottom: 800 }))
    vi.spyOn(header, 'getBoundingClientRect').mockReturnValue(rect({ top: 300, bottom: 354 }))
    vi.spyOn(tip, 'getBoundingClientRect').mockReturnValue(rect({ top: 332, bottom: 376 }))

    tip.focus()

    expect(scrollDelta).toBeLessThan(0)
    wrapper.unmount()
  })

  it('uses window resize as a safe fallback when VisualViewport is unavailable', () => {
    Reflect.deleteProperty(window, 'visualViewport')
    const wrapper = mount(ReceiptReview, { attachTo: document.body, props: {
      modelValue: [], members, currency: 'USD', totalMinorAmount: 1000,
    } })
    const sheet = wrapper.get<HTMLElement>('[data-sheet-scroll]').element
    const tip = wrapper.get<HTMLInputElement>('[data-testid="receipt-tip"]').element
    let scrollBehavior: ScrollBehavior | undefined
    Object.defineProperty(sheet, 'scrollBy', { configurable: true, value: (options: ScrollToOptions) => {
      sheet.scrollTop += options.top ?? 0
      scrollBehavior = options.behavior
    } })
    vi.spyOn(tip, 'getBoundingClientRect').mockReturnValue(rect({ top: 700, bottom: 744 }))
    tip.focus()

    Object.defineProperty(window, 'innerHeight', { configurable: true, value: 500 })
    window.dispatchEvent(new Event('resize'))

    expect(sheet.style.getPropertyValue('--su-keyboard-inset')).toBe('0px')
    expect(sheet.style.getPropertyValue('--su-visual-viewport-height')).toBe('')
    expect(sheet.scrollTop).toBeGreaterThanOrEqual(244)
    expect(scrollBehavior).toBe('smooth')
    wrapper.unmount()
  })

  it('removes visual viewport listeners when a sheet unmounts', () => {
    const viewport = new TestVisualViewport()
    Object.defineProperty(window, 'visualViewport', { configurable: true, value: viewport })
    const remove = vi.spyOn(viewport, 'removeEventListener')
    const wrapper = mount(ReceiptReview, { attachTo: document.body, props: {
      modelValue: [], members, currency: 'USD', totalMinorAmount: 1000,
    } })
    const sheet = wrapper.get<HTMLElement>('[data-sheet-scroll]').element
    const removeWindow = vi.spyOn(window, 'removeEventListener')
    const removeSheet = vi.spyOn(sheet, 'removeEventListener')

    wrapper.unmount()
    const insetAfterUnmount = sheet.style.getPropertyValue('--su-keyboard-inset')
    viewport.height = 400
    viewport.dispatchEvent(new Event('resize'))

    expect(remove).toHaveBeenCalledWith('resize', expect.any(Function))
    expect(remove).toHaveBeenCalledWith('scroll', expect.any(Function))
    expect(removeWindow).toHaveBeenCalledWith('resize', expect.any(Function))
    expect(removeSheet).toHaveBeenCalledWith('focusin', expect.any(Function))
    expect(sheet.style.getPropertyValue('--su-keyboard-inset')).toBe(insetAfterUnmount)
  })
})

function rect({ top, bottom }: { top: number; bottom: number }): DOMRect {
  return { top, bottom, height: bottom - top, left: 0, right: 320, width: 320, x: 0, y: top, toJSON: () => ({}) }
}
