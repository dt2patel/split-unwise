import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
import type { SplitInput } from '../expenseStore'
import SplitEditor from '../components/SplitEditor.vue'

const participants = [
  { id: 'maya-p', displayName: 'Maya P.', initials: 'MP', isCurrentUser: true },
  { id: 'alex-r', displayName: 'Alex R.', initials: 'AR', isCurrentUser: false },
]

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

describe('SplitEditor', () => {
  it.each(cases)('validates and applies the %s method through exact domain allocation', async (_name, modelValue, amounts) => {
    const wrapper = mount(SplitEditor, { props: { modelValue, participants, currency: 'USD', totalMinorAmount: 101 } })

    await wrapper.get('[data-action="apply-split"]').trigger('click')

    const applied = wrapper.emitted('apply')?.[0]?.[0] as { readonly allocations: readonly { readonly money: { readonly minorAmount: number } }[] }
    expect(applied.allocations.map(({ money }) => money.minorAmount)).toEqual(amounts)
    expect(wrapper.find('[role="alert"]').exists()).toBe(false)
  })

  it('keeps edits staged until Apply and emits Cancel without mutating the input', async () => {
    const original: SplitInput = { type: 'exact', values: { 'maya-p': '0.51', 'alex-r': '0.50' } }
    const wrapper = mount(SplitEditor, { props: { modelValue: original, participants, currency: 'USD', totalMinorAmount: 101 } })
    await wrapper.get('[data-participant-id="maya-p"]').setValue('0.01')
    await wrapper.get('[data-action="cancel-split"]').trigger('click')

    expect(wrapper.emitted('apply')).toBeUndefined()
    expect(wrapper.emitted('cancel')).toHaveLength(1)
    expect(original).toEqual({ type: 'exact', values: { 'maya-p': '0.51', 'alex-r': '0.50' } })
  })

  it('announces a bad split inline and does not apply it', async () => {
    const wrapper = mount(SplitEditor, { props: {
      modelValue: { type: 'percentage', values: { 'maya-p': '90', 'alex-r': '5' } }, participants, currency: 'USD', totalMinorAmount: 101,
    } })
    await wrapper.get('[data-action="apply-split"]').trigger('click')

    expect(wrapper.get('[role="alert"]').text()).toContain('Percentages must total 100')
    expect(wrapper.emitted('apply')).toBeUndefined()
  })
})
