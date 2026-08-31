import { describe, expect, it } from 'vitest'
import { createPaymentHandoff, type PaymentProviderConfiguration } from '../paymentProviders'

const configuration: PaymentProviderConfiguration = {
  paypal: { 'maya-p': { recipientToken: 'maya.payments' } },
  venmo: { 'maya-p': { recipientToken: 'maya-payments' } },
}

describe('trusted payment-provider handoffs', () => {
  it('builds only allowlisted provider destinations from UID-keyed configuration', () => {
    expect(createPaymentHandoff({
      provider: 'paypal', recipientId: 'maya-p', money: { currency: 'USD', minorAmount: 1234 }, note: 'Lake & dock', configuration,
    })).toEqual({
      status: 'available', provider: 'paypal', label: 'Open PayPal',
      url: 'https://www.paypal.com/paypalme/maya.payments/12.34USD?note=Lake%20%26%20dock',
    })
    expect(createPaymentHandoff({
      provider: 'venmo', recipientId: 'maya-p', money: { currency: 'USD', minorAmount: 1234 }, note: 'Lake & dock', configuration,
    })).toEqual({
      status: 'available', provider: 'venmo', label: 'Open Venmo',
      url: 'https://account.venmo.com/pay?recipients=maya-payments&txn=pay&amount=12.34&note=Lake%20%26%20dock',
    })
  })

  it('returns explicit unavailable states for missing UID configuration or unsupported currencies', () => {
    expect(createPaymentHandoff({
      provider: 'paypal', recipientId: 'taylor-s', money: { currency: 'USD', minorAmount: 500 }, note: '', configuration,
    })).toEqual({ status: 'unavailable', provider: 'paypal', reason: 'PayPal is not configured for this recipient. Record the completed payment manually instead.' })
    expect(createPaymentHandoff({
      provider: 'venmo', recipientId: 'maya-p', money: { currency: 'EUR', minorAmount: 500 }, note: '', configuration,
    })).toEqual({ status: 'unavailable', provider: 'venmo', reason: 'Venmo handoff is available only for USD. Record the completed payment manually instead.' })
  })

  it('rejects untrusted recipient tokens and never derives a handle from display text', () => {
    expect(() => createPaymentHandoff({
      provider: 'paypal', recipientId: 'maya-p', money: { currency: 'USD', minorAmount: 500 }, note: 'Paid',
      configuration: { paypal: { 'maya-p': { recipientToken: 'https://evil.example/Maya P.' } } },
    })).toThrow('trusted recipient token')
  })
})
