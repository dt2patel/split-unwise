import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
import ParticipantSheet from '../components/ParticipantSheet.vue'
import PayerSheet from '../components/PayerSheet.vue'
import ReceiptReview from '../components/ReceiptReview.vue'
import RecurrenceSheet from '../components/RecurrenceSheet.vue'

const members = [
  { id: 'maya-p', displayName: 'Maya P.', initials: 'MP', isCurrentUser: true },
  { id: 'alex-r', displayName: 'Alex R.', initials: 'AR', isCurrentUser: false },
]

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
    expect(wrapper.emitted('apply')?.[0]?.[0]).toEqual({ frequency: 'monthly', anchor: { month: 8, day: 30 }, timeZone: 'America/Chicago' })
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
})
