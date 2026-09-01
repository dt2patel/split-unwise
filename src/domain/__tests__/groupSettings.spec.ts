import { describe, expect, it } from 'vitest'
import type { Member } from '../../data/repositories'
import { applyGroupCurrencyConversion, clearInvalidDefaultSplit, decodeDefaultSplit, seedDefaultSplit, updateGroupSettings, type GroupSettings } from '../groupSettings'
import type { GroupCurrencyConversion } from '../currencyConversion'

const members: readonly Member[] = [
  { id: 'maya', displayName: 'Maya', initials: 'MP', isCurrentUser: true, canManage: true },
  { id: 'alex', displayName: 'Alex', initials: 'AR', isCurrentUser: false },
]
const initial: GroupSettings = { schemaVersion: 1, groupId: 'lake', revision: 1 }

describe('versioned shared split defaults', () => {
  it('requires active manager authority and the exact settings revision', () => {
    expect(() => updateGroupSettings(initial, { expectedRevision: 1, defaultSplit: { type: 'equal', participantIds: ['maya', 'alex'] } }, members, 'alex')).toThrow('manager')
    expect(() => updateGroupSettings(initial, { expectedRevision: 2, defaultSplit: { type: 'equal', participantIds: ['maya', 'alex'] } }, members, 'maya')).toThrow('changed')
    expect(updateGroupSettings(initial, { expectedRevision: 1, defaultSplit: { type: 'equal', participantIds: ['maya', 'alex'] } }, members, 'maya')).toEqual({ schemaVersion: 1, groupId: 'lake', revision: 2, defaultSplit: { type: 'equal', participantIds: ['maya', 'alex'] } })
  })

  it('accepts only equal, percentage, or shares with exact active-member keys', () => {
    expect(() => updateGroupSettings(initial, { expectedRevision: 1, defaultSplit: { type: 'exact', allocations: [] } }, members, 'maya')).toThrow('equal, percentage, or shares')
    expect(() => updateGroupSettings(initial, { expectedRevision: 1, defaultSplit: { type: 'percentage', participantIds: ['maya', 'alex'], percentages: { maya: 50 } } }, members, 'maya')).toThrow('key')
    expect(() => updateGroupSettings(initial, { expectedRevision: 1, defaultSplit: { type: 'shares', participantIds: ['maya', 'retired'], shares: { maya: 1, retired: 1 } } }, members, 'maya')).toThrow('active')
  })

  it('strictly decodes persisted defaults without extra fields, duplicate people, or invalid ratios', () => {
    expect(decodeDefaultSplit({ type: 'percentage', participantIds: ['maya', 'alex'], percentages: { maya: 60, alex: 40 } })).toEqual({ type: 'percentage', participantIds: ['maya', 'alex'], percentages: { maya: 60, alex: 40 } })
    expect(() => decodeDefaultSplit({ type: 'equal', participantIds: ['maya'], privateDraft: true })).toThrow('fields')
    expect(() => decodeDefaultSplit({ type: 'equal', participantIds: ['maya', 'maya'] })).toThrow('unique')
    expect(() => decodeDefaultSplit({ type: 'percentage', participantIds: ['maya'], percentages: { maya: 90, alex: 10 } })).toThrow('keys')
    expect(() => decodeDefaultSplit({ type: 'percentage', participantIds: ['maya'], percentages: { maya: 99 } })).toThrow('100')
  })

  it('clears the whole default when membership removal invalidates it', () => {
    const configured: GroupSettings = { schemaVersion: 1, groupId: 'lake', revision: 4, defaultSplit: { type: 'shares', participantIds: ['maya', 'alex'], shares: { maya: 1, alex: 2 } } }
    expect(clearInvalidDefaultSplit(configured, members)).toBe(configured)
    expect(clearInvalidDefaultSplit(configured, members.filter(({ id }) => id !== 'alex'))).toEqual({ schemaVersion: 1, groupId: 'lake', revision: 5 })
  })

  it('seeds only future drafts and never overwrites an itemized receipt split', () => {
    const configured: GroupSettings = { schemaVersion: 1, groupId: 'lake', revision: 2, defaultSplit: { type: 'equal', participantIds: ['maya', 'alex'] } }
    expect(seedDefaultSplit(configured)).toEqual(configured.defaultSplit)
    const itemized = { type: 'itemized' as const, items: [{ description: 'Coffee', money: { currency: 'USD' as const, minorAmount: 500 }, participantIds: ['maya'] }] }
    expect(seedDefaultSplit(configured, itemized)).toBe(itemized)
  })

  it('lets any active member toggle debt simplification while preserving the saved default split', () => {
    const configured: GroupSettings = {
      schemaVersion: 1, groupId: 'lake', revision: 4, simplifyDebtsEnabled: true,
      defaultSplit: { type: 'shares' as const, participantIds: ['maya', 'alex'], shares: { maya: 1, alex: 2 } },
    }

    expect(updateGroupSettings(configured, { expectedRevision: 4, simplifyDebtsEnabled: false }, members, 'alex')).toEqual({
      ...configured,
      revision: 5,
      simplifyDebtsEnabled: false,
    })
  })

  it('versions one manager-authorized applied currency conversion while preserving other shared settings', () => {
    const configured: GroupSettings = {
      schemaVersion: 1, groupId: 'lake', revision: 4, simplifyDebtsEnabled: false,
      defaultSplit: { type: 'shares', participantIds: ['maya', 'alex'], shares: { maya: 1, alex: 2 } },
    }
    const conversion: GroupCurrencyConversion = {
      schemaVersion: 1, operationId: 'convert-1', targetCurrency: 'EUR', convertedAt: '2026-09-01T12:00:00.000Z',
      rates: [{ baseCurrency: 'USD', quoteCurrency: 'EUR', numerator: 86_237, denominator: 100_000, authority: 'ECB', effectiveDate: '2026-08-29', observedAt: '2026-09-01T11:59:00.000Z' }],
    }

    expect(() => applyGroupCurrencyConversion(configured, 4, conversion, members, 'alex')).toThrow('manager')
    expect(() => applyGroupCurrencyConversion(configured, 3, conversion, members, 'maya')).toThrow('changed remotely')
    expect(applyGroupCurrencyConversion(configured, 4, conversion, members, 'maya')).toEqual({
      ...configured,
      revision: 5,
      currencyConversion: conversion,
    })
  })

  it('rejects ambiguous, indirect, or oversized conversion rate sets', () => {
    const base: GroupCurrencyConversion = {
      schemaVersion: 1, operationId: 'convert-1', targetCurrency: 'EUR', convertedAt: '2026-09-01T12:00:00.000Z',
      rates: [{ baseCurrency: 'USD', quoteCurrency: 'EUR', numerator: 86_237, denominator: 100_000, authority: 'ECB', effectiveDate: '2026-08-29', observedAt: '2026-09-01T11:59:00.000Z' }],
    }
    expect(() => applyGroupCurrencyConversion(initial, 1, { ...base, rates: [...base.rates, ...base.rates] }, members, 'maya')).toThrow('unique')
    expect(() => applyGroupCurrencyConversion(initial, 1, { ...base, rates: [{ ...base.rates[0]!, quoteCurrency: 'JPY' }] }, members, 'maya')).toThrow('direct')
    expect(() => applyGroupCurrencyConversion(initial, 1, { ...base, rates: Array.from({ length: 17 }, (_, index) => ({ ...base.rates[0]!, baseCurrency: index === 0 ? 'USD' : 'CAD' })) }, members, 'maya')).toThrow('16')
  })

  it('rejects unverified or malformed conversion-rate metadata', () => {
    const base: GroupCurrencyConversion = {
      schemaVersion: 1, operationId: 'convert-1', targetCurrency: 'EUR', convertedAt: '2026-09-01T12:00:00.000Z',
      rates: [{ baseCurrency: 'USD', quoteCurrency: 'EUR', numerator: 86_237, denominator: 100_000, authority: 'ECB', effectiveDate: '2026-08-29', observedAt: '2026-09-01T11:59:00.000Z' }],
    }
    expect(() => applyGroupCurrencyConversion(initial, 1, { ...base, rates: [{ ...base.rates[0]!, authority: '   ' }] }, members, 'maya')).toThrow('authority')
    expect(() => applyGroupCurrencyConversion(initial, 1, { ...base, rates: [{ ...base.rates[0]!, effectiveDate: '08/29/2026' }] }, members, 'maya')).toThrow('effective date')
    expect(() => applyGroupCurrencyConversion(initial, 1, { ...base, rates: [{ ...base.rates[0]!, observedAt: 'yesterday' }] }, members, 'maya')).toThrow('observation')
  })
})
