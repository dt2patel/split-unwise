import type { Directive, DirectiveBinding } from 'vue'
import { restoreInteractiveFocus } from '../../../app/focus'

type IonicControl = HTMLElement & {
  setFocus?: () => Promise<void>
  getInputElement?: () => Promise<HTMLElement>
}

/**
 * Moves focus to a sheet control. An ion-input keeps its native field inside the host, and a segment button keeps
 * its native button in shadow DOM, so Ionic controls are focused through their own setFocus().
 */
export function focusSheetControl(element: Element | null | undefined): void {
  const control = element as IonicControl | null | undefined
  if (typeof control?.setFocus === 'function') void control.setFocus()
  else restoreInteractiveFocus(control)
}

export interface FieldAria {
  readonly 'aria-invalid'?: 'true'
  readonly 'aria-describedby'?: string
}

/**
 * Writes live validation ARIA onto the element that actually receives focus. ion-input copies aria-* attributes to
 * its native input only when it first loads, so an error that appears later would otherwise never reach that input.
 */
export const vFieldAria: Directive<HTMLElement, FieldAria> = {
  mounted: writeFieldAria,
  updated: writeFieldAria,
}

function writeFieldAria(element: HTMLElement, { value }: DirectiveBinding<FieldAria>): void {
  const write = (target: HTMLElement) => {
    for (const name of ['aria-invalid', 'aria-describedby'] as const) {
      const next = value[name]
      if (next === undefined) target.removeAttribute(name)
      else target.setAttribute(name, next)
    }
  }
  const control = element as IonicControl
  if (typeof control.getInputElement === 'function') void control.getInputElement().then(write)
  else write(element)
}
