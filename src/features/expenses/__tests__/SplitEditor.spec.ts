import { IonicVue } from '@ionic/vue'
import { mount } from '@vue/test-utils'
import { nextTick } from 'vue'
import { describe, expect, it, vi } from 'vitest'
import type { SplitInput } from '../expenseStore'
import SplitEditor from '../components/SplitEditor.vue'
import { ionicSheetStubs } from './ionicSheetStubs'

const participants = [
  { id: 'maya-p', displayName: 'Maya P.', initials: 'MP', isCurrentUser: true },
  { id: 'alex-r', displayName: 'Alex R.', initials: 'AR', isCurrentUser: false },
]

const jordan = { id: 'jordan-k', displayName: 'Jordan K.', initials: 'JK', isCurrentUser: false }
const taylor = { id: 'taylor-s', displayName: 'Taylor S.', initials: 'TS', isCurrentUser: false }

const cases: readonly [string, SplitInput, readonly number[]][] = [
  ['equal', { type: 'equal' }, [51, 50]],
  ['exact', { type: 'exact', values: { 'maya-p': '1.01', 'alex-r': '0.00' } }, [101, 0]],
  ['percentage', { type: 'percentage', values: { 'maya-p': '50', 'alex-r': '50' } }, [51, 50]],
  ['shares', { type: 'shares', values: { 'maya-p': '3', 'alex-r': '1' } }, [76, 25]],
  ['adjustment', { type: 'adjustment', values: { 'maya-p': '0.10', 'alex-r': '0.00' } }, [56, 45]],
  ['itemized', { type: 'itemized', items: [
    { description: 'Shared snack', amountText: '0.51', participantIds: ['maya-p', 'alex-r'] },
    { description: 'Maya drink', amountText: '0.50', participantIds: ['maya-p'] },
  ] }, [76, 25]],
]

type MountOptions = NonNullable<Parameters<typeof mount>[1]>
function mountEditor(options: MountOptions) {
  return mount(SplitEditor, { ...options, global: { stubs: ionicSheetStubs } } as never)
}

