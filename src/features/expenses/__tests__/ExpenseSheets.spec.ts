import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { mount, type VueWrapper } from '@vue/test-utils'
import { afterEach, describe, expect, it } from 'vitest'
import ContextSheet from '../components/ContextSheet.vue'
import ParticipantSheet from '../components/ParticipantSheet.vue'
import PayerSheet from '../components/PayerSheet.vue'
import ReceiptReview from '../components/ReceiptReview.vue'
import RecurrenceSheet from '../components/RecurrenceSheet.vue'

const members = [
  { id: 'maya-p', displayName: 'Maya P.', initials: 'MP', isCurrentUser: true },
  { id: 'alex-r', displayName: 'Alex R.', initials: 'AR', isCurrentUser: false },
]

const groups = [{
  id: 'lake-house-weekend',
  name: 'Lake House Weekend With A Very Long Context Name That Must Remain Readable',
  currency: 'USD' as const,
  memberIds: ['maya-p', 'alex-r'],
  syncState: 'fresh' as const,
}]

const mountedWrappers: VueWrapper[] = []
function mountAttached<T>(component: T, options: Parameters<typeof mount>[1]): VueWrapper {
  const wrapper = mount(component as Parameters<typeof mount>[0], { ...options, attachTo: document.body })
  mountedWrappers.push(wrapper)
  return wrapper
}

afterEach(() => {
  mountedWrappers.splice(0).forEach((wrapper) => wrapper.unmount())
  document.documentElement.style.removeProperty('font-size')
  document.head.querySelectorAll('[data-test-sheet-styles]').forEach((element) => element.remove())
})

