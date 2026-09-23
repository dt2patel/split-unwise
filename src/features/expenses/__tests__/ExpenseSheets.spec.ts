import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { IonicVue } from '@ionic/vue'
import { mount, type VueWrapper } from '@vue/test-utils'
import { nextTick } from 'vue'
import { afterEach, describe, expect, it, vi } from 'vitest'
import ContextSheet from '../components/ContextSheet.vue'
import ParticipantSheet from '../components/ParticipantSheet.vue'
import PayerSheet from '../components/PayerSheet.vue'
import ReceiptReview from '../components/ReceiptReview.vue'
import RecurrenceSheet from '../components/RecurrenceSheet.vue'
import SplitEditor from '../components/SplitEditor.vue'
import { ionicSheetStubs } from './ionicSheetStubs'

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

type MountOptions = NonNullable<Parameters<typeof mount>[1]>
const mountedWrappers: VueWrapper[] = []
function mountSheet<T>(component: T, options: MountOptions): VueWrapper {
  return mount(component as Parameters<typeof mount>[0], { ...options, global: { ...options.global, stubs: { ...ionicSheetStubs, ...options.global?.stubs } } })
}
function mountAttached<T>(component: T, options: MountOptions): VueWrapper {
  const wrapper = mountSheet(component, { ...options, attachTo: document.body })
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
    const wrapper = mountSheet(PayerSheet, { props: {
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

  it('stages exact reimbursement amounts each participant should receive', async () => {
    const wrapper = mountSheet(SplitEditor, { props: {
      modelValue: { type: 'equal' }, participants: members, currency: 'USD', totalMinorAmount: 1000,
    } })

    await wrapper.get('[data-method="reimbursement"]').trigger('click')
    await wrapper.get('[data-participant-id="maya-p"]').setValue('4.00')
    await wrapper.get('[data-participant-id="alex-r"]').setValue('6.00')
    await wrapper.get('[data-action="apply-split"]').trigger('click')

    expect(wrapper.emitted('apply')?.[0]?.[0]).toEqual({
      input: { type: 'reimbursement', values: { 'maya-p': '4.00', 'alex-r': '6.00' } },
      allocations: [
        { participantId: 'maya-p', money: { currency: 'USD', minorAmount: 400 } },
        { participantId: 'alex-r', money: { currency: 'USD', minorAmount: 600 } },
      ],
    })
  })

  it('labels refund recipients distinctly from expense payers', () => {
    const wrapper = mountSheet(PayerSheet, { props: {
      modelValue: [{ participantId: 'maya-p', amountText: '10.00' }], members, currency: 'USD', totalMinorAmount: 1000, reimbursement: true,
    } })

    expect(wrapper.get('#payer-title').text()).toBe('Refund received by')
    expect(wrapper.get('.expense-sheet > p').text()).toContain('what each received')
    const amount = wrapper.get('[data-payer-id="maya-p"]')
    expect(amount.attributes('aria-label')).toBe('Maya P. received amount')
    expect(amount.attributes('inputmode')).toBe('decimal')
  })

  it('uses Ionic checkboxes for payers, with an amount field only for selected payers', async () => {
    const wrapper = mountSheet(PayerSheet, { props: {
      modelValue: [{ participantId: 'maya-p', amountText: '10.00' }], members, currency: 'USD', totalMinorAmount: 1000,
    } })
    const checkboxes = wrapper.findAllComponents({ name: 'IonCheckbox' })
    expect(checkboxes.map((checkbox) => [checkbox.props('checked'), checkbox.props('justify'), checkbox.props('labelPlacement')])).toEqual([
      [true, 'start', 'end'],
      [false, 'start', 'end'],
    ])
    expect(wrapper.get('[data-payer-select-id="alex-r"]').attributes('aria-label')).toBe('Select Alex R. as payer')
    expect(wrapper.find('[data-payer-id="alex-r"]').exists()).toBe(false)

    await wrapper.get('[data-payer-select-id="alex-r"]').setValue(true)

    expect(wrapper.get('[data-payer-id="alex-r"]').element).toHaveProperty('value', '')
    expect(wrapper.emitted('dirty')).toHaveLength(1)
    await wrapper.get('[data-payer-id="alex-r"]').setValue('2.50')
    expect(wrapper.emitted('dirty')).toHaveLength(2)
    expect(wrapper.emitted('apply')).toBeUndefined()
  })

  it('keeps participant toggles staged when Cancel is chosen', async () => {
    const selected = ['maya-p']
    const wrapper = mountSheet(ParticipantSheet, { props: { modelValue: selected, members } })
    await wrapper.get('[data-participant-id="alex-r"]').setValue(true)
    expect(wrapper.emitted('dirty')).toHaveLength(1)
    await wrapper.get('[data-action="cancel-participants"]').trigger('click')
    expect(wrapper.emitted('apply')).toBeUndefined()
    expect(wrapper.emitted('cancel')).toHaveLength(1)
    expect(selected).toEqual(['maya-p'])
  })

  it('applies the participants chosen with Ionic checkboxes', async () => {
    const wrapper = mountSheet(ParticipantSheet, { props: { modelValue: ['maya-p'], members } })
    expect(wrapper.findAllComponents({ name: 'IonCheckbox' }).map((checkbox) => checkbox.props('checked'))).toEqual([true, false])

    await wrapper.get('[data-participant-id="alex-r"]').setValue(true)
    await wrapper.get('[data-participant-id="maya-p"]').setValue(false)
    await wrapper.get('[data-action="apply-participants"]').trigger('click')

    expect(wrapper.emitted('apply')?.[0]?.[0]).toEqual(['alex-r'])
  })

  it('picks a group or friend from an Ionic radio list', async () => {
    const second = { ...groups[0], id: 'friend-alex', name: 'Alex R.' }
    const wrapper = mountSheet(ContextSheet, { props: { groups: [...groups, second], modelValue: 'lake-house-weekend' } })
    const radioGroup = wrapper.getComponent({ name: 'IonRadioGroup' })
    expect(radioGroup.attributes('aria-label')).toBe('Expense context')
    expect(radioGroup.props('value')).toBe('lake-house-weekend')
    expect(wrapper.get('[data-context-id="friend-alex"]').element.closest('[data-ionic-list]')?.getAttribute('data-inset')).toBe('true')

    radioGroup.vm.$emit('ionChange', { detail: { value: 'friend-alex' } })
    await nextTick()
    expect(radioGroup.props('value')).toBe('friend-alex')
    expect(wrapper.emitted('dirty')).toHaveLength(1)

    await wrapper.get('[data-action="apply-context"]').trigger('click')
    expect(wrapper.emitted('apply')?.[0]?.[0]).toBe('friend-alex')
  })

  it('applies recurrence with an IANA time zone and calendar anchor', async () => {
    const wrapper = mountSheet(RecurrenceSheet, { props: { modelValue: undefined, date: '2026-08-30' } })
    await wrapper.get('[data-frequency="monthly"]').trigger('click')
    await wrapper.get('[data-testid="recurrence-time-zone"]').setValue('America/Chicago')
    expect(wrapper.emitted('dirty')).toHaveLength(2)
    await wrapper.get('[data-action="apply-recurrence"]').trigger('click')
    expect(wrapper.emitted('apply')?.[0]?.[0]).toEqual({
      recurrence: { frequency: 'monthly', anchor: { month: 8, day: 30 }, timeZone: 'America/Chicago' },
    })
  })

  it('keeps unavailable OCR copy visible and confirms editable manual items, tax, and tip', async () => {
    const wrapper = mountSheet(ReceiptReview, { props: {
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

  it('announces an active on-device scan and holds confirmation until suggestions arrive', () => {
    const wrapper = mountSheet(ReceiptReview, { props: {
      modelValue: [], members, currency: 'USD', totalMinorAmount: 0, scanState: 'recognizing',
    } })

    expect(wrapper.get('[data-testid="receipt-scan-progress"]').text()).toContain('Scanning on this device')
    expect(wrapper.get('[data-testid="receipt-scan-progress"]').attributes('aria-live')).toBe('polite')
    expect(wrapper.get('[data-action="confirm-receipt"]').attributes('disabled')).toBeDefined()
    expect(wrapper.get('.add-line').attributes('disabled')).toBeDefined()
  })

  it('emits dirty when Add item stages a receipt row', async () => {
    const wrapper = mountSheet(ReceiptReview, { props: {
      modelValue: [], members, currency: 'USD', totalMinorAmount: 1000,
    } })

    const addItem = wrapper.get('.add-line')
    expect(addItem.attributes()).toMatchObject({ 'data-size': 'small', 'data-fill': 'clear' })
    await addItem.trigger('click')

    expect(wrapper.emitted('dirty')).toHaveLength(1)
    expect(wrapper.findAll('.receipt-item')).toHaveLength(1)
    expect(wrapper.emitted('confirm')).toBeUndefined()
  })

  it('emits dirty for each staged recurrence choice change', async () => {
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

    // Arrow keys inside Ionic's radio group move the selection and report it through ionChange.
    wrapper.getComponent({ name: 'IonRadioGroup' }).vm.$emit('ionChange', { detail: { value: 'fortnightly' } })
    await nextTick()
    expect(wrapper.emitted('dirty')).toHaveLength(3)
  })

  it.each([
    [{ status: 'local-only', reason: 'Upload has not completed.' }, 'Saved only on this device.', 'Upload has not completed.'],
    [{ status: 'upload-unavailable', reason: 'Receipt uploads are offline.' }, 'Upload unavailable; saved only on this device.', 'Receipt uploads are offline.'],
  ] as const)('shows an explicit receipt durability warning for %s', (durability, summary, reason) => {
    const wrapper = mountSheet(ReceiptReview, { props: {
      modelValue: [], members, currency: 'USD', totalMinorAmount: 1000, durability,
    } })

    const warning = wrapper.get('[data-testid="receipt-durability-warning"]')
    expect(warning.text()).toContain(summary)
    expect(warning.text()).toContain(reason)
  })

  it('does not warn that an uploaded receipt is device-only', () => {
    const wrapper = mountSheet(ReceiptReview, { props: {
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
    expect(context.getComponent({ name: 'IonRadioGroup' }).attributes()).toMatchObject({ 'aria-invalid': 'true', 'aria-describedby': 'context-error' })
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

    await payerAmount.setValue('10.00')
    expect(payerAmount.attributes('aria-invalid')).toBeUndefined()
    expect(payerAmount.attributes('aria-describedby')).toBeUndefined()
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

  it('labels the recurrence time zone as an Ionic stacked field', () => {
    const recurrence = mountSheet(RecurrenceSheet, { props: { modelValue: undefined, date: '2026-08-30' } })
    const timeZone = recurrence.getComponent({ name: 'IonInput' })
    expect(timeZone.props()).toMatchObject({ label: 'Time zone', labelPlacement: 'stacked' })
    expect(timeZone.attributes('autocomplete')).toBe('off')
  })

  it('focuses Done when the expense date is not valid for a schedule', async () => {
    const recurrence = mountAttached(RecurrenceSheet, { props: { modelValue: undefined, date: '' } })
    await recurrence.get('[data-frequency="weekly"]').trigger('click')
    await recurrence.get('[data-action="apply-recurrence"]').trigger('click')

    expect(recurrence.get('[role="alert"]').text()).toBe('Choose a valid expense date first.')
    expect(document.activeElement).toBe(recurrence.get('[data-action="apply-recurrence"]').element)
    expect(recurrence.emitted('apply')).toBeUndefined()
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
    expect(occurrence.attributes()).toMatchObject({ 'aria-invalid': 'true', 'aria-describedby': 'recurrence-error' })
    expect(wrapper.getComponent({ name: 'IonSegment' }).attributes()).toMatchObject({ 'aria-invalid': 'true', 'aria-describedby': 'recurrence-error' })
    expect(document.activeElement).toBe(occurrence.element)

    await wrapper.get(`[data-occurrence-scope="${scope}"]`).trigger('click')
    await wrapper.get('[data-action="apply-recurrence"]').trigger('click')
    expect(wrapper.emitted('apply')?.[0]?.[0]).toEqual({
      recurrence: { frequency: 'monthly', anchor: { month: 8, day: 30 }, timeZone: 'America/Chicago' },
      occurrenceEditScope: scope,
    })
  })

  it('uses an Ionic radio list for frequency and a select-on-focus segment for the edit scope', async () => {
    const wrapper = mountAttached(RecurrenceSheet, { props: {
      modelValue: undefined,
      date: '2026-08-30',
      occurrenceEditScope: 'occurrence',
      isRecurringInstance: true,
    } })
    const frequency = wrapper.getComponent({ name: 'IonRadioGroup' })
    expect(frequency.attributes('aria-label')).toBe('Repeat frequency')
    expect(frequency.props('value')).toBe('none')
    expect(wrapper.findAll<HTMLInputElement>('[data-frequency]').map(({ element }) => element.value)).toEqual(['none', 'weekly', 'fortnightly', 'monthly', 'yearly'])
    expect(wrapper.get('[data-frequency="none"]').element.closest('label')?.textContent).toBe('Does not repeat')

    frequency.vm.$emit('ionChange', { detail: { value: 'weekly' } })
    await nextTick()
    expect(frequency.props('value')).toBe('weekly')

    const scope = wrapper.getComponent({ name: 'IonSegment' })
    expect(scope.attributes('aria-label')).toBe('Recurring expense edit scope')
    // Arrow keys select as they move, like the radio group this segment replaced.
    expect(scope.props()).toMatchObject({ value: 'occurrence', selectOnFocus: true })
    expect(wrapper.findAll('[data-occurrence-scope]').map((button) => button.text())).toEqual(['This occurrence', 'This and future expenses'])

    scope.vm.$emit('ionChange', { detail: { value: 'future' } })
    await nextTick()
    expect(scope.props('value')).toBe('future')
    expect(wrapper.emitted('dirty')).toHaveLength(2)
  })

  it('reopens a future-edited occurrence with neither scope segment selected', () => {
    const wrapper = mountSheet(RecurrenceSheet, { props: { modelValue: undefined, date: '2026-08-30', isRecurringInstance: true } })
    expect(wrapper.getComponent({ name: 'IonSegment' }).props('value')).toBeUndefined()
  })

  it.each([
    ['context', ContextSheet, { groups, modelValue: '' }, 'Done'],
    ['participants', ParticipantSheet, { modelValue: ['maya-p'], members }, 'Done'],
    ['payers', PayerSheet, { modelValue: [{ participantId: 'maya-p', amountText: '10.00' }], members, currency: 'USD', totalMinorAmount: 1000 }, 'Done'],
    ['split', SplitEditor, { modelValue: { type: 'equal' }, participants: members, currency: 'USD', totalMinorAmount: 1000 }, 'Done'],
    ['recurrence', RecurrenceSheet, { modelValue: undefined, date: '2026-08-30' }, 'Done'],
    ['receipt', ReceiptReview, { modelValue: [], members, currency: 'USD', totalMinorAmount: 1000 }, 'Confirm'],
  ] as const)('%s sheet pins an Ionic toolbar above its keyboard-aware scroll surface', (_name, component, props, primaryLabel) => {
    const wrapper = mountSheet(component, { props } as never)
    const header = wrapper.get('[data-ionic-header]')
    const content = wrapper.get('[data-ionic-content]')
    const scrollSurface = content.get<HTMLElement>('[data-sheet-scroll]')
    expect(scrollSurface.classes()).toEqual(expect.arrayContaining(['expense-sheet', 'expense-sheet--ionic-content']))
    expect(scrollSurface.element.style.getPropertyValue('--su-keyboard-inset')).toBe('0px')
    expect(scrollSurface.element.style.getPropertyValue('--su-visual-viewport-height')).toBe('')
    expect(header.find('[data-sheet-scroll]').exists()).toBe(false)
    expect(content.find('[data-ionic-header]').exists()).toBe(false)

    const title = header.get('[data-ionic-title]')
    expect(title.attributes()).toMatchObject({ role: 'heading', 'aria-level': '2' })
    expect(scrollSurface.attributes('aria-labelledby')).toBe(title.attributes('id'))
    const [cancel, primary] = header.findAll('button')
    expect(cancel?.text()).toBe('Cancel')
    expect(primary?.text()).toBe(primaryLabel)
    expect(primary?.attributes('data-strong')).toBe('true')
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

  it('defines keyboard-aware padding for the sheet body inside its own Ionic scroll content', () => {
    const css = readFileSync(resolve(process.cwd(), 'src/features/expenses/components/expense-sheet.css'), 'utf8')
    const style = document.createElement('style')
    style.dataset.testSheetStyles = 'true'
    style.textContent = css
    document.head.append(style)
    const rules = Array.from(style.sheet?.cssRules ?? []).filter((rule): rule is CSSStyleRule => 'selectorText' in rule)
    const sheetRule = rules.find(({ selectorText }) => selectorText === '.expense-sheet')
    const ionicContentRule = rules.find(({ selectorText }) => selectorText === '.expense-sheet.expense-sheet--ionic-content')

    expect(sheetRule?.style.getPropertyValue('--su-visual-viewport-height')).toBe('')
    expect(sheetRule?.style.getPropertyValue('--su-keyboard-inset')).toBe('0px')
    expect(sheetRule?.style.padding).toContain('env(safe-area-inset-bottom, 0px)')
    expect(sheetRule?.style.padding).toContain('var(--su-keyboard-inset)')
    expect(sheetRule?.style.padding).not.toContain('keyboard-inset-height')
    // ion-content scrolls the sheet, so the body must not become a second, nested scroller.
    expect(ionicContentRule?.style.overflowY).toBe('visible')
    expect(ionicContentRule?.style.maxHeight).toBe('none')
    expect(ionicContentRule?.style.minHeight).toBe('100%')
  })

  it('themes the scope segment with Ionic tokens and keeps sheet styles free of fixed colors', () => {
    const componentCss = ['ContextSheet', 'ParticipantSheet', 'PayerSheet', 'SplitEditor', 'RecurrenceSheet', 'ReceiptReview'].map((name) => {
      const source = readFileSync(resolve(process.cwd(), `src/features/expenses/components/${name}.vue`), 'utf8')
      return source.match(/<style scoped>([\s\S]*?)<\/style>\s*$/)?.[1] ?? ''
    })
    for (const css of componentCss) expect(css).not.toMatch(/#[0-9a-f]{3,8}\b/i)

    const style = document.createElement('style')
    style.dataset.testSheetStyles = 'true'
    style.textContent = componentCss[4] ?? ''
    document.head.append(style)
    const segmentButton = Array.from(style.sheet?.cssRules ?? [])
      .filter((rule): rule is CSSStyleRule => 'selectorText' in rule)
      .find(({ selectorText }) => selectorText === '.occurrence-scope ion-segment-button')
    expect(segmentButton?.style.getPropertyValue('--color-checked').trim()).toBe('var(--ion-color-primary)')
    expect(segmentButton?.style.getPropertyValue('--indicator-color').trim()).toBe('var(--su-surface)')
  })
})

describe('staged expense sheets with real Ionic controls', () => {
  const ionic = { plugins: [[IonicVue, { mode: 'ios' }]] } as unknown as MountOptions['global']

  function mountIonic<T>(component: T, props: Record<string, unknown>): VueWrapper {
    const wrapper = mount(component as Parameters<typeof mount>[0], { attachTo: document.body, props, global: ionic })
    mountedWrappers.push(wrapper)
    return wrapper
  }
  async function hydrated(element: Element): Promise<void> {
    await vi.waitFor(() => expect(element.classList.contains('hydrated')).toBe(true))
  }

  it('focuses and marks the native field inside an ion-input when a payer total is invalid', async () => {
    const wrapper = mountIonic(PayerSheet, { modelValue: [{ participantId: 'maya-p', amountText: '6.00' }], members, currency: 'USD', totalMinorAmount: 1000 })
    const host = wrapper.get('[data-payer-id="maya-p"]').element
    await hydrated(host)
    const native = host.querySelector('input')
    if (!native) throw new Error('Expected ion-input to render its native input')
    expect(native.getAttribute('aria-label')).toBe('Maya P. paid amount')
    expect(native.getAttribute('inputmode')).toBe('decimal')

    await wrapper.get('[data-action="apply-payers"]').trigger('click')

    await vi.waitFor(() => {
      expect(document.activeElement).toBe(native)
      expect(native.getAttribute('aria-invalid')).toBe('true')
      expect(native.getAttribute('aria-describedby')).toBe('payer-error')
    })

    native.value = '10.00'
    native.dispatchEvent(new Event('input', { bubbles: true }))
    await vi.waitFor(() => expect(native.hasAttribute('aria-invalid')).toBe(false))
    expect(native.hasAttribute('aria-describedby')).toBe(false)
    expect(wrapper.find('[role="alert"]').exists()).toBe(false)
  })

  it('selects a payer from the Ionic checkbox host and focuses it when nobody is selected', async () => {
    const wrapper = mountIonic(PayerSheet, { modelValue: [], members, currency: 'USD', totalMinorAmount: 1000 })
    const checkbox = wrapper.get('[data-payer-select-id="maya-p"]').element as HTMLElement
    await hydrated(checkbox)

    await wrapper.get('[data-action="apply-payers"]').trigger('click')
    await vi.waitFor(() => expect(document.activeElement).toBe(checkbox))
    expect(checkbox.getAttribute('aria-invalid')).toBe('true')
    expect(checkbox.getAttribute('aria-describedby')).toBe('payer-error')

    checkbox.click()
    await vi.waitFor(() => expect(wrapper.find('[data-payer-id="maya-p"]').exists()).toBe(true))
    expect(wrapper.emitted('dirty')).toHaveLength(1)
  })

  it('binds keyboard avoidance to the scroll element of the sheet\'s own ion-content', async () => {
    const contentElement = customElements.get('ion-content') as (CustomElementConstructor & { prototype: { getScrollElement(): Promise<HTMLElement> } }) | undefined
    if (!contentElement) throw new Error('Expected Ionic to define ion-content')
    const getScrollElement = vi.spyOn(contentElement.prototype, 'getScrollElement')
    const wrapper = mountIonic(ReceiptReview, { modelValue: [], members, currency: 'USD', totalMinorAmount: 1000 })
    const content = wrapper.get('ion-content').element

    expect(wrapper.get('[data-sheet-scroll]').element.closest('ion-content')).toBe(content)
    expect(wrapper.get('ion-header').element.contains(content)).toBe(false)
    await vi.waitFor(() => expect(getScrollElement).toHaveBeenCalled())
    expect(getScrollElement.mock.contexts[0]).toBe(content)
    getScrollElement.mockRestore()
  })

  it('focuses the scope segment button through its Ionic focus API when no scope is chosen', async () => {
    const wrapper = mountIonic(RecurrenceSheet, { modelValue: undefined, date: '2026-08-30', isRecurringInstance: true })
    const occurrence = wrapper.get('[data-occurrence-scope="occurrence"]').element
    await hydrated(occurrence)

    await wrapper.get('[data-action="apply-recurrence"]').trigger('click')

    await vi.waitFor(() => expect(document.activeElement).toBe(occurrence))
    expect(wrapper.get('[role="alert"]').text()).toContain('this occurrence or this and future')
  })
})
