import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { createPinia } from 'pinia'
import type { Component } from 'vue'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createAppRouter } from '../../../app/router'
import { createMemoryCommandStorage } from '../../../data/commandQueue'
import { createDemoRepository } from '../../../data/demoRepository'
import { createAppSession, setAppSessionForTesting } from '../../../data/session'
import type { AppRepository, SettlementRecord } from '../../../data/repositories'
import BalancesPage from '../BalancesPage.vue'
import SettleUpPage from '../SettleUpPage.vue'
import SettlementDetailPage from '../SettlementDetailPage.vue'

const groupId = 'lake-house-weekend'
const balancesSource = readFileSync(resolve(process.cwd(), 'src/features/balances/BalancesPage.vue'), 'utf8')
const settleSource = readFileSync(resolve(process.cwd(), 'src/features/balances/SettleUpPage.vue'), 'utf8')
const detailSource = readFileSync(resolve(process.cwd(), 'src/features/balances/SettlementDetailPage.vue'), 'utf8')
const ionicStubs = {
  IonPage: { template: '<div class="ion-page"><slot /></div>' },
  IonHeader: { template: '<header><slot /></header>' },
  IonToolbar: { template: '<div><slot /></div>' },
  IonTitle: { template: '<div><slot /></div>' },
  IonButtons: { template: '<div><slot /></div>' },
  IonBackButton: { props: ['defaultHref', 'text'], template: '<a data-testid="back" :href="defaultHref">{{ text }}</a>' },
  IonButton: { props: ['routerLink', 'disabled', 'ariaLabel'], template: '<a v-if="routerLink" :href="routerLink" :aria-label="ariaLabel"><slot /></a><button v-else type="button" :disabled="disabled" :aria-label="ariaLabel" @click="$emit(\'click\', $event)"><slot /></button>' },
  IonContent: { template: '<section><slot /></section>' },
  IonIcon: { template: '<span aria-hidden="true" />' },
  IonSegment: { template: '<div role="tablist"><slot /></div>' },
  IonSegmentButton: { props: ['value'], emits: ['click'], template: '<button type="button" role="tab" @click="$emit(\'click\', $event)"><slot /></button>' },
  IonLabel: { template: '<span><slot /></span>' },
}

beforeEach(() => {
  document.body.innerHTML = ''
  setAppSessionForTesting(createAppSession({ repository: createDemoRepository(), commandStorage: createMemoryCommandStorage() }))
})

describe('balances page', () => {
  it('renders exact pairwise and simplified direction words with one currency section and current-user settlement links', async () => {
    const wrapper = await mountRoute(`/tabs/groups/${groupId}/balances`, BalancesPage)

    expect(wrapper.get('h1').text()).toBe('Balances')
    expect(wrapper.get('[data-testid="balance-revision"]').text()).toContain('Balance revision 5')
    expect(wrapper.get('[aria-label="Simplified USD balances"]').text()).toContain('Taylor S. owes Maya P. $36.25')
    expect(wrapper.get('[aria-label="Simplified USD balances"]').text()).toContain('Jordan K. owes Alex R. $129.75')
    expect(wrapper.findAll('[data-action="settle-debt"]')).toHaveLength(1)
    expect(wrapper.get('[data-action="settle-debt"]').attributes('href')).toContain('/settle-up?')
    expect(wrapper.findAll('h1')).toHaveLength(1)
  })

  it('renders each currency independently without a converted or combined total', async () => {
    const repository = createDemoRepository()
    await repository.expenses.add({
      kind: 'expense.add', operationId: 'balances-eur', groupId, description: 'Euro ferry', date: '2026-08-31', total: { currency: 'EUR', minorAmount: 800 },
      payments: [{ participantId: 'maya-p', money: { currency: 'EUR', minorAmount: 800 } }],
      allocations: [{ participantId: 'maya-p', money: { currency: 'EUR', minorAmount: 400 } }, { participantId: 'taylor-s', money: { currency: 'EUR', minorAmount: 400 } }],
      category: 'Transport', splitMethod: { type: 'equal', participantIds: ['maya-p', 'taylor-s'] }, attachmentRefs: [],
    })
    setAppSessionForTesting(createAppSession({ repository, commandStorage: createMemoryCommandStorage() }))

    const wrapper = await mountRoute(`/tabs/groups/${groupId}/balances`, BalancesPage)

    expect(wrapper.findAll('[data-testid="currency-balance-section"]')).toHaveLength(2)
    expect(wrapper.text()).toContain('EUR')
    expect(wrapper.text()).toContain('USD')
    expect(wrapper.text()).not.toContain('Converted total')
  })
})

