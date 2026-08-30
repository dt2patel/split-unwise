import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
import type { SplitInput } from '../expenseStore'
import SplitEditor from '../components/SplitEditor.vue'

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
    const wrapper = mount(SplitEditor, { attachTo: document.body, props: {
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
    const wrapper = mount(SplitEditor, { attachTo: document.body, props: {
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
    const wrapper = mount(SplitEditor, { attachTo: document.body, props: {
      modelValue: { type: 'itemized', items: [] }, participants, currency: 'USD', totalMinorAmount: 101,
    } })

    await wrapper.get('[data-action="apply-split"]').trigger('click')

    const itemized = wrapper.get<HTMLButtonElement>('[data-method="itemized"]')
    expect(itemized.attributes()).toMatchObject({ 'aria-invalid': 'true', 'aria-describedby': 'split-error' })
    expect(document.activeElement).toBe(itemized.element)
    wrapper.unmount()
  })

  it.each([
    [[...participants, jordan], ['33.34', '33.33', '33.33']],
    [[...participants, jordan, taylor], ['25', '25', '25', '25']],
  ] as const)('defaults percentage inputs to an exact deterministic 100 percent for %s participants', async (people, expected) => {
    const wrapper = mount(SplitEditor, { props: {
      modelValue: { type: 'equal' }, participants: people, currency: 'USD', totalMinorAmount: 100,
    } })

    await wrapper.get('[data-method="percentage"]').trigger('click')

    expect(wrapper.findAll<HTMLInputElement>('[data-participant-id]').map(({ element }) => element.value)).toEqual(expected)
    await wrapper.get('[data-action="apply-split"]').trigger('click')
    expect(wrapper.find('[role="alert"]').exists()).toBe(false)
  })

  it('uses keyboard-operable radio semantics with roving focus for split methods', async () => {
    const wrapper = mount(SplitEditor, { attachTo: document.body, props: {
      modelValue: { type: 'equal' }, participants, currency: 'USD', totalMinorAmount: 100,
    } })
    const equal = wrapper.get<HTMLButtonElement>('[data-method="equal"]')
    const exact = wrapper.get<HTMLButtonElement>('[data-method="exact"]')

    expect(wrapper.get('[aria-label="Split method"]').attributes('role')).toBe('radiogroup')
    expect(equal.attributes()).toMatchObject({ role: 'radio', 'aria-checked': 'true', tabindex: '0' })
    expect(exact.attributes('tabindex')).toBe('-1')

    equal.element.focus()
    await equal.trigger('keydown', { key: 'ArrowRight' })
    expect(exact.attributes('aria-checked')).toBe('true')
    expect(exact.attributes('tabindex')).toBe('0')
    expect(document.activeElement).toBe(exact.element)

    await exact.trigger('keydown', { key: 'End' })
    const itemized = wrapper.get<HTMLButtonElement>('[data-method="itemized"]')
    expect(itemized.attributes('aria-checked')).toBe('true')
    expect(document.activeElement).toBe(itemized.element)
    wrapper.unmount()
  })

  it('emits dirty for each staged split-method button change', async () => {
    const wrapper = mount(SplitEditor, { attachTo: document.body, props: {
      modelValue: { type: 'equal' }, participants, currency: 'USD', totalMinorAmount: 100,
    } })

    await wrapper.get('[data-method="exact"]').trigger('click')
    expect(wrapper.emitted('dirty')).toHaveLength(1)

    await wrapper.get('[data-method="exact"]').trigger('click')
    expect(wrapper.emitted('dirty')).toHaveLength(1)

    await wrapper.get('[data-method="exact"]').trigger('keydown', { key: 'ArrowRight' })
    expect(wrapper.emitted('dirty')).toHaveLength(2)
    wrapper.unmount()
  })

  it('exposes a bounded scroll surface and sticky sheet header', () => {
    const wrapper = mount(SplitEditor, { props: {
      modelValue: { type: 'equal' }, participants, currency: 'USD', totalMinorAmount: 100,
    } })

    const scrollSurface = wrapper.get<HTMLElement>('[data-sheet-scroll]')
    expect(scrollSurface.classes()).toContain('expense-sheet')
    expect(scrollSurface.element.style.getPropertyValue('--su-keyboard-inset')).toBe('0px')
    expect(scrollSurface.element.style.getPropertyValue('--su-visual-viewport-height')).toBe('')
    expect(wrapper.get('header').classes()).toContain('expense-sheet__header')
  })
})
