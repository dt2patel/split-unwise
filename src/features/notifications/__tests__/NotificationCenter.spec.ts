import { flushPromises, mount } from '@vue/test-utils'
import { beforeEach, describe, expect, it } from 'vitest'
import { CommandFailedError, CommandQueue, createMemoryCommandStorage } from '../../../data/commandQueue'
import { createDemoRepository } from '../../../data/demoRepository'
import { appPrincipalKey, createAppSession, getAppSession, setAppSessionForTesting } from '../../../data/session'
import NotificationCenter from '../NotificationCenter.vue'

const principalKey = appPrincipalKey({ mode: 'demo', projectId: 'split-unwise-demo', uid: 'maya-p' })
const ionicStubs = {
  IonButton: { props: ['disabled'], template: '<button type="button" :disabled="disabled"><slot /></button>' },
  IonToggle: {
    props: ['modelValue'], emits: ['ionChange'],
    template: '<input type="checkbox" :checked="modelValue" @change="$emit(\'ionChange\', { detail: { checked: $event.target.checked } })" />',
  },
}

beforeEach(() => {
  setAppSessionForTesting(createAppSession({ repository: createDemoRepository({ now: () => '2026-08-31T21:00:00.000Z' }), commandStorage: createMemoryCommandStorage() }))
})

describe('NotificationCenter', () => {
  it('renders principal-owned notifications, unread wording, semantic times, and durable preferences', async () => {
    const wrapper = await mountCenter()

    expect(wrapper.get('[data-testid="unread-count"]').text()).toBe('3 unread notifications')
    expect(wrapper.findAll('[data-notification-id]').map((row) => row.attributes('data-notification-id'))).toEqual([
      'notification-c', 'notification-b', 'notification-a',
    ])
    expect(wrapper.findAll('[data-notification-id]').every((row) => row.get('time').attributes('datetime')?.endsWith('Z'))).toBe(true)
    expect(wrapper.get('[data-notification-id="notification-c"]').text()).toContain('Unread')
    expect(wrapper.findAll('input[type="checkbox"]').map((input) => (input.element as HTMLInputElement).checked)).toEqual([true, true])
  })

  it('marks one notification read once even when its action is tapped twice', async () => {
    const wrapper = await mountCenter()
    const button = wrapper.get('[data-action="mark-read-notification-c"]')

    await Promise.all([button.trigger('click'), button.trigger('click')])
    await flushPromises()
    await new Promise((resolve) => setTimeout(resolve, 20))
    await flushPromises()

    expect(wrapper.get('[data-notification-id="notification-c"]').text()).toContain('Read')
    expect(wrapper.get('[data-testid="unread-count"]').text()).toBe('2 unread notifications')
    expect(setAppSessionCommandCount('notification.read')).toBe(1)
  })

  it('marks through an inclusive timestamp/ID cutoff without consuming a later same-time notification', async () => {
    const repository = createDemoRepository({ now: () => '2026-08-31T21:00:00.000Z' })
    const page = await repository.notifications.list({ limit: 10 })
    await repository.notifications.markAllRead({
      kind: 'notification.read-all', operationId: 'cutoff-b', cutoff: { createdAt: '2026-08-30T11:00:00.000Z', id: 'notification-b' },
    })

    const after = await repository.notifications.list({ limit: 10 })
    expect(after.items.find(({ notificationId }) => notificationId === 'notification-c')?.readAt).toBeUndefined()
    expect(after.items.filter(({ readAt }) => readAt === undefined).map(({ notificationId }) => notificationId)).toEqual(['notification-c'])
    expect(page.items).toHaveLength(3)
  })

  it('keeps a failed preference intent visible with Retry and Discard', async () => {
    const repository = createDemoRepository()
    let attempts = 0
    const queue = new CommandQueue({
      originPrincipalKey: principalKey, storage: createMemoryCommandStorage(),
      handlers: {
        'notification.preferences': async (command) => {
          if (command.kind !== 'notification.preferences') throw new Error('Wrong command')
          attempts += 1
          if (attempts === 1) throw new CommandFailedError('network', 'Offline')
          return repository.notifications.updatePreferences(command)
        },
      },
    })
    setAppSessionForTesting({ ...createAppSession({ repository, commandStorage: createMemoryCommandStorage() }), queue })
    const wrapper = await mountCenter()

    await wrapper.findAll('input[type="checkbox"]')[0].setValue(false)
    await flushPromises()
    expect(wrapper.get('[data-testid="notification-error"]').text()).toContain('Offline')
    expect(wrapper.find('[data-action="retry-notification"]').exists()).toBe(true)
    expect(wrapper.find('[data-action="discard-notification"]').exists()).toBe(true)

    await wrapper.get('[data-action="retry-notification"]').trigger('click')
    await flushPromises()
    expect(wrapper.find('[data-action="retry-notification"]').exists()).toBe(false)
    expect(attempts).toBe(2)
  })
})

async function mountCenter() {
  const wrapper = mount(NotificationCenter, { global: { stubs: ionicStubs } })
  await flushPromises()
  return wrapper
}

function setAppSessionCommandCount(kind: string): number {
  return getAppSession().queue.snapshot().filter((operation) => operation.envelope.kind === kind).length
}
