import { flushPromises, mount } from '@vue/test-utils'
import { createPinia } from 'pinia'
import { beforeEach, describe, expect, it } from 'vitest'
import { createAppRouter } from '../../../app/router'
import { createMemoryCommandStorage } from '../../../data/commandQueue'
import { createDemoRepository } from '../../../data/demoRepository'
import { createAppSession, setAppSessionForTesting } from '../../../data/session'
import ChartsPage from '../ChartsPage.vue'
import TotalsPage from '../TotalsPage.vue'

const stubs = {
  IonPage: { template: '<div class="ion-page"><slot /></div>' }, IonHeader: { template: '<header><slot /></header>' },
  IonToolbar: { template: '<div><slot /></div>' }, IonTitle: { template: '<div><slot /></div>' }, IonButtons: { template: '<div><slot /></div>' },
  IonBackButton: { props: ['defaultHref', 'text'], template: '<a data-testid="back" :href="defaultHref">{{ text }}</a>' },
  IonContent: { template: '<section><slot /></section>' }, IonButton: { props: ['routerLink'], template: '<a :href="routerLink"><slot /></a>' },
}

beforeEach(() => setAppSessionForTesting(createAppSession({ repository: createDemoRepository(), commandStorage: createMemoryCommandStorage() })))

describe('premium analytics pages', () => {
  it('renders every plotted category and daily value in exact semantic tables with currency context', async () => {
    const wrapper = await mountPage(ChartsPage, '/tabs/groups/lake-house-weekend/charts')

    expect(wrapper.get('h1').text()).toBe('Charts')
    expect(wrapper.findAll('h1')).toHaveLength(1)
    expect(wrapper.get('[data-testid="coverage"]').text()).toContain('Complete demo history')
    const category = wrapper.get('[aria-label="USD spending by category"]')
    expect(category.text()).toContain('Food')
    expect(category.text()).toContain('$243.00')
    expect(category.text()).toContain('Lodging')
    expect(category.text()).toContain('$400.00')
    expect(category.text()).toContain('Transport')
    expect(category.text()).toContain('$116.00')
    expect(wrapper.get('[aria-label="USD daily spending"]').findAll('tbody tr')).toHaveLength(5)
    expect(wrapper.get('[aria-label="USD member contributions"]').text()).toContain('Maya P.')
    expect(wrapper.get('[aria-label="USD balance over time"]').findAll('tbody tr')).toHaveLength(5)
    expect(wrapper.findAll('meter')).toHaveLength(3)
    expect(wrapper.get('[data-testid="daily-plot-USD"]').findAll('li')).toHaveLength(5)
    expect(wrapper.get('[data-testid="monthly-plot-USD"]').findAll('li')).toHaveLength(1)
    expect(wrapper.get('[data-testid="contribution-plot-USD"]').findAll('li')).toHaveLength(4)
    expect(wrapper.get('[data-testid="balance-plot-USD"]').findAll('li')).toHaveLength(5)
    expect(wrapper.get('[data-testid="chart-scale-USD"]').text()).toContain('USD')
  })

  it('keeps period net distinct from current balance and itemizes settlement flow', async () => {
    const wrapper = await mountPage(TotalsPage, '/tabs/groups/lake-house-weekend/totals')
    expect(wrapper.get('h1').text()).toBe('Totals')
    expect(wrapper.get('[aria-label="USD period totals"]').text()).toContain('Expense total')
    expect(wrapper.get('[aria-label="USD period totals"]').text()).toContain('Payments sent')
    expect(wrapper.get('[aria-label="USD period totals"]').text()).toContain('Period ledger net')
    expect(wrapper.text()).toContain('Period net is not your current balance')
  })
})

async function mountPage(component: object, path: string) {
  const router = createAppRouter(); await router.push(path); await router.isReady()
  const wrapper = mount(component, { global: { plugins: [createPinia(), router], stubs } })
  await flushPromises()
  return wrapper
}
