import { flushPromises, mount } from '@vue/test-utils'
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
  IonItem: { props: ['routerLink'], emits: ['click'], template: '<component :is="routerLink ? \'a\' : \'button\'" :href="routerLink" @click="$emit(\'click\')"><slot /></component>' },
  IonAvatar: { template: '<span><slot /></span>' }, IonLabel: { template: '<span><slot /></span>' }, IonNote: { template: '<small><slot /></small>' },
  IonSkeletonText: { template: '<span />' },
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
    firebaseMocks.createSparkFriendship.mockResolvedValueOnce({
      status: 'ready',
      groupId: 'friend-ravi',
      invitation: {
        invitationId: 'invite-ravi',
        groupId: 'friend-ravi',
        link: 'https://split-unwise-aditya.web.app/invite/invite-ravi#token=secret',
        expiresAt: '2026-09-09T12:00:00.000Z',
        capability: 'firebase-client',
        targetEmail: 'ravi@example.com',
      },
    })
    firebaseMocks.sharePreparedInvitation
      .mockResolvedValueOnce({ status: 'shared' })
      .mockResolvedValueOnce({ status: 'copied' })
      .mockResolvedValueOnce({ status: 'cancelled' })
      .mockResolvedValueOnce({ status: 'manual', url: 'https://split-unwise-aditya.web.app/invite/invite-ravi#token=secret' })
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

    localeController.setPreference('de')
    await wrapper.vm.$nextTick()

    expect(wrapper.get('[role="status"]').text()).toBe('Wähle die Einladung unten aus und kopiere sie.')
    expect(firebaseMocks.sharePreparedInvitation).toHaveBeenCalledTimes(4)
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
