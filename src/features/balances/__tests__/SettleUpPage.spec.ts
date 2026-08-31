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
  IonSegment: { name: 'IonSegment', props: ['value'], emits: ['ionChange'], template: '<div role="tablist"><slot /></div>' },
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

  it('changes the balance plan from Ionic ionChange keyboard selection', async () => {
    const wrapper = await mountRoute(`/tabs/groups/${groupId}/balances`, BalancesPage)

    wrapper.getComponent({ name: 'IonSegment' }).vm.$emit('ionChange', { detail: { value: 'pairwise' } })
    await flushPromises()

    expect(wrapper.get('.balances-page__explanation').text()).toContain('Every direct balance')
    expect(wrapper.find('[aria-label="Pairwise USD balances"]').exists()).toBe(true)
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
    expect(wrapper.text()).toContain('Only the payer can open a payment-provider link')
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

  it('changes the settlement basis from Ionic ionChange keyboard selection', async () => {
    const wrapper = await mountRoute(`/tabs/groups/${groupId}/settle-up`, SettleUpPage)
    expect(wrapper.findAll('[name="settlement-basis"]')).toHaveLength(1)

    wrapper.getComponent({ name: 'IonSegment' }).vm.$emit('ionChange', { detail: { value: 'pairwise' } })
    await flushPromises()

    expect(wrapper.findAll('[name="settlement-basis"]')).toHaveLength(3)
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
    const pending = wrapper.get('[data-operation-id]')
    const operationId = pending.attributes('data-operation-id')
    expect(pending.text()).toContain('Pending')
    expect(operationId).toBeTruthy()

    release()
    await flushPromises()
    await vi.waitFor(() => expect(router.currentRoute.value.name).toBe('group-settlement-detail'))
    expect(router.currentRoute.value.params.settlementId).toBe(`settlement-${operationId}`)
  })

  it('records a second payment after the settle-up page is remounted without reusing an operation ID', async () => {
    const repository = createDemoRepository()
    setAppSessionForTesting(createAppSession({ repository, commandStorage: createMemoryCommandStorage() }))
    const router = createAppRouter()
    const firstPage = await mountRoute(`/tabs/groups/${groupId}/settle-up`, SettleUpPage, router)
    await firstPage.get('[data-testid="amount-input"]').setValue('5.00')
    await firstPage.get('[data-testid="outside-payment-confirmation"]').setValue(true)
    await firstPage.get('[data-action="record-payment"]').trigger('click')
    await vi.waitFor(async () => expect(await repository.settlements.listForGroup(groupId)).toHaveLength(1))
    firstPage.unmount()

    const secondPage = await mountRoute(`/tabs/groups/${groupId}/settle-up`, SettleUpPage, router)
    await secondPage.get('[data-testid="amount-input"]').setValue('4.00')
    await secondPage.get('[data-testid="outside-payment-confirmation"]').setValue(true)
    await secondPage.get('[data-action="record-payment"]').trigger('click')

    await vi.waitFor(async () => expect(await repository.settlements.listForGroup(groupId)).toHaveLength(2))
    const records = await repository.settlements.listForGroup(groupId)
    expect(new Set(records.map(({ operationId }) => operationId)).size).toBe(2)
    expect(records.map(({ money }) => money.minorAmount).sort((left, right) => left - right)).toEqual([400, 500])
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
    expect(wrapper.get('[data-operation-id="page-conflict"] [data-action="reload-operation"]').text()).toBe('Reload')
    expect(wrapper.get('[data-operation-id="page-conflict"] [data-action="dismiss-operation"]').text()).toBe('Dismiss')

    await wrapper.get('[data-operation-id="page-conflict"] [data-action="reload-operation"]').trigger('click')
    await flushPromises()
    expect(wrapper.find('[data-operation-id="page-conflict"]').exists()).toBe(true)
    await wrapper.get('[data-operation-id="page-conflict"] [data-action="dismiss-operation"]').trigger('click')
    await vi.waitFor(() => expect(wrapper.find('[data-operation-id="page-conflict"]').exists()).toBe(false))
    expect(session.queue.get('page-conflict')).toBeUndefined()
  })

  it('opens a trusted provider handoff without recording or projecting a ledger settlement', async () => {
    const repository = createDemoRepository({ currentUserId: 'taylor-s' })
    const session = createAppSession({ repository, commandStorage: createMemoryCommandStorage() })
    setAppSessionForTesting(session)
    const wrapper = await mountRoute(`/tabs/groups/${groupId}/settle-up?plan=simplified&senderId=taylor-s&recipientId=maya-p&currency=USD&debtMinor=3625`, SettleUpPage, createAppRouter(), {
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

  it('does not offer the recipient a payer-mode provider handoff', async () => {
    const wrapper = await mountRoute(`/tabs/groups/${groupId}/settle-up`, SettleUpPage, createAppRouter(), {
      providerConfiguration: { paypal: { 'maya-p': { recipientToken: 'maya.payments' } } },
    })

    expect(wrapper.find('a[href^="https://www.paypal.com/paypalme/"]').exists()).toBe(false)
    expect(wrapper.text()).toContain('Only the payer can open a payment-provider link')
  })

  it('disables provider handoffs for invalid, zero, or over-limit amounts instead of substituting the full debt', async () => {
    const repository = createDemoRepository({ currentUserId: 'taylor-s' })
    setAppSessionForTesting(createAppSession({ repository, commandStorage: createMemoryCommandStorage() }))
    const wrapper = await mountRoute(`/tabs/groups/${groupId}/settle-up?plan=simplified&senderId=taylor-s&recipientId=maya-p&currency=USD&debtMinor=3625`, SettleUpPage, createAppRouter(), {
      providerConfiguration: { paypal: { 'maya-p': { recipientToken: 'maya.payments' } } },
    })
    expect(wrapper.find('a[href^="https://www.paypal.com/paypalme/"]').exists()).toBe(true)

    for (const invalidAmount of ['not-a-number', '0', '36.26']) {
      await wrapper.get('[data-testid="amount-input"]').setValue(invalidAmount)
      expect(wrapper.find('a[href^="https://www.paypal.com/paypalme/"]').exists()).toBe(false)
      expect(wrapper.text()).toContain('Enter a valid amount up to $36.25 to open a payment-provider link')
    }
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
    expect(wrapper.get('[data-testid="settlement-operation-announcement"]').attributes('role')).toBe('status')
    expect(wrapper.get('[data-testid="settlement-operation-announcement"]').attributes('aria-live')).toBe('polite')
    expect(wrapper.get('[data-testid="settlement-operation-announcement"]').text()).toBe('')

    await wrapper.get('[data-testid="amount-input"]').setValue('')
    await wrapper.get('[data-testid="outside-payment-confirmation"]').setValue(true)
    await wrapper.get('[data-action="record-payment"]').trigger('click')
    await flushPromises()
    expect(document.activeElement).toBe(wrapper.get('[data-testid="amount-input"]').element)
    expect(wrapper.get('[role="alert"]').text()).toContain('valid amount')
  })

  it('announces only the retained payment operation whose status changes', async () => {
    const repository = createDemoRepository()
    const snapshot = await repository.groups.getBalanceSnapshot(groupId)
    let calls = 0
    let releaseRetry!: () => void
    const retryGate = new Promise<void>((resolve) => { releaseRetry = resolve })
    const failing: AppRepository = {
      ...repository,
      commands: {
        async execute(command) {
          if (command.kind === 'settlement.record') {
            calls += 1
            if (calls > 2) await retryGate
            throw Object.assign(new Error('Connection lost'), { code: 'unavailable' })
          }
          return repository.commands.execute(command)
        },
      },
    }
    const session = createAppSession({ repository: failing, commandStorage: createMemoryCommandStorage() })
    setAppSessionForTesting(session)
    await session.ready
    for (const operationId of ['failed-payment-a', 'failed-payment-b']) {
      await session.queue.submit({
        kind: 'settlement.record', operationId, groupId, expectedBalanceRevision: snapshot.balanceRevision,
        basis: { kind: 'simplified', senderId: 'taylor-s', recipientId: 'maya-p', currency: 'USD', debtMinor: 3625 },
        money: { currency: 'USD', minorAmount: 500 }, method: 'cash', occurredOn: '2026-08-31', outsidePaymentConfirmed: true,
      }).result().catch(() => undefined)
    }
    const wrapper = await mountRoute(`/tabs/groups/${groupId}/settle-up`, SettleUpPage)
    const announcement = wrapper.get('[data-testid="settlement-operation-announcement"]')
    expect(wrapper.findAll('.operations article')).toHaveLength(2)
    expect(announcement.text()).toBe('')

    await wrapper.get('[data-operation-id="failed-payment-a"] [data-action="retry-operation"]').trigger('click')
    await vi.waitFor(() => expect(announcement.text()).toBe('Payment update: Pending. Saving this ledger update.'))
    expect(announcement.text()).not.toContain('Payment updates')
    expect(announcement.text()).not.toContain('Retry')
    expect(announcement.text()).not.toContain('failed-payment-b')

    releaseRetry()
    await vi.waitFor(() => expect(announcement.text()).toBe('Payment update: Failed. Connection lost'))
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

  it('voids a second payment after the detail page is remounted without reusing an operation ID', async () => {
    const repository = createDemoRepository()
    const before = await repository.groups.getBalanceSnapshot(groupId)
    const first = await repository.settlements.record({
      kind: 'settlement.record', operationId: 'void-remount-first', groupId, expectedBalanceRevision: before.balanceRevision,
      basis: { kind: 'simplified', senderId: 'taylor-s', recipientId: 'maya-p', currency: 'USD', debtMinor: 3625 },
      money: { currency: 'USD', minorAmount: 500 }, method: 'cash', occurredOn: '2026-08-31', outsidePaymentConfirmed: true,
    })
    if (first.status !== 'saved') throw new Error('Expected first settlement')
    const second = await repository.settlements.record({
      kind: 'settlement.record', operationId: 'void-remount-second', groupId, expectedBalanceRevision: first.balanceSnapshot.balanceRevision,
      basis: { kind: 'simplified', senderId: 'taylor-s', recipientId: 'maya-p', currency: 'USD', debtMinor: 3125 },
      money: { currency: 'USD', minorAmount: 400 }, method: 'cash', occurredOn: '2026-08-31', outsidePaymentConfirmed: true,
    })
    if (second.status !== 'saved') throw new Error('Expected second settlement')
    setAppSessionForTesting(createAppSession({ repository, commandStorage: createMemoryCommandStorage() }))
    const router = createAppRouter()

    const firstPage = await mountRoute(`/tabs/groups/${groupId}/settlements/${first.settlement.settlementId}`, SettlementDetailPage, router)
    await firstPage.get('[data-action="show-void-form"]').trigger('click')
    await firstPage.get('[data-testid="void-reason"]').setValue('First duplicate')
    await firstPage.get('[data-action="void-settlement"]').trigger('click')
    await vi.waitFor(async () => expect(await repository.settlements.getById(groupId, first.settlement.settlementId)).toHaveProperty('void'))
    firstPage.unmount()

    const secondPage = await mountRoute(`/tabs/groups/${groupId}/settlements/${second.settlement.settlementId}`, SettlementDetailPage, router)
    await secondPage.get('[data-action="show-void-form"]').trigger('click')
    await secondPage.get('[data-testid="void-reason"]').setValue('Second duplicate')
    await secondPage.get('[data-action="void-settlement"]').trigger('click')

    await vi.waitFor(async () => expect(await repository.settlements.getById(groupId, second.settlement.settlementId)).toHaveProperty('void'))
    const records = await repository.settlements.listForGroup(groupId)
    const voidOperationIds = records.map((record) => record.void?.operationId)
    expect(voidOperationIds.every(Boolean)).toBe(true)
    expect(new Set(voidOperationIds).size).toBe(2)
  })

  it('retains a failed void across remount with working Retry and Discard recovery actions', async () => {
    const repository = createDemoRepository()
    const before = await repository.groups.getBalanceSnapshot(groupId)
    const recorded = await repository.settlements.record({
      kind: 'settlement.record', operationId: 'failed-void-record', groupId, expectedBalanceRevision: before.balanceRevision,
      basis: { kind: 'simplified', senderId: 'taylor-s', recipientId: 'maya-p', currency: 'USD', debtMinor: 3625 },
      money: { currency: 'USD', minorAmount: 500 }, method: 'cash', occurredOn: '2026-08-31', outsidePaymentConfirmed: true,
    })
    if (recorded.status !== 'saved') throw new Error('Expected settlement')
    let voidCalls = 0
    let releaseRetry!: () => void
    const retryGate = new Promise<void>((resolve) => { releaseRetry = resolve })
    const failing: AppRepository = {
      ...repository,
      commands: {
        async execute(command) {
          if (command.kind === 'settlement.void') {
            voidCalls += 1
            if (voidCalls > 1) await retryGate
            throw Object.assign(new Error('Connection lost'), { code: 'unavailable' })
          }
          return repository.commands.execute(command)
        },
      },
    }
    const session = createAppSession({ repository: failing, commandStorage: createMemoryCommandStorage() })
    setAppSessionForTesting(session)
    await session.ready
    await session.queue.submit({
      kind: 'settlement.void', operationId: 'failed-void-retained', groupId, settlementId: recorded.settlement.settlementId,
      expectedRevision: recorded.settlement.revision, expectedBalanceRevision: recorded.balanceSnapshot.balanceRevision, reason: 'Duplicate record',
    }).result().catch(() => undefined)
    expect(voidCalls).toBe(1)
    const router = createAppRouter()
    const firstPage = await mountRoute(`/tabs/groups/${groupId}/settlements/${recorded.settlement.settlementId}`, SettlementDetailPage, router)
    firstPage.unmount()

    const secondPage = await mountRoute(`/tabs/groups/${groupId}/settlements/${recorded.settlement.settlementId}`, SettlementDetailPage, router)
    const retained = secondPage.get('[data-operation-id="failed-void-retained"]')
    expect(retained.text()).toContain('Failed')
    expect(retained.get('[data-action="retry-operation"]').text()).toBe('Retry')
    expect(retained.get('[data-action="discard-operation"]').text()).toBe('Discard')
    const announcement = secondPage.get('[data-testid="void-operation-announcement"]')
    expect(announcement.attributes('role')).toBe('status')
    expect(announcement.attributes('aria-live')).toBe('polite')
    expect(announcement.text()).toBe('')

    await retained.get('[data-action="retry-operation"]').trigger('click')
    await vi.waitFor(() => expect(voidCalls).toBe(2))
    await vi.waitFor(() => expect(announcement.text()).toBe('Void update: Pending. Saving this void request.'))
    releaseRetry()
    await vi.waitFor(() => expect(secondPage.get('[data-operation-id="failed-void-retained"]').text()).toContain('Failed'))
    await vi.waitFor(() => expect(announcement.text()).toBe('Void update: Failed. Connection lost'))
    await secondPage.get('[data-operation-id="failed-void-retained"] [data-action="discard-operation"]').trigger('click')
    await vi.waitFor(() => expect(secondPage.find('[data-operation-id="failed-void-retained"]').exists()).toBe(false))
    expect(session.queue.get('failed-void-retained')).toBeUndefined()
  })

  it('announces Saved when a retained void succeeds on retry before the queue row is acknowledged', async () => {
    const repository = createDemoRepository()
    const before = await repository.groups.getBalanceSnapshot(groupId)
    const recorded = await repository.settlements.record({
      kind: 'settlement.record', operationId: 'saved-retry-void-record', groupId, expectedBalanceRevision: before.balanceRevision,
      basis: { kind: 'simplified', senderId: 'taylor-s', recipientId: 'maya-p', currency: 'USD', debtMinor: 3625 },
      money: { currency: 'USD', minorAmount: 500 }, method: 'cash', occurredOn: '2026-08-31', outsidePaymentConfirmed: true,
    })
    if (recorded.status !== 'saved') throw new Error('Expected settlement')
    let attempts = 0
    const failingOnce: AppRepository = {
      ...repository,
      commands: {
        async execute(command) {
          if (command.kind === 'settlement.void' && attempts++ === 0) throw Object.assign(new Error('Connection lost'), { code: 'unavailable' })
          return repository.commands.execute(command)
        },
      },
    }
    const session = createAppSession({ repository: failingOnce, commandStorage: createMemoryCommandStorage() })
    setAppSessionForTesting(session)
    await session.ready
    await session.queue.submit({
      kind: 'settlement.void', operationId: 'saved-retry-void', groupId, settlementId: recorded.settlement.settlementId,
      expectedRevision: recorded.settlement.revision, expectedBalanceRevision: recorded.balanceSnapshot.balanceRevision, reason: 'Duplicate record',
    }).result().catch(() => undefined)
    const wrapper = await mountRoute(`/tabs/groups/${groupId}/settlements/${recorded.settlement.settlementId}`, SettlementDetailPage)
    const announcement = wrapper.get('[data-testid="void-operation-announcement"]')
    expect(announcement.text()).toBe('')

    await wrapper.get('[data-operation-id="saved-retry-void"] [data-action="retry-operation"]').trigger('click')

    await vi.waitFor(() => expect(announcement.text()).toBe('Void update: Saved. Saving this void request.'))
    await vi.waitFor(() => expect(wrapper.find('[data-operation-id="saved-retry-void"]').exists()).toBe(false))
    await expect(repository.settlements.getById(groupId, recorded.settlement.settlementId)).resolves.toHaveProperty('void')
  })

  it('restores only the matching conflicted void after remount and keeps Reload and Dismiss targeted', async () => {
    const repository = createDemoRepository()
    const before = await repository.groups.getBalanceSnapshot(groupId)
    const first = await repository.settlements.record({
      kind: 'settlement.record', operationId: 'conflicted-void-first-record', groupId, expectedBalanceRevision: before.balanceRevision,
      basis: { kind: 'simplified', senderId: 'taylor-s', recipientId: 'maya-p', currency: 'USD', debtMinor: 3625 },
      money: { currency: 'USD', minorAmount: 500 }, method: 'cash', occurredOn: '2026-08-31', outsidePaymentConfirmed: true,
    })
    if (first.status !== 'saved') throw new Error('Expected first settlement')
    const second = await repository.settlements.record({
      kind: 'settlement.record', operationId: 'conflicted-void-second-record', groupId, expectedBalanceRevision: first.balanceSnapshot.balanceRevision,
      basis: { kind: 'simplified', senderId: 'taylor-s', recipientId: 'maya-p', currency: 'USD', debtMinor: 3125 },
      money: { currency: 'USD', minorAmount: 400 }, method: 'cash', occurredOn: '2026-08-31', outsidePaymentConfirmed: true,
    })
    if (second.status !== 'saved') throw new Error('Expected second settlement')
    await repository.expenses.add({
      kind: 'expense.add', operationId: 'conflicted-void-revision-bump', groupId, description: 'Revision bump', date: '2026-08-31',
      total: { currency: 'USD', minorAmount: 100 }, payments: [{ participantId: 'maya-p', money: { currency: 'USD', minorAmount: 100 } }],
      allocations: [{ participantId: 'maya-p', money: { currency: 'USD', minorAmount: 100 } }], category: 'Other',
      splitMethod: { type: 'equal', participantIds: ['maya-p'] }, attachmentRefs: [],
    })
    const session = createAppSession({ repository, commandStorage: createMemoryCommandStorage() })
    setAppSessionForTesting(session)
    await session.ready
    await session.queue.submit({
      kind: 'settlement.void', operationId: 'conflicted-void-first', groupId, settlementId: first.settlement.settlementId,
      expectedRevision: first.settlement.revision, expectedBalanceRevision: first.balanceSnapshot.balanceRevision, reason: 'First duplicate',
    }).result().catch(() => undefined)
    await session.queue.submit({
      kind: 'settlement.void', operationId: 'conflicted-void-second', groupId, settlementId: second.settlement.settlementId,
      expectedRevision: second.settlement.revision, expectedBalanceRevision: second.balanceSnapshot.balanceRevision, reason: 'Second duplicate',
    }).result().catch(() => undefined)
    const router = createAppRouter()
    const firstMount = await mountRoute(`/tabs/groups/${groupId}/settlements/${first.settlement.settlementId}`, SettlementDetailPage, router)
    firstMount.unmount()

    const remount = await mountRoute(`/tabs/groups/${groupId}/settlements/${first.settlement.settlementId}`, SettlementDetailPage, router)
    expect(remount.get('[data-operation-id="conflicted-void-first"]').text()).toContain('Conflict')
    expect(remount.find('[data-operation-id="conflicted-void-second"]').exists()).toBe(false)

    await remount.get('[data-operation-id="conflicted-void-first"] [data-action="reload-operation"]').trigger('click')
    await flushPromises()
    expect(remount.find('[data-operation-id="conflicted-void-first"]').exists()).toBe(true)
    await remount.get('[data-operation-id="conflicted-void-first"] [data-action="dismiss-operation"]').trigger('click')
    await vi.waitFor(() => expect(remount.find('[data-operation-id="conflicted-void-first"]').exists()).toBe(false))
    expect(session.queue.get('conflicted-void-first')).toBeUndefined()
    expect(session.queue.get('conflicted-void-second')?.status).toBe('conflicted')
  })

  it('distinguishes a missing settlement from an inaccessible group', async () => {
    const missing = await mountRoute(`/tabs/groups/${groupId}/settlements/not-there`, SettlementDetailPage)
    expect(missing.get('[role="alert"]').text()).toContain('not found')

    const inaccessible = await mountRoute('/tabs/groups/another-group/settlements/not-there', SettlementDetailPage)
    expect(inaccessible.get('[role="alert"]').text()).toContain('group is not available')
  })
})

describe('settlement mobile and accessibility contract', () => {
  it('sizes the actual provider anchor to a 44-point touch target', () => {
    expect(settleSource).toMatch(/\.provider-card a\s*\{[^}]*min-width:\s*44px/)
    expect(settleSource).toMatch(/\.provider-card a\s*\{[^}]*min-height:\s*44px/)
  })

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
    expect(settleSource).toMatch(/\.basis-option:focus-within\s*\{[^}]*box-shadow:/)
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
