import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { createPinia } from 'pinia'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { IonItem } from '@ionic/vue'
import type { Router } from 'vue-router'
import { createAppRouter } from '../../../app/router'
import { createMemoryCommandStorage } from '../../../data/commandQueue'
import { createDemoRepository } from '../../../data/demoRepository'
import { createAppSession, setAppSessionForTesting } from '../../../data/session'
import SearchPage from '../SearchPage.vue'

const stubs = {
  IonPage: { template: '<div class="ion-page"><slot /></div>' }, IonHeader: { template: '<header><slot /></header>' },
  IonToolbar: { template: '<div><slot /></div>' }, IonTitle: { template: '<div><slot /></div>' }, IonButtons: { template: '<div><slot /></div>' },
  IonBackButton: { props: ['defaultHref', 'text'], template: '<a data-testid="back" :href="defaultHref">{{ text }}</a>' },
  IonContent: { template: '<section><slot /></section>' }, IonButton: { props: ['disabled'], template: '<button type="submit" :disabled="disabled"><slot /></button>' },
  // Shaped like ion-searchbar: the host wraps a native input that Ionic names "search text" and exposes via getInputElement().
  IonSearchbar: {
    name: 'IonSearchbar', props: ['modelValue', 'placeholder', 'type', 'autocomplete', 'debounce'], emits: ['update:modelValue'],
    mounted(this: { $el: HTMLElement }) { Object.assign(this.$el, { getInputElement: async () => this.$el.querySelector('input') }) },
    template: '<div class="searchbar-stub"><input aria-label="search text" :type="type" :autocomplete="autocomplete" :placeholder="placeholder" :value="modelValue" @input="$emit(\'update:modelValue\', $event.target.value)"></div>',
  },
  IonAccordionGroup: { template: '<div data-testid="filter-accordions"><slot /></div>' },
  IonAccordion: { props: ['value'], template: '<div :data-accordion="value"><slot /></div>' },
}

beforeEach(() => setAppSessionForTesting(createAppSession({ repository: createDemoRepository(), commandStorage: createMemoryCommandStorage() })))

