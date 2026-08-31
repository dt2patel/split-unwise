import { flushPromises, mount } from '@vue/test-utils'
import { createPinia } from 'pinia'
import { beforeEach, describe, expect, it } from 'vitest'
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
}

beforeEach(() => setAppSessionForTesting(createAppSession({ repository: createDemoRepository(), commandStorage: createMemoryCommandStorage() })))

describe('premium search page', () => {
  it('runs an account search with labelled combined filters, result count, and explicit complete coverage', async () => {
    const wrapper = await mountSearch('/tabs/home/search')
    expect(wrapper.get('h1').text()).toBe('Search')
    expect(wrapper.findAll('h1')).toHaveLength(1)
    expect(wrapper.get('label[for="search-query"]').text()).toBe('Description or notes')
    await wrapper.get('#search-query').setValue('GROCERIES')
    await wrapper.get('form').trigger('submit')
    await flushPromises()

    expect(wrapper.get('[data-testid="result-count"]').text()).toContain('1 result')
    expect(wrapper.get('[data-expense-id="groceries"]').text()).toContain('Groceries')
    expect(wrapper.get('[data-testid="coverage"]').text()).toContain('Complete demo history')
    expect(wrapper.get('[data-expense-id="groceries"] a').attributes('href')).toBe('/tabs/home/expenses/groceries?groupId=lake-house-weekend')
    expect(wrapper.findAll('label').find((label) => label.text().includes('People'))?.text()).toContain('Maya P.')
    expect(wrapper.findAll('label').find((label) => label.text().includes('Categories'))?.text()).toContain('Transport')
  })

  it('uses an exact group back path and renders an honest no-results state', async () => {
    const wrapper = await mountSearch('/tabs/groups/lake-house-weekend/search')
    expect(wrapper.get('[data-testid="back"]').attributes('href')).toBe('/tabs/groups/lake-house-weekend')
    await wrapper.get('#search-query').setValue('does not exist')
    await wrapper.get('form').trigger('submit')
    await flushPromises()
    expect(wrapper.get('[data-testid="empty-results"]').text()).toContain('No expenses match')
  })
})

async function mountSearch(path: string) {
  const router = createAppRouter(); await router.push(path); await router.isReady()
  const wrapper = mount(SearchPage, { global: { plugins: [createPinia(), router], stubs } })
  await flushPromises()
  return wrapper
}
