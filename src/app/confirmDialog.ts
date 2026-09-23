import { alertController } from '@ionic/vue'

export interface ConfirmOptions {
  readonly message: string
  readonly confirmText: string
  readonly cancelText: string
  readonly header?: string
  /** Styles the confirm button as destructive (iOS red), e.g. discarding a draft. */
  readonly destructive?: boolean
}

/**
 * Ionic's iOS alert in place of window.confirm: themed, localized, labeled as the app rather than the website,
 * and it doesn't block the page (or freeze a sheet mid-swipe) while it is open.
 */
export async function confirmAction(options: ConfirmOptions): Promise<boolean> {
  const confirmRole = options.destructive ? 'destructive' : 'confirm'
  const alert = await alertController.create({
    ...(options.header ? { header: options.header } : {}),
    message: options.message,
    buttons: [
      { text: options.cancelText, role: 'cancel' },
      { text: options.confirmText, role: confirmRole },
    ],
  })
  await alert.present()
  const { role } = await alert.onDidDismiss()
  return role === confirmRole
}
