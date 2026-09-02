import type { Member } from '../../data/repositories'
import type { Money } from '../../domain/model'
import { assertCurrencyCode, fromMinorUnits } from '../../domain/money'

export type PaymentProvider = 'paypal' | 'venmo'

export interface PaymentProviderRecipient { readonly recipientToken: string }
export type PaymentProviderConfiguration = Partial<Record<PaymentProvider, Readonly<Record<string, PaymentProviderRecipient>>>>

export type PaymentHandoff =
  | { readonly status: 'available'; readonly provider: PaymentProvider; readonly label: string; readonly url: string }
  | { readonly status: 'unavailable'; readonly provider: PaymentProvider; readonly reason: string }

export interface PaymentHandoffRequest {
  readonly provider: PaymentProvider
  readonly recipientId: string
  readonly money: Money
  readonly note: string
  readonly configuration: PaymentProviderConfiguration
}

const TOKEN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/

/** Builds an external handoff only. This function has no ledger or confirmation side effects. */
export function createPaymentHandoff(request: PaymentHandoffRequest): PaymentHandoff {
  assertCurrencyCode(request.money.currency)
  if (!Number.isSafeInteger(request.money.minorAmount) || request.money.minorAmount <= 0) throw new Error('Payment handoff amount must be positive')
  if (request.provider !== 'paypal' && request.provider !== 'venmo') throw new Error('Payment provider is not allowlisted')
  if (request.provider === 'venmo' && request.money.currency !== 'USD') {
    return { status: 'unavailable', provider: request.provider, reason: 'Venmo handoff is available only for USD. Record the completed payment manually instead.' }
  }
  const configured = request.configuration[request.provider]?.[request.recipientId]
  if (!configured) {
    const name = request.provider === 'paypal' ? 'PayPal' : 'Venmo'
    return { status: 'unavailable', provider: request.provider, reason: `${name} is not configured for this recipient. Record the completed payment manually instead.` }
  }
  if (!TOKEN.test(configured.recipientToken)) throw new Error('Payment provider configuration must contain a trusted recipient token')
  const amount = fromMinorUnits(request.money.minorAmount, request.money.currency)
  const note = encodeURIComponent(request.note.normalize('NFC').trim())
  if (request.provider === 'paypal') {
    return {
      status: 'available',
      provider: request.provider,
      label: 'Open PayPal',
      url: `https://www.paypal.com/paypalme/${encodeURIComponent(configured.recipientToken)}/${encodeURIComponent(`${amount}${request.money.currency}`)}?note=${note}`,
    }
  }
  return {
    status: 'available',
    provider: request.provider,
    label: 'Open Venmo',
    url: `https://account.venmo.com/pay?recipients=${encodeURIComponent(configured.recipientToken)}&txn=pay&amount=${encodeURIComponent(amount)}&note=${note}`,
  }
}

export const EMPTY_PAYMENT_PROVIDER_CONFIGURATION: PaymentProviderConfiguration = Object.freeze({})

/** Projects opt-in shared member handles into the UID-keyed provider boundary. */
export function paymentProviderConfigurationFromMembers(
  members: readonly Pick<Member, 'id' | 'paymentHandles'>[],
): PaymentProviderConfiguration {
  const paypal: Record<string, PaymentProviderRecipient> = {}
  const venmo: Record<string, PaymentProviderRecipient> = {}
  for (const member of members) {
    if (member.paymentHandles?.paypal) paypal[member.id] = { recipientToken: member.paymentHandles.paypal }
    if (member.paymentHandles?.venmo) venmo[member.id] = { recipientToken: member.paymentHandles.venmo }
  }
  return {
    ...(Object.keys(paypal).length ? { paypal } : {}),
    ...(Object.keys(venmo).length ? { venmo } : {}),
  }
}