describe('staged expense sheets', () => {
  it('applies multiple payer amounts only when they equal the total', async () => {
    const wrapper = mount(PayerSheet, { props: {
      modelValue: [{ participantId: 'maya-p', amountText: '6.00' }, { participantId: 'alex-r', amountText: '3.00' }], members, currency: 'USD', totalMinorAmount: 1000,
    } })
    await wrapper.get('[data-action="apply-payers"]').trigger('click')
    expect(wrapper.get('[role="alert"]').text()).toContain('equal the expense total')

    await wrapper.get('[data-payer-id="alex-r"]').setValue('4.00')
    await wrapper.get('[data-action="apply-payers"]').trigger('click')
    expect(wrapper.emitted('apply')?.[0]?.[0]).toEqual([
      { participantId: 'maya-p', amountText: '6.00' },
      { participantId: 'alex-r', amountText: '4.00' },
    ])
  })

  it('keeps participant toggles staged when Cancel is chosen', async () => {
    const selected = ['maya-p']
    const wrapper = mount(ParticipantSheet, { props: { modelValue: selected, members } })
    await wrapper.get('[data-participant-id="alex-r"]').setValue(true)
    await wrapper.get('[data-action="cancel-participants"]').trigger('click')
    expect(wrapper.emitted('apply')).toBeUndefined()
    expect(wrapper.emitted('cancel')).toHaveLength(1)
    expect(selected).toEqual(['maya-p'])
  })

  it('applies recurrence with an IANA time zone and calendar anchor', async () => {
    const wrapper = mount(RecurrenceSheet, { props: { modelValue: undefined, date: '2026-08-30' } })
    await wrapper.get('[data-frequency="monthly"]').trigger('click')
    await wrapper.get('[data-testid="recurrence-time-zone"]').setValue('America/Chicago')
    await wrapper.get('[data-action="apply-recurrence"]').trigger('click')
    expect(wrapper.emitted('apply')?.[0]?.[0]).toEqual({
      recurrence: { frequency: 'monthly', anchor: { month: 8, day: 30 }, timeZone: 'America/Chicago' },
    })
  })

  it('keeps unavailable OCR copy visible and confirms editable manual items, tax, and tip', async () => {
    const wrapper = mount(ReceiptReview, { props: {
      modelValue: [{ description: 'Dinner', amountText: '8.00', participantIds: ['maya-p', 'alex-r'] }],
      members, currency: 'USD', totalMinorAmount: 1000, providerMessage: 'Receipt recognition is not configured. You can enter items manually.',
    } })
    expect(wrapper.get('[role="status"]').text()).toContain('not configured')
    await wrapper.get('[data-testid="receipt-tax"]').setValue('1.00')
    await wrapper.get('[data-testid="receipt-tip"]').setValue('1.00')
    await wrapper.get('[data-action="confirm-receipt"]').trigger('click')

    expect(wrapper.emitted('confirm')?.[0]?.[0]).toEqual([
      { description: 'Dinner', amountText: '8.00', participantIds: ['maya-p', 'alex-r'] },
      { description: 'Tax', amountText: '1.00', participantIds: ['maya-p', 'alex-r'] },
      { description: 'Tip', amountText: '1.00', participantIds: ['maya-p', 'alex-r'] },
    ])
  })

  it('emits dirty when Add item stages a receipt row', async () => {
    const wrapper = mount(ReceiptReview, { props: {
      modelValue: [], members, currency: 'USD', totalMinorAmount: 1000,
    } })

    await wrapper.get('.add-line').trigger('click')

    expect(wrapper.emitted('dirty')).toHaveLength(1)
    expect(wrapper.findAll('.receipt-item')).toHaveLength(1)
    expect(wrapper.emitted('confirm')).toBeUndefined()
  })

  it('emits dirty for each staged recurrence button change', async () => {
    const wrapper = mountAttached(RecurrenceSheet, { props: {
      modelValue: undefined,
      date: '2026-08-30',
      isRecurringInstance: true,
    } })

    await wrapper.get('[data-frequency="weekly"]').trigger('click')
    expect(wrapper.emitted('dirty')).toHaveLength(1)

    await wrapper.get('[data-frequency="weekly"]').trigger('click')
    expect(wrapper.emitted('dirty')).toHaveLength(1)

    await wrapper.get('[data-occurrence-scope="future"]').trigger('click')
    expect(wrapper.emitted('dirty')).toHaveLength(2)

    await wrapper.get('[data-frequency="weekly"]').trigger('keydown', { key: 'ArrowRight' })
    expect(wrapper.emitted('dirty')).toHaveLength(3)
  })

  it.each([
    [{ status: 'local-only', reason: 'Upload has not completed.' }, 'Saved only on this device.', 'Upload has not completed.'],
    [{ status: 'upload-unavailable', reason: 'Receipt uploads are offline.' }, 'Upload unavailable; saved only on this device.', 'Receipt uploads are offline.'],
  ] as const)('shows an explicit receipt durability warning for %s', (durability, summary, reason) => {
    const wrapper = mount(ReceiptReview, { props: {
      modelValue: [], members, currency: 'USD', totalMinorAmount: 1000, durability,
    } })

    const warning = wrapper.get('[data-testid="receipt-durability-warning"]')
    expect(warning.text()).toContain(summary)
    expect(warning.text()).toContain(reason)
  })

  it('does not warn that an uploaded receipt is device-only', () => {
    const wrapper = mount(ReceiptReview, { props: {
      modelValue: [], members, currency: 'USD', totalMinorAmount: 1000,
      durability: { status: 'uploaded', attachmentRef: 'receipts/expense-1.jpg' },
    } })

    expect(wrapper.find('[data-testid="receipt-durability-warning"]').exists()).toBe(false)
  })

  it('marks and focuses the context selector when no context is chosen', async () => {
    const context = mountAttached(ContextSheet, { props: { groups, modelValue: '' } })
    await context.get('[data-action="apply-context"]').trigger('click')
    const contextRadio = context.get<HTMLInputElement>('[data-context-id="lake-house-weekend"]')
    expect(contextRadio.attributes()).toMatchObject({ 'aria-invalid': 'true', 'aria-describedby': 'context-error' })
    expect(document.activeElement).toBe(contextRadio.element)
  })

  it('marks and focuses the participant selector when no participant is chosen', async () => {
    const participant = mountAttached(ParticipantSheet, { props: { modelValue: [], members } })
    await participant.get('[data-action="apply-participants"]').trigger('click')
    const participantCheckbox = participant.get<HTMLInputElement>('[data-participant-id="maya-p"]')
    expect(participantCheckbox.attributes()).toMatchObject({ 'aria-invalid': 'true', 'aria-describedby': 'participant-error' })
    expect(document.activeElement).toBe(participantCheckbox.element)
  })

  it('marks and focuses payer amounts when their total is invalid', async () => {
    const payer = mountAttached(PayerSheet, { props: {
      modelValue: [{ participantId: 'maya-p', amountText: '6.00' }], members, currency: 'USD', totalMinorAmount: 1000,
    } })
    await payer.get('[data-action="apply-payers"]').trigger('click')
    const payerAmount = payer.get<HTMLInputElement>('[data-payer-id="maya-p"]')
    expect(payerAmount.attributes()).toMatchObject({ 'aria-invalid': 'true', 'aria-describedby': 'payer-error' })
    expect(document.activeElement).toBe(payerAmount.element)
  })

  it('marks and focuses the first receipt field missing a required value', async () => {
    const receipt = mountAttached(ReceiptReview, { props: {
      modelValue: [{ description: '', amountText: '10.00', participantIds: ['maya-p'] }],
      members, currency: 'USD', totalMinorAmount: 1000,
    } })
    await receipt.get('[data-action="confirm-receipt"]').trigger('click')
    const description = receipt.get<HTMLInputElement>('[data-item-description="0"]')
    expect(description.attributes()).toMatchObject({ 'aria-invalid': 'true', 'aria-describedby': 'receipt-error' })
    expect(document.activeElement).toBe(description.element)
  })

  it('marks and focuses an invalid recurrence time zone', async () => {
    const recurrence = mountAttached(RecurrenceSheet, { props: { modelValue: undefined, date: '2026-08-30' } })
    await recurrence.get('[data-frequency="monthly"]').trigger('click')
    await recurrence.get('[data-testid="recurrence-time-zone"]').setValue('Not/A_Real_Zone')
    await recurrence.get('[data-action="apply-recurrence"]').trigger('click')
    const timeZone = recurrence.get<HTMLInputElement>('[data-testid="recurrence-time-zone"]')
    expect(timeZone.attributes()).toMatchObject({ 'aria-invalid': 'true', 'aria-describedby': 'recurrence-error' })
    expect(document.activeElement).toBe(timeZone.element)
  })

  it('focuses the malformed payer amount instead of an earlier valid payer', async () => {
    const payer = mountAttached(PayerSheet, { props: {
      modelValue: [
        { participantId: 'maya-p', amountText: '6.00' },
        { participantId: 'alex-r', amountText: 'not-a-number' },
      ],
      members,
      currency: 'USD',
      totalMinorAmount: 1000,
    } })
    await payer.get('[data-action="apply-payers"]').trigger('click')
    const invalidPayerAmount = payer.get<HTMLInputElement>('[data-payer-id="alex-r"]')
    expect(invalidPayerAmount.attributes('aria-invalid')).toBe('true')
    expect(payer.get('[data-payer-id="maya-p"]').attributes('aria-invalid')).toBeUndefined()
    expect(document.activeElement).toBe(invalidPayerAmount.element)
  })

  it('focuses the malformed receipt amount instead of an earlier valid item', async () => {
    const receipt = mountAttached(ReceiptReview, { props: {
      modelValue: [
        { description: 'Dinner', amountText: '6.00', participantIds: ['maya-p'] },
        { description: 'Drinks', amountText: 'not-a-number', participantIds: ['alex-r'] },
      ],
      members,
      currency: 'USD',
      totalMinorAmount: 1000,
    } })
    await receipt.get('[data-action="confirm-receipt"]').trigger('click')
    const invalidReceiptAmount = receipt.get<HTMLInputElement>('[data-item-amount="1"]')
    expect(invalidReceiptAmount.attributes('aria-invalid')).toBe('true')
    expect(receipt.get('[data-item-amount="0"]').attributes('aria-invalid')).toBeUndefined()
    expect(document.activeElement).toBe(invalidReceiptAmount.element)
  })

  it('focuses malformed tip input after a valid tax value', async () => {
    const receipt = mountAttached(ReceiptReview, { props: {
      modelValue: [{ description: 'Dinner', amountText: '8.00', participantIds: ['maya-p'] }],
      members,
      currency: 'USD',
      totalMinorAmount: 1000,
    } })
    await receipt.get('[data-testid="receipt-tax"]').setValue('1.00')
    await receipt.get('[data-testid="receipt-tip"]').setValue('not-a-number')

    await receipt.get('[data-action="confirm-receipt"]').trigger('click')

    const tip = receipt.get<HTMLInputElement>('[data-testid="receipt-tip"]')
    expect(tip.attributes()).toMatchObject({ 'aria-invalid': 'true', 'aria-describedby': 'receipt-error' })
    expect(receipt.get('[data-testid="receipt-tax"]').attributes('aria-invalid')).toBeUndefined()
    expect(document.activeElement).toBe(tip.element)
  })

  it.each(['occurrence', 'future'] as const)('requires an explicit occurrence scope and emits the staged %s choice', async (scope) => {
    const wrapper = mountAttached(RecurrenceSheet, { props: {
      modelValue: { frequency: 'monthly', anchor: { month: 8, day: 30 }, timeZone: 'America/Chicago' },
      date: '2026-08-30',
      isRecurringInstance: true,
    } })

    await wrapper.get('[data-action="apply-recurrence"]').trigger('click')
    const occurrence = wrapper.get<HTMLButtonElement>('[data-occurrence-scope="occurrence"]')
    expect(wrapper.get('[role="alert"]').text()).toContain('this occurrence or this and future')
    expect(occurrence.attributes()).toMatchObject({ role: 'radio', 'aria-invalid': 'true', 'aria-describedby': 'recurrence-error' })
    expect(document.activeElement).toBe(occurrence.element)

    await wrapper.get(`[data-occurrence-scope="${scope}"]`).trigger('click')
    await wrapper.get('[data-action="apply-recurrence"]').trigger('click')
    expect(wrapper.emitted('apply')?.[0]?.[0]).toEqual({
      recurrence: { frequency: 'monthly', anchor: { month: 8, day: 30 }, timeZone: 'America/Chicago' },
      occurrenceEditScope: scope,
    })
  })

  it('uses roving keyboard focus for recurrence frequency and occurrence scope radio groups', async () => {
    const wrapper = mountAttached(RecurrenceSheet, { props: {
      modelValue: undefined,
      date: '2026-08-30',
      occurrenceEditScope: 'occurrence',
      isRecurringInstance: true,
    } })
    const none = wrapper.get<HTMLButtonElement>('[data-frequency="none"]')
    const weekly = wrapper.get<HTMLButtonElement>('[data-frequency="weekly"]')
    expect(none.attributes('tabindex')).toBe('0')
    expect(weekly.attributes('tabindex')).toBe('-1')
    none.element.focus()

    await none.trigger('keydown', { key: 'ArrowRight' })

    expect(weekly.attributes('aria-checked')).toBe('true')
    expect(document.activeElement).toBe(weekly.element)

    const occurrence = wrapper.get<HTMLButtonElement>('[data-occurrence-scope="occurrence"]')
    const future = wrapper.get<HTMLButtonElement>('[data-occurrence-scope="future"]')
    expect(occurrence.attributes('tabindex')).toBe('0')
    expect(future.attributes('tabindex')).toBe('-1')
    occurrence.element.focus()

    await occurrence.trigger('keydown', { key: 'ArrowRight' })

    expect(future.attributes('aria-checked')).toBe('true')
    expect(document.activeElement).toBe(future.element)
  })

  it.each([
    ['context', ContextSheet, { groups, modelValue: '' }],
    ['participants', ParticipantSheet, { modelValue: ['maya-p'], members }],
    ['payers', PayerSheet, { modelValue: [{ participantId: 'maya-p', amountText: '10.00' }], members, currency: 'USD', totalMinorAmount: 1000 }],
    ['receipt', ReceiptReview, { modelValue: [], members, currency: 'USD', totalMinorAmount: 1000 }],
    ['recurrence', RecurrenceSheet, { modelValue: undefined, date: '2026-08-30' }],
  ] as const)('%s sheet exposes the shared bounded scroll surface and sticky header', (_name, component, props) => {
    const wrapper = mount(component, { props } as never)
    const scrollSurface = wrapper.get<HTMLElement>('[data-sheet-scroll]')
    expect(scrollSurface.classes()).toContain('expense-sheet')
    expect(scrollSurface.element.style.getPropertyValue('--su-keyboard-inset')).toBe('0px')
    expect(scrollSurface.element.style.getPropertyValue('--su-visual-viewport-height')).toBe('')
    expect(wrapper.get('header').classes()).toContain('expense-sheet__header')
  })

  it('keeps long summaries readable at a 200 percent Dynamic Type approximation', () => {
    const css = readFileSync(resolve(process.cwd(), 'src/features/expenses/components/expense-sheet.css'), 'utf8')
    const style = document.createElement('style')
    style.dataset.testSheetStyles = 'true'
    style.textContent = css
    document.head.append(style)
    document.documentElement.style.fontSize = '32px'

    const context = mountAttached(ContextSheet, { props: { groups, modelValue: 'lake-house-weekend' } })
    const contextName = context.get('.sheet-list span')
    expect(contextName.text()).toBe(groups[0].name)
    expect(getComputedStyle(contextName.element).overflowWrap).toBe('anywhere')
    expect(getComputedStyle(contextName.element).fontSize).toBe('32px')
  })

  it('keeps receipt assignment targets at least 44 points', () => {
    const css = readFileSync(resolve(process.cwd(), 'src/features/expenses/components/expense-sheet.css'), 'utf8')
    const style = document.createElement('style')
    style.dataset.testSheetStyles = 'true'
    style.textContent = css
    document.head.append(style)
    const receipt = mountAttached(ReceiptReview, { props: {
      modelValue: [{ description: 'Dinner', amountText: '10.00', participantIds: ['maya-p'] }],
      members, currency: 'USD', totalMinorAmount: 1000,
    } })
    const assignmentTarget = receipt.get('.receipt-item fieldset label')
    expect(getComputedStyle(assignmentTarget.element).minHeight).toBe('44px')
    expect(getComputedStyle(assignmentTarget.element).minWidth).toBe('44px')
  })

  it('uses content-sized receipt labels and shrinkable inputs at Dynamic Type sizes', () => {
    const source = readFileSync(resolve(process.cwd(), 'src/features/expenses/components/ReceiptReview.vue'), 'utf8')
    const localCss = source.match(/<style scoped>([\s\S]*?)<\/style>\s*$/)?.[1] ?? ''
    const style = document.createElement('style')
    style.dataset.testSheetStyles = 'true'
    style.textContent = localCss
    document.head.append(style)
    document.documentElement.style.fontSize = '32px'
    const receipt = mountAttached(ReceiptReview, { props: {
      modelValue: [{ description: 'Dinner', amountText: '10.00', participantIds: ['maya-p'] }],
      members, currency: 'USD', totalMinorAmount: 1000,
    } })

    const row = receipt.get('.receipt-item > label')
    const input = row.get('input')
    expect(getComputedStyle(row.element).gridTemplateColumns).toBe('max-content minmax(0, 1fr)')
    expect(getComputedStyle(input.element).minWidth).toBe('0px')
  })

  it('defines bounded keyboard-aware scrolling and a sticky header through the parsed stylesheet contract', () => {
    const css = readFileSync(resolve(process.cwd(), 'src/features/expenses/components/expense-sheet.css'), 'utf8')
    const style = document.createElement('style')
    style.dataset.testSheetStyles = 'true'
    style.textContent = css
    document.head.append(style)
    const rules = Array.from(style.sheet?.cssRules ?? []).filter((rule): rule is CSSStyleRule => 'selectorText' in rule)
    const sheetRule = rules.find(({ selectorText }) => selectorText === '.expense-sheet')
    const headerRule = rules.find(({ selectorText }) => selectorText === '.expense-sheet header, .expense-sheet__header')

    expect(sheetRule?.style.overflowY).toBe('auto')
    expect(sheetRule?.style.minHeight).toBe('min(50dvh, 420px)')
    expect(sheetRule?.style.maxHeight).toBe('min(86dvh, 760px)')
    expect(sheetRule?.style.getPropertyValue('--su-visual-viewport-height')).toBe('')
    expect(sheetRule?.style.getPropertyValue('--su-keyboard-inset')).toBe('0px')
    expect(sheetRule?.style.padding).toContain('env(safe-area-inset-bottom, 0px)')
    expect(sheetRule?.style.padding).toContain('var(--su-keyboard-inset)')
    expect(sheetRule?.style.padding).not.toContain('keyboard-inset-height')
    expect(headerRule?.style.position).toBe('sticky')
    expect(headerRule?.style.top).toBe('0px')
  })

  it('binds interactive and selected sheet states to the Ionic primary contrast pair', () => {
    const css = readFileSync(resolve(process.cwd(), 'src/features/expenses/components/expense-sheet.css'), 'utf8')
    const style = document.createElement('style')
    style.dataset.testSheetStyles = 'true'
    style.textContent = css
    document.head.append(style)
    const rules = Array.from(style.sheet?.cssRules ?? []).filter((rule): rule is CSSStyleRule => 'selectorText' in rule)
    const action = rules.find(({ selectorText }) => selectorText === '.expense-sheet button')
    const nativeChoice = rules.find(({ selectorText }) => selectorText === '.sheet-list input[type="checkbox"], .sheet-list input[type="radio"]')
    const selected = rules.find(({ selectorText }) => selectorText.includes('.frequency-grid button[aria-checked="true"]'))

    expect(action?.style.color).toBe('var(--ion-color-primary)')
    expect(nativeChoice?.style.getPropertyValue('accent-color')).toBe('var(--ion-color-primary)')
    expect(selected?.style.background).toBe('var(--ion-color-primary)')
    expect(selected?.style.color).toBe('var(--ion-color-primary-contrast)')
  })
})
