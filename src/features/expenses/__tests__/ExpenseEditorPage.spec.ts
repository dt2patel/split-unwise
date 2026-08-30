import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { createPinia } from 'pinia'
import type { Component } from 'vue'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createAppRouter } from '../../../app/router'
import { createMemoryCommandStorage } from '../../../data/commandQueue'
import { createDemoRepository } from '../../../data/demoRepository'
import { createMemoryReceiptStore } from '../../../data/receipts'
import { createAppSession, setAppSessionForTesting } from '../../../data/session'
import { useExpenseStore } from '../expenseStore'

const ionicStubs = {
  IonPage: { template: '<main class="ion-page"><slot /></main>' },
  IonHeader: { template: '<header><slot /></header>' },
  IonToolbar: { template: '<div><slot /></div>' },
  IonTitle: { template: '<div><slot /></div>' },
  IonButtons: { template: '<div><slot /></div>' },
  IonButton: { props: ['disabled', 'ariaLabel'], emits: ['click'], template: '<button type="button" :disabled="disabled" :aria-label="ariaLabel" @click="$emit(\'click\')"><slot /></button>' },
  IonContent: { template: '<section><slot /></section>' },
  IonIcon: { template: '<span aria-hidden="true" />' },
  IonModal: { name: 'IonModal', props: ['isOpen', 'canDismiss'], emits: ['didDismiss'], template: '<aside v-if="isOpen" data-testid="active-sheet"><slot /></aside>' },
}

beforeEach(() => {
  setAppSessionForTesting(createAppSession({
    repository: createDemoRepository(), commandStorage: createMemoryCommandStorage(),
    receipts: createMemoryReceiptStore({ id: () => 'editor-receipt', now: () => '2026-08-30T12:00:00.000Z' }),
  }))
})
afterEach(() => { vi.restoreAllMocks(); setAppSessionForTesting(undefined) })

