import { flushPromises, mount } from '@vue/test-utils'
import { createMemoryHistory, createRouter } from 'vue-router'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { localeController } from '../../../app/i18n'
import { createMemoryCommandStorage } from '../../../data/commandQueue'
import { createDemoRepository } from '../../../data/demoRepository'
import { createAppSession, setAppSessionForTesting } from '../../../data/session'
import { LAKE_HOUSE_GROUP_ID, lakeHouseGroup } from '../../../demo/lakeHouse'
import InviteSheet from '../InviteSheet.vue'

const firebaseMocks = vi.hoisted(() => ({
  createSparkInvitation: vi.fn(),
  revokeSparkInvitation: vi.fn(),
  getActiveRuntimeConfiguration: vi.fn(() => ({ kind: 'firebase' as const, firebase: {} })),
  sharePreparedInvitation: vi.fn(),
}))

vi.mock('../../../data/firebaseSparkMutations', () => ({
  createSparkInvitation: firebaseMocks.createSparkInvitation,
  revokeSparkInvitation: firebaseMocks.revokeSparkInvitation,
}))
vi.mock('../../../data/firebase', () => ({ getActiveRuntimeConfiguration: firebaseMocks.getActiveRuntimeConfiguration }))
vi.mock('../shareInvitation', () => ({ sharePreparedInvitation: firebaseMocks.sharePreparedInvitation }))
vi.mock('../../../data/firebaseCallables', () => ({ callSplitUnwiseFunction: vi.fn() }))

const stubs = {
  IonPage: { template: '<div><slot /></div>' },
  IonHeader: { template: '<header><slot /></header>' },
  IonToolbar: { template: '<div><slot /></div>' },
  IonTitle: { template: '<div><slot /></div>' },
  IonButtons: { template: '<div><slot /></div>' },
  IonBackButton: { props: ['text'], template: '<button type="button">{{ text }}</button>' },
  IonContent: { template: '<main><slot /></main>' },
  IonIcon: { template: '<i />' },
  IonButton: {
    props: ['disabled'], emits: ['click'],
    template: '<button type="button" :disabled="disabled" @click="$emit(\'click\')"><slot /></button>',
  },
}

describe('invitation preparation page', () => {
  beforeEach(() => {
    localeController.setPreference('en')
    firebaseMocks.createSparkInvitation.mockReset()
    firebaseMocks.revokeSparkInvitation.mockReset()
    firebaseMocks.sharePreparedInvitation.mockReset()
    firebaseMocks.getActiveRuntimeConfiguration.mockReset()
    firebaseMocks.getActiveRuntimeConfiguration.mockReturnValue({ kind: 'firebase', firebase: {} })
    const demo = createDemoRepository()
    setAppSessionForTesting(createAppSession({
      repository: { ...demo, mode: 'firebase' as const },
      commandStorage: createMemoryCommandStorage(),
    }))
  })

  it('localizes the manageable group invitation shell without changing the group name', async () => {
    localeController.setPreference('es')
    const wrapper = await mountInvitationSheet()

    expect(wrapper.text()).toContain('Invitar personas')
    expect(wrapper.get('h1').text()).toBe(`Invitar a ${lakeHouseGroup.name}`)
    expect(wrapper.text()).toContain('Correo electrónico de destino')
    expect(wrapper.text()).toContain('Opcional')
    expect(wrapper.text()).toContain('Preparar invitación')
  })

  it('hides an ordinary preparation diagnostic and retranslates the retained failure without preparing again', async () => {
    localeController.setPreference('es')
    firebaseMocks.createSparkInvitation.mockRejectedValueOnce(new Error('Firebase internal diagnostic'))
    const wrapper = await mountInvitationSheet()

    await wrapper.get('#invite-email').setValue('Maya+Friend@Example.com')
    await wrapper.get('.invite-card button').trigger('click')
    await flushPromises()

    expect(wrapper.get('[role="alert"]').text()).toBe('No se pudo preparar la invitación.')
    expect(wrapper.text()).not.toContain('Firebase internal diagnostic')
    expect(firebaseMocks.createSparkInvitation).toHaveBeenCalledOnce()

    localeController.setPreference('de')
    await wrapper.vm.$nextTick()

    expect(wrapper.get('[role="alert"]').text()).toBe('Die Einladung konnte nicht vorbereitet werden.')
    expect(firebaseMocks.createSparkInvitation).toHaveBeenCalledOnce()
  })

  it('preserves prepared invitation data while localizing status, expiry, and controls', async () => {
    localeController.setPreference('es')
    const targetEmail = 'Maya+Friend@Example.com'
    const link = `https://split-unwise-aditya.web.app/invite/invite-maya#token=${'a'.repeat(43)}`
    const expiresAt = '2026-09-09T12:00:00.000Z'
    firebaseMocks.createSparkInvitation.mockResolvedValueOnce({
      invitationId: 'invite-maya', groupId: LAKE_HOUSE_GROUP_ID, link, expiresAt,
      capability: 'firebase-client', targetEmail: targetEmail.toLowerCase(),
    })
    const wrapper = await mountInvitationSheet()

    await wrapper.get('#invite-email').setValue(targetEmail)
    await wrapper.get('.invite-card button').trigger('click')
    await flushPromises()

    const localizedExpiry = new Intl.DateTimeFormat('es', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(expiresAt))
    expect(wrapper.get<HTMLInputElement>('#invite-email').element.value).toBe(targetEmail)
    expect(wrapper.get<HTMLTextAreaElement>('textarea').element.value).toBe(link)
    expect(wrapper.get('[role="status"]').text()).toBe('Invitación privada de siete días lista.')
    expect(wrapper.get('.prepared-card').text()).toContain(`Caduca ${localizedExpiry}`)
    expect(wrapper.get('.prepared-card').text()).toContain('Compartir invitación')
    expect(wrapper.get('.prepared-card').text()).toContain('Revocar invitación')
    expect(wrapper.get('textarea').attributes('aria-label')).toBe('URL de invitación preparada')
  })
})

async function mountInvitationSheet() {
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: '/tabs/groups/:groupId/invite', component: InviteSheet },
      { path: '/tabs/groups/:groupId', component: { template: '<div>Group</div>' } },
    ],
  })
  await router.push(`/tabs/groups/${LAKE_HOUSE_GROUP_ID}/invite`)
  await router.isReady()
  const wrapper = mount(InviteSheet, { global: { plugins: [router], stubs } })
  await flushPromises()
  return wrapper
}