describe('settle up page', () => {
  it('limits selection to a debt involving the current user and requires explicit outside-payment confirmation', async () => {
    const wrapper = await mountRoute(`/tabs/groups/${groupId}/settle-up`, SettleUpPage)

    expect(wrapper.get('h1').text()).toBe('Settle up')
    expect(wrapper.findAll('[name="settlement-basis"]')).toHaveLength(1)
    expect(wrapper.get('[data-testid="selected-direction"]').text()).toBe('Taylor S. pays Maya P.')
    expect(wrapper.get('[data-action="record-payment"]').attributes('disabled')).toBeDefined()
    expect(wrapper.get('[data-testid="outside-payment-copy"]').text()).toContain('already happened outside Split Unwise')
    expect(wrapper.text()).toContain('not configured for this recipient')
  })

  it('shows one currency at a time when the current user has independent multi-currency debts', async () => {
    const repository = createDemoRepository()
    await repository.expenses.add({
      kind: 'expense.add', operationId: 'settle-eur', groupId, description: 'Euro ferry', date: '2026-08-31', total: { currency: 'EUR', minorAmount: 800 },
      payments: [{ participantId: 'maya-p', money: { currency: 'EUR', minorAmount: 800 } }],
      allocations: [{ participantId: 'maya-p', money: { currency: 'EUR', minorAmount: 400 } }, { participantId: 'taylor-s', money: { currency: 'EUR', minorAmount: 400 } }],
      category: 'Transport', splitMethod: { type: 'equal', participantIds: ['maya-p', 'taylor-s'] }, attachmentRefs: [],
    })
    setAppSessionForTesting(createAppSession({ repository, commandStorage: createMemoryCommandStorage() }))

    const wrapper = await mountRoute(`/tabs/groups/${groupId}/settle-up`, SettleUpPage)

    expect(wrapper.get('[data-testid="currency-selector"]').findAll('option').map((option) => option.text())).toEqual(['USD', 'EUR'])
    expect(wrapper.findAll('[name="settlement-basis"]')).toHaveLength(1)
    expect((wrapper.get('[data-testid="amount-input"]').element as HTMLInputElement).value).toBe('36.25')

    await wrapper.get('[data-testid="currency-selector"]').setValue('EUR')
    expect(wrapper.findAll('[name="settlement-basis"]')).toHaveLength(1)
    expect((wrapper.get('[data-testid="amount-input"]').element as HTMLInputElement).value).toBe('4.00')
    expect(wrapper.text()).not.toContain('Converted total')
  })

  it('records a partial payment once, then navigates to its durable detail route', async () => {
    const repository = createDemoRepository()
    let calls = 0
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    const wrapped: AppRepository = {
      ...repository,
      commands: {
        async execute(command) {
          calls += 1
          await gate
          return repository.commands.execute(command)
        },
      },
    }
    setAppSessionForTesting(createAppSession({ repository: wrapped, commandStorage: createMemoryCommandStorage() }))
    const router = createAppRouter()
    const wrapper = await mountRoute(`/tabs/groups/${groupId}/settle-up`, SettleUpPage, router)
    await wrapper.get('[data-testid="amount-input"]').setValue('10.00')
    await wrapper.get('[data-testid="outside-payment-confirmation"]').setValue(true)

    await Promise.all([
      wrapper.get('[data-action="record-payment"]').trigger('click'),
      wrapper.get('[data-action="record-payment"]').trigger('click'),
    ])
    await flushPromises()
    expect(calls).toBe(1)
    expect(wrapper.get('[data-action="record-payment"]').attributes('disabled')).toBeDefined()
    expect(wrapper.get('[data-operation-id="settlement-ui-1"]').text()).toContain('Pending')

    release()
    await flushPromises()
    await vi.waitFor(() => expect(router.currentRoute.value.name).toBe('group-settlement-detail'))
    expect(router.currentRoute.value.params.settlementId).toBe('settlement-settlement-ui-1')
  })

  it('renders a retained revision conflict without reducing the authoritative balance', async () => {
    const repository = createDemoRepository()
    const snapshot = await repository.groups.getBalanceSnapshot(groupId)
    await repository.expenses.add({
      kind: 'expense.add', operationId: 'conflict-bump', groupId, description: 'Revision bump', date: '2026-08-31', total: { currency: 'USD', minorAmount: 100 },
      payments: [{ participantId: 'maya-p', money: { currency: 'USD', minorAmount: 100 } }],
      allocations: [{ participantId: 'maya-p', money: { currency: 'USD', minorAmount: 100 } }], category: 'Other',
      splitMethod: { type: 'equal', participantIds: ['maya-p'] }, attachmentRefs: [],
    })
    const session = createAppSession({ repository, commandStorage: createMemoryCommandStorage() })
    setAppSessionForTesting(session)
    await session.ready
    await session.queue.submit({
      kind: 'settlement.record', operationId: 'page-conflict', groupId, expectedBalanceRevision: snapshot.balanceRevision,
      basis: { kind: 'simplified', senderId: 'taylor-s', recipientId: 'maya-p', currency: 'USD', debtMinor: 3625 },
      money: { currency: 'USD', minorAmount: 500 }, method: 'cash', occurredOn: '2026-08-31', outsidePaymentConfirmed: true,
    }).result().catch(() => undefined)

    const wrapper = await mountRoute(`/tabs/groups/${groupId}/settle-up`, SettleUpPage)

    expect(wrapper.get('[data-operation-id="page-conflict"]').text()).toContain('Conflict')
    expect(wrapper.get('[data-testid="amount-input"]').attributes('value')).not.toBe('31.25')
    expect((wrapper.get('[data-testid="amount-input"]').element as HTMLInputElement).value).toBe('36.25')
  })

  it('opens a trusted provider handoff without recording or projecting a ledger settlement', async () => {
    const repository = createDemoRepository()
    const session = createAppSession({ repository, commandStorage: createMemoryCommandStorage() })
    setAppSessionForTesting(session)
    const wrapper = await mountRoute(`/tabs/groups/${groupId}/settle-up`, SettleUpPage, createAppRouter(), {
      providerConfiguration: { paypal: { 'maya-p': { recipientToken: 'maya.payments' } } },
    })
    const link = wrapper.get('a[href^="https://www.paypal.com/paypalme/"]')

    expect(link.attributes('target')).toBe('_blank')
    expect(link.attributes('rel')).toContain('noopener')
    await link.trigger('click')
    await flushPromises()

    await expect(repository.settlements.listForGroup(groupId)).resolves.toEqual([])
    expect(session.queue.snapshot()).toEqual([])
  })

  it('restores focus to an actionable amount error and presents failed commands with Retry and Discard', async () => {
    const repository = createDemoRepository()
    const snapshot = await repository.groups.getBalanceSnapshot(groupId)
    const failing: AppRepository = {
      ...repository,
      commands: { execute: async () => { throw Object.assign(new Error('Connection lost'), { code: 'unavailable' }) } },
    }
    const session = createAppSession({ repository: failing, commandStorage: createMemoryCommandStorage() })
    setAppSessionForTesting(session)
    await session.ready
    await session.queue.submit({
      kind: 'settlement.record', operationId: 'failed-payment', groupId, expectedBalanceRevision: snapshot.balanceRevision,
      basis: { kind: 'simplified', senderId: 'taylor-s', recipientId: 'maya-p', currency: 'USD', debtMinor: 3625 },
      money: { currency: 'USD', minorAmount: 500 }, method: 'cash', occurredOn: '2026-08-31', outsidePaymentConfirmed: true,
    }).result().catch(() => undefined)
    const wrapper = await mountRoute(`/tabs/groups/${groupId}/settle-up`, SettleUpPage)

    expect(wrapper.get('[data-operation-id="failed-payment"]').text()).toContain('Failed')
    expect(wrapper.get('[data-operation-id="failed-payment"]').text()).toContain('Retry')
    expect(wrapper.get('[data-operation-id="failed-payment"]').text()).toContain('Discard')

    await wrapper.get('[data-testid="amount-input"]').setValue('')
    await wrapper.get('[data-testid="outside-payment-confirmation"]').setValue(true)
    await wrapper.get('[data-action="record-payment"]').trigger('click')
    await flushPromises()
    expect(document.activeElement).toBe(wrapper.get('[data-testid="amount-input"]').element)
    expect(wrapper.get('[role="alert"]').text()).toContain('valid amount')
  })
})

