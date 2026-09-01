import type { ExpenseRow, SettlementRecord } from '../data/repositories'
import { computeAllocations } from './splits'
import type { Money, SplitMethod } from './model'
import { assertCurrencyCode, currencyExponent, type CurrencyCode } from './money'
import type { VerifiedFxRate } from './premiumProviders'

export interface GroupCurrencyConversion {
  readonly schemaVersion: 1
  readonly operationId: string
  readonly targetCurrency: CurrencyCode
  readonly convertedAt: string
  readonly rates: readonly VerifiedFxRate[]
}

export interface CurrencyConversionProvenance {
  readonly operationId: string
  readonly sourceMoney: Money
  readonly targetCurrency: CurrencyCode
  readonly authority: string
  readonly effectiveDate: string
}

export function applyCurrencyConversionToExpense(expense: ExpenseRow, conversion: GroupCurrencyConversion): ExpenseRow {
  const source = sourceMoneyForConversion(expense)
  if (expense.updatedAt > conversion.convertedAt || source.currency === conversion.targetCurrency) return expense
  const rate = rateFor(source.currency, conversion)
  const total = convertMoney(source, rate)
  const payments = distribute(total, expense.payments.map(({ participantId, money }) => ({ participantId, minorAmount: money.minorAmount })), expense.total.minorAmount)
  const splitMethod = convertSplitMethod(expense.splitMethod, total, expense.total.minorAmount)
  // Recompute through the ledger validator so a projected expense can cross every normal read boundary.
  const allocations = computeAllocations(total, splitMethod)
  return {
    ...expense,
    total,
    payments,
    allocations,
    splitMethod,
    currencyConversion: provenance(conversion, rate, source),
  }
}

function convertSplitMethod(method: SplitMethod, total: Money, sourceTotal: number): SplitMethod {
  switch (method.type) {
    case 'equal': return { type: 'equal', participantIds: [...method.participantIds] }
    case 'percentage': return { type: 'percentage', participantIds: [...method.participantIds], percentages: { ...method.percentages } }
    case 'shares': return { type: 'shares', participantIds: [...method.participantIds], shares: { ...method.shares } }
    case 'exact': return {
      type: 'exact',
      allocations: distribute(total, method.allocations.map(({ participantId, money }) => ({ participantId, minorAmount: money.minorAmount })), sourceTotal),
    }
    case 'adjustment': {
      const adjustmentTotal = method.participantIds.reduce((sum, participantId) => sum + method.adjustments[participantId]!, 0)
      const buckets = distribute(total, [
        ...method.participantIds.map((participantId) => ({ participantId, minorAmount: method.adjustments[participantId]! })),
        { participantId: '__conversion-residual__', minorAmount: sourceTotal - adjustmentTotal },
      ], sourceTotal)
      return {
        type: 'adjustment',
        participantIds: [...method.participantIds],
        adjustments: Object.fromEntries(method.participantIds.map((participantId, index) => [participantId, buckets[index]!.money.minorAmount])),
      }
    }
    case 'itemized': {
      const itemAmounts = distribute(total, method.items.map((item, index) => ({ participantId: `item-${index}`, minorAmount: item.money.minorAmount })), sourceTotal)
      return {
        type: 'itemized',
        items: method.items.map((item, index) => ({
          description: item.description,
          money: { currency: total.currency, minorAmount: itemAmounts[index]!.money.minorAmount },
          participantIds: [...item.participantIds],
        })),
      }
    }
  }
}

export function applyCurrencyConversionToSettlement(settlement: SettlementRecord, conversion: GroupCurrencyConversion): SettlementRecord {
  const source = settlement.currencyConversion?.sourceMoney ?? settlement.money
  if (settlement.createdAt > conversion.convertedAt || source.currency === conversion.targetCurrency) return settlement
  const rate = rateFor(source.currency, conversion)
  const money = convertMoney(source, rate)
  const debtMinor = convertMoney({ currency: source.currency, minorAmount: settlement.basis.debtMinor }, rate).minorAmount
  return {
    ...settlement,
    money,
    basis: { ...settlement.basis, currency: conversion.targetCurrency, debtMinor },
    currencyConversion: provenance(conversion, rate, source),
  }
}

export function sourceMoneyForConversion(expense: ExpenseRow): Money {
  return expense.currencyConversion?.sourceMoney ?? expense.total
}

