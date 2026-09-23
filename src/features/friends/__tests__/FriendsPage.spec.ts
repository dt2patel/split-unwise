import { flushPromises, mount } from '@vue/test-utils'
import { IonicVue } from '@ionic/vue'
import { nextTick } from 'vue'
import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { localeController } from '../../../app/i18n'
import { createAppRouter } from '../../../app/router'
import { createMemoryCommandStorage } from '../../../data/commandQueue'
import { createDemoRepository } from '../../../data/demoRepository'
import type { Group, GroupBalanceSnapshot } from '../../../data/repositories'
import { createAppSession, setAppSessionForTesting } from '../../../data/session'
import FriendsPage from '../FriendsPage.vue'
import { SafeRemoteDisplayError } from '../../../app/displayMessages'

const firebaseMocks = vi.hoisted(() => ({
  createSparkFriendship: vi.fn(),
  getActiveRuntimeConfiguration: vi.fn(() => ({ kind: 'firebase', firebase: {} })),
  sharePreparedInvitation: vi.fn(),
}))
vi.mock('../../../data/firebaseSparkMutations', () => ({ createSparkFriendship: firebaseMocks.createSparkFriendship }))
vi.mock('../../../data/firebase', () => ({ getActiveRuntimeConfiguration: firebaseMocks.getActiveRuntimeConfiguration }))
vi.mock('../../invitations/shareInvitation', () => ({ sharePreparedInvitation: firebaseMocks.sharePreparedInvitation }))

const friendship: Group = { id: 'friend-jordan', kind: 'friendship', name: 'Jordan Lee', currency: 'USD', memberIds: ['maya-p'], syncState: 'fresh' }
const stubs = {
  IonPage: { template: '<div><slot /></div>' }, IonHeader: { template: '<header><slot /></header>' },
  IonToolbar: { template: '<div><slot /></div>' }, IonTitle: { template: '<div><slot /></div>' },
  IonButtons: { template: '<div><slot /></div>' }, IonContent: { template: '<main><slot /></main>' },
  IonIcon: { template: '<span />' }, IonButton: { emits: ['click'], template: '<button type="button" @click="$emit(\'click\')"><slot /></button>' },
  IonList: { template: '<div><slot /></div>' },
  IonItem: { props: ['routerLink', 'detail'], emits: ['click'], template: '<component :is="routerLink ? \'a\' : \'button\'" :href="routerLink" :data-detail="detail" @click="$emit(\'click\')"><slot /></component>' },
  IonAvatar: { template: '<span><slot /></span>' }, IonLabel: { template: '<span><slot /></span>' }, IonNote: { template: '<small><slot /></small>' },
  IonSkeletonText: { template: '<span />' },
  IonInput: {
    name: 'IonInput', inheritAttrs: false, props: ['modelValue', 'labelPlacement'], emits: ['update:modelValue'],
    template: '<label><slot /><input v-bind="$attrs" :value="modelValue" @input="$emit(\'update:modelValue\', $event.target.value)"></label>',
  },
}

// Stencil renders Ionic's custom elements asynchronously after Vue mounts them.
async function settleIonic(): Promise<void> {
  await flushPromises()
  await new Promise((resolve) => setTimeout(resolve, 20))
  await flushPromises()
}

beforeEach(() => {
  localeController.setPreference('en')
  firebaseMocks.createSparkFriendship.mockReset()
  firebaseMocks.sharePreparedInvitation.mockReset()
  setActivePinia(createPinia())
  const demo = createDemoRepository()
  setAppSessionForTesting(createAppSession({
    repository: {
      ...demo,
      groups: {
        ...demo.groups,
        async list() { return [friendship] },
        async listMembers() { return [await demo.app.getCurrentUser()] },
        async getBalanceSnapshot(groupId): Promise<GroupBalanceSnapshot> {
          return { groupId, balanceRevision: 1, simplifyDebtsEnabled: false, pairwise: [], simplified: [] }
        },
      },
    },
    commandStorage: createMemoryCommandStorage(),
  }))
})

