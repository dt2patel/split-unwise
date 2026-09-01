const INTERACTIVE_SELECTOR = [
  'button:not([disabled])',
  'a[href]',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(',')

export function restoreInteractiveFocus(target: HTMLElement | null | undefined): void {
  if (!target) return

  target.focus()
  if (document.activeElement === target) return

  target.shadowRoot?.querySelector<HTMLElement>(INTERACTIVE_SELECTOR)?.focus()
}
