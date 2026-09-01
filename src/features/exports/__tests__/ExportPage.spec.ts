import { flushPromises, mount } from '@vue/test-utils'
import { createPinia } from 'pinia'
import { beforeEach, describe, expect, it } from 'vitest'
import { createAppRouter } from '../../../app/router'
import { createMemoryCommandStorage } from '../../../data/commandQueue'
import { createDemoRepository } from '../../../data/demoRepository'
import { createAppSession, setAppSessionForTesting } from '../../../data/session'
import ExportPage from '../ExportPage.vue'

const stubs = {
  IonPage: { template: '<div class="ion-page"><slot /></div>' }, IonHeader: { template: '<header><slot /></header>' }, IonToolbar: { template: '<div><slot /></div>' }, IonTitle: { template: '<div><slot /></div>' }, IonButtons: { template: '<div><slot /></div>' },
  IonBackButton: { props: ['defaultHref', 'text'], template: '<a data-testid="back" :href="defaultHref">{{ text }}</a>' }, IonContent: { template: '<section><slot /></section>' }, IonButton: { emits: ['click'], template: '<button type="button" @click="$emit(\'click\')"><slot /></button>' },
}

beforeEach(() => setAppSessionForTesting(createAppSession({ repository: createDemoRepository(), commandStorage: createMemoryCommandStorage() })))

describe('premium export page', () => {
  it('offers both bounded formats without paywalling and reports provider-gated features honestly', async () => {
    const router = createAppRouter(); await router.push('/tabs/groups/lake-house-weekend/export'); await router.isReady()
    const wrapper = mount(ExportPage, { global: { plugins: [createPinia(), router], stubs } }); await flushPromises()

    expect(wrapper.get('h1').text()).toBe('Export data')
    expect(wrapper.findAll('h1')).toHaveLength(1)
    expect(wrapper.get('[data-testid="back"]').attributes('href')).toBe('/tabs/groups/lake-house-weekend')
    expect(wrapper.get('[data-testid="coverage"]').text()).toContain('Complete demo history')
    expect(wrapper.text()).toContain('Download CSV')
    expect(wrapper.text()).toContain('Download JSON')
    expect(wrapper.text()).toContain('Transaction import')
    expect(wrapper.text()).toContain('Reference currency conversion')
    expect(wrapper.text()).toContain('European Central Bank via Frankfurter')
    expect(wrapper.findAll('.provider-card span').map((row) => row.text())).toEqual(['Unavailable', 'Available'])
    expect(wrapper.text()).not.toMatch(/upgrade|subscribe|premium plan/i)
  })

  it('fails closed instead of widening an invalid group route into an account export', async () => {
    const router = createAppRouter(); await router.push('/tabs/groups/%21/export'); await router.isReady()
    const wrapper = mount(ExportPage, { global: { plugins: [createPinia(), router], stubs } }); await flushPromises()

    expect(wrapper.get('[role="alert"]').text()).toContain('valid group')
    expect(wrapper.find('[data-testid="coverage"]').exists()).toBe(false)
    expect(wrapper.get('[data-testid="back"]').attributes('href')).toBe('/tabs/groups')
  })
})