describe('settlement detail page', () => {
  it('retains original payment truth after an audited void and explains that outside funds are unchanged', async () => {
    const repository = createDemoRepository()
    const before = await repository.groups.getBalanceSnapshot(groupId)
    const recorded = await repository.settlements.record({
      kind: 'settlement.record', operationId: 'detail-payment', groupId, expectedBalanceRevision: before.balanceRevision,
      basis: { kind: 'simplified', senderId: 'taylor-s', recipientId: 'maya-p', currency: 'USD', debtMinor: 3625 },
      money: { currency: 'USD', minorAmount: 500 }, method: 'cash', occurredOn: '2026-08-31', note: 'Dock payment', outsidePaymentConfirmed: true,
    })
    if (recorded.status !== 'saved') throw new Error('Expected settlement')
    setAppSessionForTesting(createAppSession({ repository, commandStorage: createMemoryCommandStorage() }))
    const wrapper = await mountRoute(`/tabs/groups/${groupId}/settlements/${recorded.settlement.settlementId}`, SettlementDetailPage)

    expect(wrapper.get('h1').text()).toBe('Payment')
    expect(wrapper.get('[data-testid="payment-direction"]').text()).toContain('Taylor S. paid Maya P.')
    expect(wrapper.text()).toContain('$5.00')
    expect(wrapper.text()).toContain('Voiding this ledger record does not cancel or refund money sent outside Split Unwise')
    await wrapper.get('[data-action="show-void-form"]').trigger('click')
    await wrapper.get('[data-testid="void-reason"]').setValue('Entered twice')
    await wrapper.get('[data-action="void-settlement"]').trigger('click')
    await flushPromises()

    await vi.waitFor(() => expect(wrapper.get('[data-testid="voided-state"]').text()).toContain('Voided'))
    expect(wrapper.text()).toContain('Entered twice')
    expect(wrapper.text()).toContain('$5.00')
  })

  it('distinguishes a missing settlement from an inaccessible group', async () => {
    const missing = await mountRoute(`/tabs/groups/${groupId}/settlements/not-there`, SettlementDetailPage)
    expect(missing.get('[role="alert"]').text()).toContain('not found')

    const inaccessible = await mountRoute('/tabs/groups/another-group/settlements/not-there', SettlementDetailPage)
    expect(inaccessible.get('[role="alert"]').text()).toContain('group is not available')
  })
})