describe('Friends page', () => {
  it('translates an application-owned group-list failure while preserving a remote failure', async () => {
    localeController.setPreference('es')
    const demo = createDemoRepository()
    setAppSessionForTesting(createAppSession({
      repository: { ...demo, groups: { ...demo.groups, async list() { throw new Error('Firestore group listing unavailable') } } },
      commandStorage: createMemoryCommandStorage(),
    }))
    const router = createAppRouter()
    await router.push('/tabs/home/friends')
    await router.isReady()
    const wrapper = mount(FriendsPage, { global: { plugins: [createPinia(), router], stubs } })
    await flushPromises()

    expect(wrapper.get('[role="alert"]').text()).toBe('No se pudo cargar el grupo.')

    const remote = createDemoRepository()
    setActivePinia(createPinia())
    setAppSessionForTesting(createAppSession({
      repository: { ...remote, groups: { ...remote.groups, async list() { throw new SafeRemoteDisplayError('Shared plans are temporarily unavailable.') } } },
      commandStorage: createMemoryCommandStorage(),
    }))
    const remoteRouter = createAppRouter()
    await remoteRouter.push('/tabs/home/friends')
    await remoteRouter.isReady()
    const remoteWrapper = mount(FriendsPage, { global: { plugins: [createPinia(), remoteRouter], stubs } })
    await flushPromises()

    expect(remoteWrapper.get('[role="alert"]').text()).toBe('Shared plans are temporarily unavailable.')
  })

  it('translates partial and unavailable balance notices without changing friend names', async () => {
    localeController.setPreference('es')
    const secondFriendship: Group = { ...friendship, id: 'friend-ravi', name: 'Ravi Patel' }
    const demo = createDemoRepository()
    setAppSessionForTesting(createAppSession({
      repository: {
        ...demo,
        groups: {
          ...demo.groups,
          async list() { return [friendship, secondFriendship] },
          async listMembers(groupId) { if (groupId === secondFriendship.id) throw new Error('offline'); return [await demo.app.getCurrentUser()] },
          async getBalanceSnapshot(groupId): Promise<GroupBalanceSnapshot> { return { groupId, balanceRevision: 1, simplifyDebtsEnabled: false, pairwise: [], simplified: [] } },
        },
      },
      commandStorage: createMemoryCommandStorage(),
    }))
    const partialRouter = createAppRouter()
    await partialRouter.push('/tabs/home/friends')
    await partialRouter.isReady()
    const partial = mount(FriendsPage, { global: { plugins: [createPinia(), partialRouter], stubs } })
    await flushPromises()

    expect(partial.get('.friends-page__balance-notice').text()).toBe('Algunos saldos no están disponibles temporalmente.')
    expect(partial.text()).toContain('Jordan Lee')

    const unavailableDemo = createDemoRepository()
    setActivePinia(createPinia())
    setAppSessionForTesting(createAppSession({
      repository: {
        ...unavailableDemo,
        groups: {
          ...unavailableDemo.groups,
          async list() { return [friendship] },
          async listMembers() { throw new Error('offline') },
          async getBalanceSnapshot() { throw new Error('offline') },
        },
      },
      commandStorage: createMemoryCommandStorage(),
    }))
    const unavailableRouter = createAppRouter()
    await unavailableRouter.push('/tabs/home/friends')
    await unavailableRouter.isReady()
    const unavailable = mount(FriendsPage, { global: { plugins: [createPinia(), unavailableRouter], stubs } })
    await flushPromises()

    expect(unavailable.get('.friends-page__balance-notice').text()).toBe('Saldo no disponible')
    expect(unavailable.text()).toContain('Jordan Lee')
  })

  it('localizes pending two-person contexts and the mobile add-friend form without changing friend data', async () => {
    localeController.setPreference('es')
    const router = createAppRouter()
    await router.push('/tabs/home/friends')
    await router.isReady()
    const wrapper = mount(FriendsPage, { global: { plugins: [createPinia(), router], stubs } })
    await flushPromises()

    expect(wrapper.get('h1').text()).toBe('Amigos')
    expect(wrapper.get('[data-friend-id="friend-jordan"]').text()).toContain('Invitación pendiente')
    expect(wrapper.text()).toContain('Jordan Lee')
    await wrapper.get('[data-friend-id="friend-jordan"]').trigger('click')
    await nextTick()
    expect(wrapper.get('[data-breakdown-for="pending:friend-jordan"] a').attributes('href')).toBe('/tabs/groups/friend-jordan')
    await wrapper.get('[aria-label="Añadir amigo"]').trigger('click')
    expect(wrapper.get('form').text()).toContain('Nombre del amigo')
    expect(wrapper.get('input[type="email"]').attributes('inputmode')).toBe('email')
    const fields = wrapper.findAllComponents({ name: 'IonInput' })
    expect(fields.map((field) => [field.get('[slot="label"]').text(), field.props('labelPlacement')])).toEqual([['Nombre del amigo', 'stacked'], ['Correo electrónico', 'stacked']])
    expect(wrapper.get('input[autocomplete="name"]').attributes()).toMatchObject({ maxlength: '120', autocapitalize: 'words', placeholder: 'Jordan Lee' })
    expect(wrapper.get('input[type="email"]').attributes()).toMatchObject({ autocomplete: 'email', placeholder: 'jordan@example.com' })
    const currency = wrapper.get<HTMLSelectElement>('select')
    expect(currency.element.closest('label')!.textContent).toContain('Moneda')
    expect(currency.findAll('option').length).toBeGreaterThan(1)
  })

  it('submits real Ionic name and email fields through the form submit button', async () => {
    firebaseMocks.createSparkFriendship.mockResolvedValueOnce({
      status: 'ready',
      groupId: 'friend-ravi',
      invitation: {
        invitationId: 'invite-ravi', groupId: 'friend-ravi', link: 'https://split-unwise-aditya.web.app/invite/invite-ravi#token=secret',
        expiresAt: '2026-09-09T12:00:00.000Z', capability: 'firebase-client', targetEmail: 'ravi@example.com',
      },
    })
    const source = createDemoRepository()
    setAppSessionForTesting(createAppSession({ repository: { ...source, mode: 'firebase' as const }, commandStorage: createMemoryCommandStorage() }))
    const router = createAppRouter()
    const wrapper = mount(FriendsPage, { attachTo: document.body, global: { plugins: [createPinia(), router, [IonicVue, { mode: 'ios' }]], stubs: {
      IonPage: stubs.IonPage, IonHeader: stubs.IonHeader, IonToolbar: stubs.IonToolbar, IonTitle: stubs.IonTitle, IonButtons: stubs.IonButtons, IonContent: stubs.IonContent,
    } } })
    await settleIonic()

    await wrapper.get('header ion-button').trigger('click')
    await settleIonic()
    const name = wrapper.get<HTMLInputElement>('.friend-form ion-input input[autocomplete="name"]')
    const email = wrapper.get<HTMLInputElement>('.friend-form ion-input input[type="email"]')
    expect(name.attributes('maxlength')).toBe('120')
    expect(email.attributes('inputmode')).toBe('email')
    expect(document.getElementById(email.attributes('aria-labelledby')!)?.textContent).toBe('Email')
    name.element.value = 'Ravi Patel'
    await name.trigger('input')
    email.element.value = 'ravi@example.com'
    await email.trigger('input')
    await wrapper.get('.friend-form select').setValue('EUR')

    const submit = wrapper.findAll('.friend-form__actions ion-button').find((button) => button.text() === 'Add friend')!
    await submit.trigger('click')
    await flushPromises()

    expect(firebaseMocks.createSparkFriendship).toHaveBeenCalledOnce()
    expect(firebaseMocks.createSparkFriendship.mock.calls[0]![1]).toMatchObject({ displayName: 'Ravi Patel', email: 'ravi@example.com', currency: 'EUR' })
    await vi.waitFor(() => expect(wrapper.get('[role="status"]').text()).toBe('Private invitation ready for ravi@example.com.'))
    wrapper.unmount()
  })

  it('hides an ordinary add diagnostic and retranslates the retained failure without creating again', async () => {
    localeController.setPreference('es')
    firebaseMocks.createSparkFriendship.mockRejectedValueOnce(new Error('Firestore secret diagnostic'))
    const source = createDemoRepository()
    setAppSessionForTesting(createAppSession({ repository: { ...source, mode: 'firebase' as const }, commandStorage: createMemoryCommandStorage() }))
    const router = createAppRouter()
    const wrapper = mount(FriendsPage, { global: { plugins: [createPinia(), router], stubs } })
    await flushPromises()

    await wrapper.get('[aria-label="Añadir amigo"]').trigger('click')
    await wrapper.get('input[autocomplete="name"]').setValue('Ravi Patel')
    await wrapper.get('input[type="email"]').setValue('ravi@example.com')
    await wrapper.get('form').trigger('submit')
    await flushPromises()

    expect(wrapper.get('[role="alert"]').text()).toBe('No se pudo añadir a tu amigo.')
    expect(wrapper.text()).not.toContain('Firestore secret diagnostic')
    expect(firebaseMocks.createSparkFriendship).toHaveBeenCalledOnce()

    localeController.setPreference('de')
    await wrapper.vm.$nextTick()

    expect(wrapper.get('[role="alert"]').text()).toBe('Dein Freund konnte nicht hinzugefügt werden.')
    expect(firebaseMocks.createSparkFriendship).toHaveBeenCalledOnce()
  })

  it('retranslates invitation-ready feedback without creating again or changing the target email', async () => {
    localeController.setPreference('es')
    firebaseMocks.createSparkFriendship.mockImplementationOnce(async (_configuration, input: { readonly email: string }) => ({
      status: 'ready',
      groupId: 'friend-maya',
      invitation: {
        invitationId: 'invite-maya',
        groupId: 'friend-maya',
        link: 'https://split-unwise-aditya.web.app/invite/invite-maya#token=secret',
        expiresAt: '2026-09-09T12:00:00.000Z',
        capability: 'firebase-client',
        targetEmail: input.email.toLowerCase(),
      },
    }))
    const source = createDemoRepository()
    setAppSessionForTesting(createAppSession({ repository: { ...source, mode: 'firebase' as const }, commandStorage: createMemoryCommandStorage() }))
    const router = createAppRouter()
    const wrapper = mount(FriendsPage, { global: { plugins: [createPinia(), router], stubs } })
    await flushPromises()

    await wrapper.get('[aria-label="Añadir amigo"]').trigger('click')
    await wrapper.get('input[autocomplete="name"]').setValue('Maya Chen')
    await wrapper.get('input[type="email"]').setValue('Maya+Friend@Example.com')
    await wrapper.get('form').trigger('submit')
    await flushPromises()

    expect(wrapper.get('[role="status"]').text()).toBe('Invitación privada lista para Maya+Friend@Example.com.')
    expect(wrapper.get('.invitation-ready').text()).toContain('Maya+Friend@Example.com')
    expect(wrapper.get('.invitation-ready').text()).not.toContain('maya+friend@example.com')
    expect(firebaseMocks.createSparkFriendship).toHaveBeenCalledOnce()

    localeController.setPreference('de')
    await wrapper.vm.$nextTick()

    expect(wrapper.get('[role="status"]').text()).toBe('Private Einladung für Maya+Friend@Example.com ist bereit.')
    expect(firebaseMocks.createSparkFriendship).toHaveBeenCalledOnce()
  })

  it('retains every semantic share result and retranslates it without sharing again', async () => {
    localeController.setPreference('es')
    const privateUrl = `https://split-unwise-aditya.web.app/invite/invite-ravi#token=${'r'.repeat(43)}`
    firebaseMocks.createSparkFriendship.mockResolvedValueOnce({
      status: 'ready',
      groupId: 'friend-ravi',
      invitation: {
        invitationId: 'invite-ravi',
        groupId: 'friend-ravi',
        link: privateUrl,
        expiresAt: '2026-09-09T12:00:00.000Z',
        capability: 'firebase-client',
        targetEmail: 'ravi@example.com',
      },
    })
    firebaseMocks.sharePreparedInvitation
      .mockResolvedValueOnce({ status: 'shared' })
      .mockResolvedValueOnce({ status: 'copied' })
      .mockResolvedValueOnce({ status: 'cancelled' })
      .mockResolvedValueOnce({ status: 'manual', url: privateUrl })
    const source = createDemoRepository()
    setAppSessionForTesting(createAppSession({ repository: { ...source, mode: 'firebase' as const }, commandStorage: createMemoryCommandStorage() }))
    const router = createAppRouter()
    const wrapper = mount(FriendsPage, { global: { plugins: [createPinia(), router], stubs } })
    await flushPromises()

    await wrapper.get('[aria-label="Añadir amigo"]').trigger('click')
    await wrapper.get('input[autocomplete="name"]').setValue('Ravi Patel')
    await wrapper.get('input[type="email"]').setValue('ravi@example.com')
    await wrapper.get('form').trigger('submit')
    await flushPromises()
    const share = wrapper.get('.invitation-ready button')

    for (const expected of [
      'Hoja para compartir completada.',
      'Invitación copiada.',
      'Compartir cancelado.',
      'Selecciona y copia la invitación a continuación.',
    ]) {
      await share.trigger('click')
      await flushPromises()
      expect(wrapper.get('[role="status"]').text()).toBe(expected)
    }
    expect(firebaseMocks.sharePreparedInvitation).toHaveBeenCalledTimes(4)
    expect(firebaseMocks.sharePreparedInvitation).toHaveBeenLastCalledWith(privateUrl, {
      title: 'Únete a mi grupo de Split Unwise',
      text: 'Usa esta invitación privada para unirte al grupo.',
    })
    const manualUrl = wrapper.get<HTMLTextAreaElement>('.invitation-ready__manual-url')
    expect(manualUrl.element.readOnly).toBe(true)
    expect(manualUrl.element.value).toBe(privateUrl)
    expect(manualUrl.attributes('aria-label')).toBe('URL de invitación preparada')
    expect(manualUrl.attributes('aria-describedby')).toBe('friend-invitation-status')
    const manualStatus = wrapper.get('#friend-invitation-status')
    expect(manualStatus.text()).toBe('Selecciona y copia la invitación a continuación.')
    expect(manualStatus.element.compareDocumentPosition(manualUrl.element) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()

    localeController.setPreference('de')
    await wrapper.vm.$nextTick()

    expect(wrapper.get('[role="status"]').text()).toBe('Wähle die Einladung unten aus und kopiere sie.')
    expect(manualUrl.attributes('aria-label')).toBe('Vorbereitete Einladungs-URL')
    expect(firebaseMocks.sharePreparedInvitation).toHaveBeenCalledTimes(4)

    firebaseMocks.sharePreparedInvitation.mockResolvedValueOnce({ status: 'shared' })
    await share.trigger('click')
    await flushPromises()
    expect(wrapper.find('.invitation-ready__manual-url').exists()).toBe(false)
  })

  it('includes friends from shared groups and expands their per-group balance', async () => {
    setActivePinia(createPinia())
    const repository = createDemoRepository()
    setAppSessionForTesting(createAppSession({ repository, commandStorage: createMemoryCommandStorage() }))
    const router = createAppRouter()
    await router.push('/tabs/home/friends')
    await router.isReady()
    const wrapper = mount(FriendsPage, { global: { plugins: [createPinia(), router], stubs } })
    await flushPromises()

    expect(wrapper.get('[aria-labelledby="friend-list-title"]').text()).toContain('4')
    expect(wrapper.get('[data-friend-id="taylor-s"]').text()).toContain('Taylor S.')
    expect(wrapper.get('[data-friend-id="taylor-s"]').text()).toContain('$36.25')
    await wrapper.get('[data-friend-id="taylor-s"]').trigger('click')
    await nextTick()

    const breakdown = wrapper.get('[data-breakdown-for="taylor-s"]')
    expect(breakdown.text()).toContain('Lake House Weekend')
    expect(breakdown.text()).toContain('$36.25')
    expect(breakdown.get('a').attributes('href')).toBe('/tabs/groups/lake-house-weekend')
    const rows = breakdown.findAll('.friend-breakdown__link')
    expect(rows.length).toBeGreaterThan(0)
    for (const row of rows) {
      expect(row.element.tagName).toBe('A')
      expect(row.attributes('data-detail')).toBe('')
    }
    expect(wrapper.get('[data-friend-id="taylor-s"]').attributes('data-detail')).toBe('false')
  })

  it('keeps a pending invitation reachable when its balance read is temporarily unavailable', async () => {
    setActivePinia(createPinia())
    const repository = createDemoRepository()
    setAppSessionForTesting(createAppSession({
      repository: {
        ...repository,
        groups: {
          ...repository.groups,
          async list() { return [friendship] },
          async listMembers() { throw new Error('offline') },
          async getBalanceSnapshot() { throw new Error('offline') },
        },
      },
      commandStorage: createMemoryCommandStorage(),
    }))
    const router = createAppRouter()
    await router.push('/tabs/home/friends')
    await router.isReady()
    const wrapper = mount(FriendsPage, { global: { plugins: [createPinia(), router], stubs } })
    await flushPromises()

    const row = wrapper.get('[data-friend-id="friend-jordan"]')
    expect(row.text()).toContain('Invitation pending')
    await row.trigger('click')
    await nextTick()
    expect(wrapper.get('[data-breakdown-for="pending:friend-jordan"] a').attributes('href')).toBe('/tabs/groups/friend-jordan')
  })
})