function rateFor(sourceCurrency: CurrencyCode, conversion: GroupCurrencyConversion): VerifiedFxRate {
  assertGroupCurrencyConversion(conversion)
  const rate = conversion.rates.find(({ baseCurrency, quoteCurrency }) => baseCurrency === sourceCurrency && quoteCurrency === conversion.targetCurrency)
  if (!rate) throw new Error(`A ${sourceCurrency} to ${conversion.targetCurrency} conversion rate is required`)
  return rate
}

function convertMoney(source: Money, rate: VerifiedFxRate): Money {
  const numerator = BigInt(source.minorAmount) * BigInt(rate.numerator) * 10n ** BigInt(currencyExponent(rate.quoteCurrency))
  const denominator = BigInt(rate.denominator) * 10n ** BigInt(currencyExponent(rate.baseCurrency))
  const rounded = (numerator + denominator / 2n) / denominator
  if (rounded < 0n || rounded > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('Converted money exceeds the supported range')
  return { currency: rate.quoteCurrency, minorAmount: Number(rounded) }
}

function distribute(total: Money, values: readonly { readonly participantId: string; readonly minorAmount: number }[], sourceTotal: number) {
  if (!Number.isSafeInteger(sourceTotal) || sourceTotal <= 0) throw new Error('Conversion source total must be positive')
  if (!values.length || values.some(({ minorAmount }) => !Number.isSafeInteger(minorAmount) || minorAmount < 0)) throw new Error('Conversion allocations are invalid')
  if (values.reduce((sum, { minorAmount }) => sum + minorAmount, 0) !== sourceTotal) throw new Error('Conversion allocations must equal their source total')
  const denominator = BigInt(sourceTotal)
  const amounts = values.map(({ minorAmount }) => BigInt(total.minorAmount) * BigInt(minorAmount) / denominator)
  let remainder = BigInt(total.minorAmount) - amounts.reduce((sum, value) => sum + value, 0n)
  for (let index = 0; remainder > 0n; index = (index + 1) % amounts.length) {
    amounts[index] += 1n
    remainder -= 1n
  }
  return values.map(({ participantId }, index) => ({ participantId, money: { currency: total.currency, minorAmount: Number(amounts[index]) } }))
}

function provenance(conversion: GroupCurrencyConversion, rate: VerifiedFxRate, sourceMoney: Money): CurrencyConversionProvenance {
  return {
    operationId: conversion.operationId,
    sourceMoney: { ...sourceMoney },
    targetCurrency: conversion.targetCurrency,
    authority: rate.authority,
    effectiveDate: rate.effectiveDate,
  }
}

export function assertGroupCurrencyConversion(value: GroupCurrencyConversion): void {
  if (value.schemaVersion !== 1 || !value.operationId.trim()) throw new Error('Currency conversion identity is invalid')
  assertCurrencyCode(value.targetCurrency)
  const parsed = new Date(value.convertedAt)
  if (Number.isNaN(parsed.valueOf()) || parsed.toISOString() !== value.convertedAt) throw new Error('Currency conversion cutoff is invalid')
  if (value.rates.length > 16) throw new Error('A group conversion supports at most 16 source currencies')
  const sources = new Set<string>()
  for (const rate of value.rates) {
    assertCurrencyCode(rate.baseCurrency)
    assertCurrencyCode(rate.quoteCurrency)
    if (rate.quoteCurrency !== value.targetCurrency || rate.baseCurrency === value.targetCurrency || sources.has(rate.baseCurrency)) throw new Error('Currency conversion rates must be unique direct pairs')
    if (!Number.isSafeInteger(rate.numerator) || rate.numerator <= 0 || !Number.isSafeInteger(rate.denominator) || rate.denominator <= 0) throw new Error('Currency conversion rate terms are invalid')
    if (typeof rate.authority !== 'string' || !rate.authority.trim() || rate.authority.length > 200) throw new Error('Currency conversion rate authority is invalid')
    const effectiveDate = typeof rate.effectiveDate === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(rate.effectiveDate)
      ? new Date(`${rate.effectiveDate}T00:00:00.000Z`)
      : undefined
    if (!effectiveDate || Number.isNaN(effectiveDate.valueOf()) || effectiveDate.toISOString().slice(0, 10) !== rate.effectiveDate) throw new Error('Currency conversion rate effective date is invalid')
    const observedAt = new Date(rate.observedAt)
    if (Number.isNaN(observedAt.valueOf()) || observedAt.toISOString() !== rate.observedAt) throw new Error('Currency conversion rate observation is invalid')
    sources.add(rate.baseCurrency)
  }
}