describe('settlement mobile and accessibility contract', () => {
  it('retains one semantic heading, labelled choices, 44-point controls, safe areas, wrapping, and reduced-motion fallbacks', async () => {
    const wrapper = await mountRoute(`/tabs/groups/${groupId}/settle-up`, SettleUpPage)

    expect(wrapper.findAll('h1')).toHaveLength(1)
    expect(wrapper.get('fieldset legend').text()).toBe('Payment direction')
    expect(wrapper.find('[aria-label="Settlement balance basis"]').exists()).toBe(true)
    for (const source of [balancesSource, settleSource, detailSource]) {
      expect(source).toContain('env(safe-area-inset-bottom)')
      expect(source).toMatch(/min-height:\s*(44|46|48|52|58|64)px/)
      expect(source).toContain('@media (prefers-reduced-motion: reduce)')
    }
    expect(balancesSource).toContain('overflow-wrap: anywhere')
    expect(settleSource).toContain('overflow-wrap: anywhere')
    expect(detailSource).toContain('overflow-wrap: anywhere')
  })
})

async function mountRoute(path: string, component: Component, suppliedRouter = createAppRouter(), props: Record<string, unknown> = {}): Promise<VueWrapper> {
  await suppliedRouter.push(path)
  await suppliedRouter.isReady()
  const wrapper = mount(component, { attachTo: document.body, props, global: { plugins: [createPinia(), suppliedRouter], stubs: ionicStubs } })
  await flushPromises()
  return wrapper
}

function settlement(overrides: Partial<SettlementRecord> = {}): SettlementRecord {
  return {
    settlementId: 'settlement-a', groupId, operationId: 'record-a', senderId: 'taylor-s', recipientId: 'maya-p',
    money: { currency: 'USD', minorAmount: 500 }, basis: { kind: 'simplified', senderId: 'taylor-s', recipientId: 'maya-p', currency: 'USD', debtMinor: 3625 },
    method: 'cash', occurredOn: '2026-08-31', createdBy: { id: 'maya-p', displayName: 'Maya P.' }, createdAt: '2026-08-31T20:00:00.000Z', revision: 1, syncState: 'fresh',
    ...overrides,
  }
}