describe('SplitEditor', () => {
  it.each(cases)('validates and applies the %s method through exact domain allocation', async (_name, modelValue, amounts) => {
    const wrapper = mountEditor({ props: { modelValue, participants, currency: 'USD', totalMinorAmount: 101 } })

    await wrapper.get('[data-action="apply-split"]').trigger('click')

    const applied = wrapper.emitted('apply')?.[0]?.[0] as { readonly allocations: readonly { readonly money: { readonly minorAmount: number } }[] }
    expect(applied.allocations.map(({ money }) => money.minorAmount)).toEqual(amounts)
    expect(wrapper.find('[role="alert"]').exists()).toBe(false)
  })

  it('keeps edits staged until Apply and emits Cancel without mutating the input', async () => {
    const original: SplitInput = { type: 'exact', values: { 'maya-p': '0.51', 'alex-r': '0.50' } }
    const wrapper = mountEditor({ props: { modelValue: original, participants, currency: 'USD', totalMinorAmount: 101 } })
    await wrapper.get('[data-participant-id="maya-p"]').setValue('0.01')
    expect(wrapper.emitted('dirty')).toHaveLength(1)
    await wrapper.get('[data-action="cancel-split"]').trigger('click')

    expect(wrapper.emitted('apply')).toBeUndefined()
    expect(wrapper.emitted('cancel')).toHaveLength(1)
    expect(original).toEqual({ type: 'exact', values: { 'maya-p': '0.51', 'alex-r': '0.50' } })
  })

  it('announces a bad split inline and does not apply it', async () => {
    const wrapper = mountEditor({ attachTo: document.body, props: {
      modelValue: { type: 'percentage', values: { 'maya-p': '90', 'alex-r': '5' } }, participants, currency: 'USD', totalMinorAmount: 101,
    } })
    await wrapper.get('[data-action="apply-split"]').trigger('click')

    expect(wrapper.get('[role="alert"]').text()).toContain('Percentages must total 100')
    const firstValue = wrapper.get<HTMLInputElement>('[data-participant-id="maya-p"]')
    expect(firstValue.attributes('aria-invalid')).toBe('true')
    expect(firstValue.attributes('aria-describedby')).toBe('split-error')
    expect(document.activeElement).toBe(firstValue.element)
    expect(wrapper.emitted('apply')).toBeUndefined()
    wrapper.unmount()
  })

  it('focuses and describes the actual malformed split value', async () => {
    const wrapper = mountEditor({ attachTo: document.body, props: {
      modelValue: { type: 'exact', values: { 'maya-p': '1.00', 'alex-r': 'not-a-number' } },
      participants,
      currency: 'USD',
      totalMinorAmount: 101,
    } })

    await wrapper.get('[data-action="apply-split"]').trigger('click')

    const invalid = wrapper.get<HTMLInputElement>('[data-participant-id="alex-r"]')
    expect(invalid.attributes()).toMatchObject({ 'aria-invalid': 'true', 'aria-describedby': 'split-error' })
    expect(wrapper.get('[data-participant-id="maya-p"]').attributes('aria-invalid')).toBeUndefined()
    expect(document.activeElement).toBe(invalid.element)
    wrapper.unmount()
  })

  it('connects an itemized split error to the selected method control', async () => {
    const wrapper = mountEditor({ attachTo: document.body, props: {
      modelValue: { type: 'itemized', items: [] }, participants, currency: 'USD', totalMinorAmount: 101,
    } })

    await wrapper.get('[data-action="apply-split"]').trigger('click')

    const itemized = wrapper.get<HTMLInputElement>('[data-method="itemized"]')
    expect(itemized.attributes()).toMatchObject({ 'aria-invalid': 'true', 'aria-describedby': 'split-error' })
    expect(document.activeElement).toBe(itemized.element)
    wrapper.unmount()
  })

  it.each([
    [[...participants, jordan], ['33.34', '33.33', '33.33']],
    [[...participants, jordan, taylor], ['25', '25', '25', '25']],
  ] as const)('defaults percentage inputs to an exact deterministic 100 percent for %s participants', async (people, expected) => {
    const wrapper = mountEditor({ props: {
      modelValue: { type: 'equal' }, participants: people, currency: 'USD', totalMinorAmount: 100,
    } })

    await wrapper.get('[data-method="percentage"]').trigger('click')

    expect(wrapper.findAll<HTMLInputElement>('[data-participant-id]').map(({ element }) => element.value)).toEqual(expected)
    await wrapper.get('[data-action="apply-split"]').trigger('click')
    expect(wrapper.find('[role="alert"]').exists()).toBe(false)
  })

  it('offers all seven methods in one Ionic radio group without a horizontal scroller', async () => {
    const wrapper = mountEditor({ attachTo: document.body, props: {
      modelValue: { type: 'equal' }, participants, currency: 'USD', totalMinorAmount: 100,
    } })
    const group = wrapper.getComponent({ name: 'IonRadioGroup' })

    expect(group.attributes('aria-label')).toBe('Split method')
    expect(group.props('value')).toBe('equal')
    expect(wrapper.findAllComponents({ name: 'IonRadio' }).map((radio) => radio.props('value'))).toEqual(['equal', 'exact', 'percentage', 'shares', 'adjustment', 'itemized', 'reimbursement'])
    expect(wrapper.findComponent({ name: 'IonSegment' }).exists()).toBe(false)

    // Ionic's radio group moves focus and selection together on arrow keys and reports the value through ionChange.
    group.vm.$emit('ionChange', { detail: { value: 'exact' } })
    await nextTick()
    expect(group.props('value')).toBe('exact')
    expect(wrapper.findAll('[data-participant-id]')).toHaveLength(2)
    wrapper.unmount()
  })

  it('emits dirty for each staged split-method change', async () => {
    const wrapper = mountEditor({ attachTo: document.body, props: {
      modelValue: { type: 'equal' }, participants, currency: 'USD', totalMinorAmount: 100,
    } })

    await wrapper.get('[data-method="exact"]').trigger('click')
    expect(wrapper.emitted('dirty')).toHaveLength(1)

    await wrapper.get('[data-method="exact"]').trigger('click')
    expect(wrapper.emitted('dirty')).toHaveLength(1)

    wrapper.getComponent({ name: 'IonRadioGroup' }).vm.$emit('ionChange', { detail: { value: 'percentage' } })
    await nextTick()
    expect(wrapper.emitted('dirty')).toHaveLength(2)
    wrapper.unmount()
  })

  it('labels each value with its person and method, and rebuilds the fields when the method changes', async () => {
    const wrapper = mountEditor({ props: {
      modelValue: { type: 'exact', values: { 'maya-p': '1.00', 'alex-r': '0.00' } }, participants, currency: 'USD', totalMinorAmount: 100,
    } })
    const exact = wrapper.get('[data-participant-id="maya-p"]')
    expect(exact.attributes()).toMatchObject({ 'aria-label': 'Maya P. exact', inputmode: 'decimal' })
    expect(wrapper.getComponent({ name: 'IonInput' }).props()).toMatchObject({ label: 'Maya P.', labelPlacement: 'start' })

    await wrapper.get('[data-method="shares"]').trigger('click')

    const shares = wrapper.get('[data-participant-id="maya-p"]')
    expect(shares.attributes('aria-label')).toBe('Maya P. shares')
    expect(shares.element).not.toBe(exact.element)
  })

  it('pins its Ionic toolbar above a keyboard-aware scroll surface', () => {
    const wrapper = mountEditor({ props: {
      modelValue: { type: 'equal' }, participants, currency: 'USD', totalMinorAmount: 100,
    } })

    const scrollSurface = wrapper.get('[data-ionic-content]').get<HTMLElement>('[data-sheet-scroll]')
    expect(scrollSurface.classes()).toContain('expense-sheet')
    expect(scrollSurface.element.style.getPropertyValue('--su-keyboard-inset')).toBe('0px')
    expect(scrollSurface.element.style.getPropertyValue('--su-visual-viewport-height')).toBe('')
    expect(wrapper.get('[data-ionic-header]').get('[data-ionic-title]').text()).toBe('Split expense')
    expect(scrollSurface.find('[data-ionic-header]').exists()).toBe(false)
  })

  it('names each native Ionic value field after its person and current method', async () => {
    const wrapper = mount(SplitEditor, { attachTo: document.body, props: {
      modelValue: { type: 'exact', values: { 'maya-p': '1.00', 'alex-r': '0.00' } }, participants, currency: 'USD', totalMinorAmount: 100,
    }, global: { plugins: [[IonicVue, { mode: 'ios' }]] } } as never)
    const nativeField = () => wrapper.get('[data-participant-id="maya-p"]').element.querySelector('input')

    await vi.waitFor(() => expect(nativeField()?.getAttribute('aria-label')).toBe('Maya P. exact'))
    wrapper.findComponent({ name: 'IonRadioGroup' }).vm.$emit('ionChange', { detail: { value: 'percentage' } })
    await vi.waitFor(() => expect(nativeField()?.getAttribute('aria-label')).toBe('Maya P. percentage'))
    expect(nativeField()?.getAttribute('inputmode')).toBe('decimal')
    wrapper.unmount()
  })
})