describe('premium search page', () => {
  it('runs an account search with labelled combined filters, result count, and explicit complete coverage', async () => {
    const { wrapper } = await mountSearch('/tabs/home/search')
    expect(wrapper.get('h1').text()).toBe('Search')
    expect(wrapper.findAll('h1')).toHaveLength(1)
    expect(wrapper.get('label[for="search-query"]').text()).toBe('Description or notes')
    await wrapper.get('#search-query').setValue('GROCERIES')

    expect(wrapper.get('[data-testid="result-count"]').text()).toContain('1 result')
    expect(wrapper.get('[data-expense-id="groceries"]').text()).toContain('Groceries')
    expect(wrapper.get('[data-testid="coverage"]').text()).toContain('Complete demo history')
    const row = resultRow(wrapper, 'groceries')
    expect(row?.element.tagName).toBe('ION-ITEM')
    expect(row?.props('routerLink')).toBe('/tabs/home/expenses/groceries?groupId=lake-house-weekend')
    expect(wrapper.find('[data-expense-id="groceries"] a[href]').exists()).toBe(false)
    expect(wrapper.findAll('label').find((label) => label.text().includes('People'))?.text()).toContain('Maya P.')
    expect(wrapper.findAll('label').find((label) => label.text().includes('Categories'))?.text()).toContain('Transport')
  })

  it('names the native iOS search field with its visible label instead of Ionic’s generic one', async () => {
    const { wrapper } = await mountSearch('/tabs/home/search')
    const input = wrapper.get('.searchbar-stub input')

    expect(input.attributes('id')).toBe('search-query')
    expect(input.attributes('aria-labelledby')).toBe('search-query-label')
    expect(wrapper.get('#search-query-label').text()).toBe('Description or notes')
    expect(wrapper.getComponent({ name: 'IonSearchbar' }).props()).toMatchObject({ type: 'search', autocomplete: 'off', placeholder: 'Coffee, cabin, train…' })
    // No debounce: results are searched locally, so they can follow every keystroke.
    expect(wrapper.getComponent({ name: 'IonSearchbar' }).props('debounce')).toBeUndefined()
  })

  it('wires the real Ionic search field to its label, the query, and keyboard submission', async () => {
    const router = createAppRouter(); await router.push('/tabs/home/search'); await router.isReady()
    const { IonSearchbar: _searchbar, ...ionicStubs } = stubs
    const wrapper = mount(SearchPage, { global: { plugins: [createPinia(), router], stubs: ionicStubs }, attachTo: document.body })
    try {
      await vi.waitFor(() => expect(document.getElementById('search-query')).not.toBeNull())
      const input = document.getElementById('search-query') as HTMLInputElement

      expect(input.closest('ion-searchbar')).not.toBeNull()
      // Ionic hard-codes this name; aria-labelledby takes precedence over it.
      expect(input.getAttribute('aria-label')).toBe('search text')
      expect(input.getAttribute('aria-labelledby')).toBe('search-query-label')
      expect(document.querySelector('label[for="search-query"]')?.textContent).toBe('Description or notes')

      input.value = 'GROCERIES'
      input.dispatchEvent(new Event('input', { bubbles: true }))
      await flushPromises()
      // Results follow the typing; the keyboard's Search key only puts the keyboard away.
      await vi.waitFor(() => expect(wrapper.get('[data-testid="result-count"]').text()).toBe('1 result'))
      input.focus()
      wrapper.get('form').element.requestSubmit()
      expect(document.activeElement).not.toBe(input)
    } finally {
      wrapper.unmount()
    }
  })

  it('keeps the native filter pickers inside a collapsible Ionic accordion', async () => {
    const { wrapper } = await mountSearch('/tabs/home/search')
    const accordion = wrapper.get('[data-testid="filter-accordions"] [data-accordion="filters"]')

    expect(accordion.get('[slot="header"]').text()).toBe('Filters')
    expect(accordion.get('[slot="content"]').findAll('select')).toHaveLength(4)
    expect(accordion.get('[slot="content"]').findAll('input[type="date"]')).toHaveLength(2)
    expect(accordion.findAll('input[inputmode="decimal"]').map((input) => input.attributes('placeholder'))).toEqual(['0.00', 'No maximum'])
    expect(wrapper.find('details').exists()).toBe(false)
  })

  it('opens a result through the app router without a document navigation', async () => {
    const { wrapper, router } = await mountSearch('/tabs/groups/lake-house-weekend/search')
    await wrapper.get('#search-query').setValue('groceries')
    const push = vi.spyOn(router, 'push').mockResolvedValue(undefined)
    const tap = new MouseEvent('click', { bubbles: true, cancelable: true })
    const row = resultRow(wrapper, 'groceries')

    row?.element.dispatchEvent(tap)

    expect(row?.props('routerLink')).toBe('/tabs/groups/expenses/groceries?groupId=lake-house-weekend')
    expect(tap.defaultPrevented).toBe(true)
    expect(push).toHaveBeenCalledWith('/tabs/groups/expenses/groceries?groupId=lake-house-weekend')
  })

  it('uses an exact group back path and renders an honest no-results state', async () => {
    const { wrapper } = await mountSearch('/tabs/groups/lake-house-weekend/search')
    expect(wrapper.get('[data-testid="back"]').attributes('href')).toBe('/tabs/groups/lake-house-weekend')
    await wrapper.get('#search-query').setValue('does not exist')
    expect(wrapper.get('[data-testid="empty-results"]').text()).toContain('No expenses match')
  })

  it('updates results live as the query and filters change, reading the expenses only once', async () => {
    const repository = createDemoRepository()
    const listForGroup = vi.spyOn(repository.expenses, 'listForGroup')
    setAppSessionForTesting(createAppSession({ repository, commandStorage: createMemoryCommandStorage() }))
    const { wrapper } = await mountSearch('/tabs/home/search')
    const everything = Number.parseInt(wrapper.get('[data-testid="result-count"]').text(), 10)
    expect(everything).toBeGreaterThan(1)
    expect(wrapper.find('button[type="submit"]').exists()).toBe(false)

    await wrapper.get('#search-query').setValue('gro')
    expect(wrapper.get('[data-testid="result-count"]').text()).toBe('1 result')
    await wrapper.get('#search-query').setValue('')
    expect(wrapper.get('[data-testid="result-count"]').text()).toBe(`${everything} results`)
    await wrapper.findAll('select').find((select) => select.findAll('option').some((option) => option.text() === 'Transport'))!.setValue(['Transport'])
    expect(Number.parseInt(wrapper.get('[data-testid="result-count"]').text(), 10)).toBeLessThan(everything)

    // An amount without a currency explains itself and keeps the pickers usable.
    await wrapper.findAll('input[inputmode="decimal"]')[0]!.setValue('5')
    expect(wrapper.get('[role="alert"]').text()).toContain('Choose a currency')
    expect(wrapper.findAll('label').find((label) => label.text().includes('Categories'))?.text()).toContain('Transport')

    expect(listForGroup).toHaveBeenCalledTimes(1)
  })

  it('keeps its query and filters while a result is open on top of it', async () => {
    const { wrapper, router } = await mountSearch('/tabs/home/search')
    await wrapper.get('#search-query').setValue('groceries')
    await wrapper.findAll('select').find((select) => select.findAll('option').some((option) => option.text() === 'Food'))!.setValue(['Food'])

    await router.push('/tabs/home/expenses/groceries?groupId=lake-house-weekend')
    await flushPromises()

    expect((wrapper.get('#search-query').element as HTMLInputElement).value).toBe('groceries')
    expect(wrapper.get('[data-testid="result-count"]').text()).toBe('1 result')
    expect(wrapper.get('h1').text()).toBe('Search')
  })

  it('fails closed instead of widening an invalid group route into account search', async () => {
    const { wrapper } = await mountSearch('/tabs/groups/%21/search')

    expect(wrapper.get('[role="alert"]').text()).toContain('valid group')
    expect(wrapper.find('[data-expense-id="groceries"]').exists()).toBe(false)
  })
})

function resultRow(wrapper: VueWrapper, expenseId: string) {
  return wrapper.findAllComponents(IonItem).find((item) => item.attributes('data-expense-id') === expenseId)
}

async function mountSearch(path: string): Promise<{ readonly wrapper: VueWrapper; readonly router: Router }> {
  const router = createAppRouter(); await router.push(path); await router.isReady()
  const wrapper = mount(SearchPage, { global: { plugins: [createPinia(), router], stubs } })
  await flushPromises()
  return { wrapper, router }
}