describe('ExpenseEditorPage', () => {
  it('renders the native full-screen add form and focuses an accessible validation summary', async () => {
    const { wrapper } = await mountRoute('/tabs/groups/expenses/new?groupId=lake-house-weekend')
    expect(wrapper.get('h1').text()).toBe('Add expense')
    expect(wrapper.get('[data-testid="expense-context"]').text()).toContain('Lake House Weekend')
    expect(wrapper.find('[aria-label="Primary navigation"]').exists()).toBe(false)

    await wrapper.get('[data-action="save-expense"]').trigger('click')
    const summary = wrapper.get('[data-testid="expense-error-summary"]')
    expect(summary.attributes('aria-live')).toBe('assertive')
    expect(document.activeElement).toBe(summary.element)
    expect(wrapper.get('#expense-description').attributes('aria-invalid')).toBe('true')
    expect(wrapper.get('#expense-amount').attributes('aria-invalid')).toBe('true')
  })

  it('uses deterministic direct-load Cancel and protects a dirty dismissal', async () => {
    const { wrapper, router } = await mountRoute('/tabs/home/expenses/new')
    await wrapper.get('#expense-description').setValue('Coffee')
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false)
    await wrapper.get('[data-action="cancel-expense"]').trigger('click')
    expect(confirm).toHaveBeenCalled()
    expect(router.currentRoute.value.path).toBe('/tabs/home/expenses/new')

    confirm.mockReturnValue(true)
    await wrapper.get('[data-action="cancel-expense"]').trigger('click')
    await flushPromises()
    expect(router.currentRoute.value.path).toBe('/tabs/home')
  })

  it('keeps one staged sheet open and restores focus when Cancel closes it', async () => {
    const { wrapper } = await mountRoute('/tabs/groups/expenses/new?groupId=lake-house-weekend')
    const trigger = wrapper.get('#payer-sheet-trigger')
    await trigger.trigger('click')
    expect(wrapper.findAll('[data-testid="active-sheet"]')).toHaveLength(1)
    expect(wrapper.get('[data-testid="active-sheet"]').text()).toContain('Paid by')

    await wrapper.get('[data-testid="active-sheet"] header button').trigger('click')
    await flushPromises()
    expect(wrapper.find('[data-testid="active-sheet"]').exists()).toBe(false)
    expect(document.activeElement?.id).toBe('payer-sheet-trigger')
  })

  it('lets a no-query composer choose a real group context before editing participants', async () => {
    const { wrapper } = await mountRoute('/tabs/home/expenses/new')
    await wrapper.get('#context-sheet-trigger').trigger('click')
    expect(wrapper.get('[data-testid="active-sheet"]').text()).toContain('Lake House Weekend')
    await wrapper.get('[data-context-id="lake-house-weekend"]').setValue(true)
    await wrapper.get('[data-action="apply-context"]').trigger('click')
    await flushPromises()

    expect(wrapper.get('[data-testid="expense-context"]').text()).toContain('Lake House Weekend')
    expect(wrapper.get('#participant-sheet-trigger').text()).toContain('4 participants')
  })

  it('confirms staged sheet dismissal from a backdrop or swipe gesture', async () => {
    const { wrapper } = await mountRoute('/tabs/groups/expenses/new?groupId=lake-house-weekend')
    await wrapper.get('#payer-sheet-trigger').trigger('click')
    await wrapper.get('[data-payer-id="maya-p"]').setValue('56.00')
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false)
    const canDismiss = wrapper.getComponent({ name: 'IonModal' }).props('canDismiss') as (data?: unknown, role?: string) => Promise<boolean>

    await expect(canDismiss(undefined, 'backdrop')).resolves.toBe(false)
    confirm.mockReturnValue(true)
    await expect(canDismiss(undefined, 'gesture')).resolves.toBe(true)
  })

  it('connects every inline validation message to its invalid control', async () => {
    const { wrapper, store } = await mountRoute('/tabs/home/expenses/new')
    store.editor.participants = []
    store.editor.payments = []
    await wrapper.get('[data-action="save-expense"]').trigger('click')

    expect(wrapper.get('#context-sheet-trigger').attributes()).toMatchObject({ 'aria-invalid': 'true', 'aria-describedby': 'expense-context-error' })
    expect(wrapper.get('#expense-description').attributes()).toMatchObject({ 'aria-invalid': 'true', 'aria-describedby': 'expense-description-error' })
    expect(wrapper.get('#expense-amount').attributes()).toMatchObject({ 'aria-invalid': 'true', 'aria-describedby': 'expense-amount-error' })
    expect(wrapper.get('#payer-sheet-trigger').attributes()).toMatchObject({ 'aria-invalid': 'true', 'aria-describedby': 'expense-payments-error' })
    expect(wrapper.get('#split-sheet-trigger').attributes()).toMatchObject({ 'aria-invalid': 'true', 'aria-describedby': 'expense-split-error' })
    expect(wrapper.get('#participant-sheet-trigger').attributes()).toMatchObject({ 'aria-invalid': 'true', 'aria-describedby': 'expense-participants-error' })
    expect(wrapper.get('#expense-category').attributes()).toMatchObject({ 'aria-invalid': 'true', 'aria-describedby': 'expense-category-error' })
  })
})

async function mountRoute(path: string): Promise<{ wrapper: VueWrapper; router: ReturnType<typeof createAppRouter>; store: ReturnType<typeof useExpenseStore> }> {
  const router = createAppRouter()
  await router.push(path)
  await router.isReady()
  const component = router.currentRoute.value.matched.at(-1)?.components?.default as Component | undefined
  if (!component) throw new Error(`No component resolved for ${path}`)
  const pinia = createPinia()
  const wrapper = mount(component, { attachTo: document.body, global: { plugins: [pinia, router], stubs: ionicStubs } })
  await flushPromises()
  return { wrapper, router, store: useExpenseStore(pinia) }
}
