import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { createPinia } from 'pinia'
import type { Component } from 'vue'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createAppRouter } from '../../../app/router'
import { createMemoryCommandStorage } from '../../../data/commandQueue'
import { createDemoRepository } from '../../../data/demoRepository'
import { createMemoryReceiptStore, type ReceiptProvider, type ReceiptRecognitionResult } from '../../../data/receipts'
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
    await flushPromises()
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

  it.each([
    ['split method', '#split-sheet-trigger', '[data-method="exact"]'],
    ['recurrence frequency', '#recurrence-sheet-trigger', '[data-frequency="monthly"]'],
    ['receipt item', '#receipt-sheet-trigger', '.add-line'],
  ] as const)('protects a staged %s button mutation from backdrop dismissal', async (_name, triggerSelector, mutationSelector) => {
    const { wrapper } = await mountRoute('/tabs/groups/expenses/new?groupId=lake-house-weekend')
    await wrapper.get(triggerSelector).trigger('click')
    await wrapper.get(mutationSelector).trigger('click')
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false)
    const canDismiss = wrapper.getComponent({ name: 'IonModal' }).props('canDismiss') as (data?: unknown, role?: string) => Promise<boolean>

    await expect(canDismiss(undefined, 'backdrop')).resolves.toBe(false)
    expect(confirm).toHaveBeenCalledWith('Discard staged sheet changes?')
  })

  it('passes the explicit local receipt durability state into receipt review copy', async () => {
    const { wrapper, store } = await mountRoute('/tabs/groups/expenses/new?groupId=lake-house-weekend')
    await store.attachReceipt(new Blob(['receipt'], { type: 'image/jpeg' }), 'receipt.jpg')
    await wrapper.get('#receipt-sheet-trigger').trigger('click')

    const warning = wrapper.get('[data-testid="receipt-durability-warning"]')
    expect(warning.text()).toContain('Saved only on this device.')
    expect(warning.text()).toContain('until upload succeeds')
  })

  it('connects every inline validation message to its invalid control', async () => {
    const { wrapper, store } = await mountRoute('/tabs/home/expenses/new')
    store.editor.participants = []
    store.editor.payments = []
    await wrapper.get('[data-action="save-expense"]').trigger('click')
    await flushPromises()

    expect(wrapper.get('#context-sheet-trigger').attributes()).toMatchObject({ 'aria-invalid': 'true', 'aria-describedby': 'expense-context-error' })
    expect(wrapper.get('#expense-description').attributes()).toMatchObject({ 'aria-invalid': 'true', 'aria-describedby': 'expense-description-error' })
    expect(wrapper.get('#expense-amount').attributes()).toMatchObject({ 'aria-invalid': 'true', 'aria-describedby': 'expense-amount-error' })
    expect(wrapper.get('#payer-sheet-trigger').attributes()).toMatchObject({ 'aria-invalid': 'true', 'aria-describedby': 'expense-payments-error' })
    expect(wrapper.get('#split-sheet-trigger').attributes()).toMatchObject({ 'aria-invalid': 'true', 'aria-describedby': 'expense-split-error' })
    expect(wrapper.get('#participant-sheet-trigger').attributes()).toMatchObject({ 'aria-invalid': 'true', 'aria-describedby': 'expense-participants-error' })
    expect(wrapper.get('#expense-category').attributes()).toMatchObject({ 'aria-invalid': 'true', 'aria-describedby': 'expense-category-error' })
  })

  it('disables Save outside a successfully initialized editor and while one save is pending', async () => {
    const repository = createDemoRepository()
    const pendingGroup = deferred<Awaited<ReturnType<typeof repository.groups.getById>>>()
    const originalGetById = repository.groups.getById
    repository.groups.getById = async (groupId) => groupId === 'lake-house-weekend' ? pendingGroup.promise : originalGetById(groupId)
    setAppSessionForTesting(createAppSession({ repository, commandStorage: createMemoryCommandStorage() }))

    const mounted = await mountRoute('/tabs/groups/expenses/new?groupId=lake-house-weekend', false)
    expect(mounted.wrapper.get('[data-action="save-expense"]').attributes('disabled')).toBeDefined()
    expect(mounted.wrapper.get('[data-testid="expense-loading"]').text()).toContain('Loading')
    pendingGroup.resolve(await createDemoRepository().groups.getById('lake-house-weekend'))
    await flushPromises()
    expect(mounted.wrapper.get('[data-action="save-expense"]').attributes('disabled')).toBeUndefined()
  })

  it('resets a recurrence anchor deterministically when its expense date changes', async () => {
    const { wrapper, store } = await mountRoute('/tabs/groups/expenses/new?groupId=lake-house-weekend')
    store.editor.recurrence = { frequency: 'monthly', anchor: { month: 8, day: 30 }, timeZone: 'America/Chicago' }

    await wrapper.get('#expense-date').setValue('2026-09-15')

    expect(store.editor.recurrence.anchor).toEqual({ month: 9, day: 15 })
  })

  it('preserves recurring identity and requires an explicit occurrence or future edit scope', async () => {
    const { wrapper, store } = await mountRoute('/tabs/groups/expenses/cabin-deposit/edit?groupId=lake-house-weekend')
    expect((store as unknown as { recurringTemplateId?: string }).recurringTemplateId).toBe('cabin-deposit-monthly')

    await wrapper.get('#recurrence-sheet-trigger').trigger('click')
    expect(wrapper.get('[data-testid="active-sheet"]').text()).toContain('Apply changes to')
    await wrapper.get('[data-occurrence-scope="occurrence"]').trigger('click')
    await wrapper.get('[data-action="apply-recurrence"]').trigger('click')
    await flushPromises()

    expect(store.editor.occurrenceEditScope).toBe('occurrence')
  })

  it('lets composer labels, icons, summaries, and native controls grow at Dynamic Type sizes', async () => {
    const source = readFileSync(resolve(process.cwd(), 'src/features/expenses/ExpenseEditorPage.vue'), 'utf8')
    const css = source.match(/<style scoped>([\s\S]*?)<\/style>/)?.[1]
    if (!css) throw new Error('Expected the editor stylesheet')
    const style = document.createElement('style')
    style.textContent = css
    document.head.append(style)
    document.documentElement.style.fontSize = '32px'
    const { wrapper } = await mountRoute('/tabs/groups/expenses/new?groupId=lake-house-weekend')

    const context = getComputedStyle(wrapper.get('.context-chip span').element)
    expect(context.whiteSpace).toBe('normal')
    expect(context.overflowWrap).toBe('anywhere')
    const currency = getComputedStyle(wrapper.get('.expense-core__currency-symbol').element)
    expect(currency.width).toBe('max-content')
    expect(currency.minHeight).toBe('46px')
    const row = getComputedStyle(wrapper.get('.editor-row').element)
    expect(row.gridTemplateColumns).toContain('max-content')
    const summary = getComputedStyle(wrapper.get('#participant-sheet-trigger small').element)
    expect(summary.whiteSpace).toBe('normal')
    expect(summary.overflowWrap).toBe('anywhere')
    const date = getComputedStyle(wrapper.get('#expense-date').element)
    expect(date.minWidth).toBe('0px')
    expect(date.maxWidth).toBe('100%')

    wrapper.unmount()
    style.remove()
    document.documentElement.style.removeProperty('font-size')
  })

  it('invalidates pending receipt work when the composer unmounts', async () => {
    const recognition = deferred<ReceiptRecognitionResult>()
    const receiptProvider: ReceiptProvider = {
      async upload() { return { status: 'unavailable', reason: 'Upload unavailable.' } },
      recognize: () => recognition.promise,
      async delete() { /* no remote receipt was created */ },
    }
    setAppSessionForTesting(createAppSession({
      repository: createDemoRepository(), commandStorage: createMemoryCommandStorage(),
      receipts: createMemoryReceiptStore({ id: () => 'unmounted-receipt', now: () => '2026-08-30T12:00:00.000Z' }),
      receiptProvider,
    }))
    const { wrapper, store } = await mountRoute('/tabs/groups/expenses/new?groupId=lake-house-weekend')

    const attachment = store.attachReceipt(new Blob(['receipt'], { type: 'image/jpeg' }), 'receipt.jpg')
    await Promise.resolve()
    await Promise.resolve()
    wrapper.unmount()
    recognition.resolve({ status: 'unavailable', reason: 'Unavailable.' })

    await expect(attachment).resolves.toBe(false)
    expect(store.activeSheet).toBeUndefined()
  })
})

async function mountRoute(path: string, settle = true): Promise<{ wrapper: VueWrapper; router: ReturnType<typeof createAppRouter>; store: ReturnType<typeof useExpenseStore> }> {
  const router = createAppRouter()
  await router.push(path)
  await router.isReady()
  const component = router.currentRoute.value.matched.at(-1)?.components?.default as Component | undefined
  if (!component) throw new Error(`No component resolved for ${path}`)
  const pinia = createPinia()
  const wrapper = mount(component, { attachTo: document.body, global: { plugins: [pinia, router], stubs: ionicStubs } })
  if (settle) await flushPromises()
  return { wrapper, router, store: useExpenseStore(pinia) }
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  const promise = new Promise<T>((done) => { resolve = done })
  return { promise, resolve }
}
