import { beforeEach, describe, expect, it, vi } from 'vitest'

const alerts = vi.hoisted(() => ({ created: [] as unknown[], role: 'cancel' as string | undefined }))
vi.mock('@ionic/vue', () => ({
  alertController: {
    create: vi.fn(async (options: unknown) => {
      alerts.created.push(options)
      return { present: vi.fn(async () => undefined), onDidDismiss: vi.fn(async () => ({ role: alerts.role })) }
    }),
  },
}))

import { confirmAction } from '../confirmDialog'

describe('confirmAction', () => {
  beforeEach(() => { alerts.created.length = 0; alerts.role = 'cancel' })

  it('shows an Ionic alert with cancel and confirm buttons and resolves true only for confirm', async () => {
    alerts.role = 'destructive'
    await expect(confirmAction({ message: 'Discard this group draft?', confirmText: 'Discard', cancelText: 'Keep editing', destructive: true })).resolves.toBe(true)
    expect(alerts.created[0]).toEqual({
      message: 'Discard this group draft?',
      buttons: [{ text: 'Keep editing', role: 'cancel' }, { text: 'Discard', role: 'destructive' }],
    })

    alerts.role = 'cancel'
    await expect(confirmAction({ message: 'Discard?', confirmText: 'Discard', cancelText: 'Keep editing', destructive: true })).resolves.toBe(false)
    alerts.role = 'backdrop'
    await expect(confirmAction({ message: 'Discard?', confirmText: 'Discard', cancelText: 'Keep editing', destructive: true })).resolves.toBe(false)
  })

  it('uses a confirm role for non-destructive actions', async () => {
    alerts.role = 'confirm'
    await expect(confirmAction({ header: 'Leave?', message: 'Unsaved changes', confirmText: 'Leave', cancelText: 'Stay' })).resolves.toBe(true)
    expect(alerts.created[0]).toMatchObject({ header: 'Leave?', buttons: [{ role: 'cancel' }, { text: 'Leave', role: 'confirm' }] })
  })
})
