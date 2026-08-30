import { computed, reactive, ref } from 'vue'
import { defineStore } from 'pinia'
import { getAppSession } from '../../data/session'
import type { ExpenseDraft, ExpenseRow, Group, Member } from '../../data/repositories'
import type { LocalReceiptReference, ReceiptSuggestion } from '../../data/receipts'
import { assertCurrencyCode, fromMinorUnits, toMinorUnits, type CurrencyCode } from '../../domain/money'
import { computeAllocations } from '../../domain/splits'
import type { ItemizedSplitItem, Recurrence, SplitMethod } from '../../domain/model'

export type ExpenseOrigin = 'account' | 'activity' | 'groups' | 'home'
export type ExpenseSheet = 'context' | 'participants' | 'payers' | 'receipt' | 'recurrence' | 'split'

export interface PaymentInput { readonly participantId: string; readonly amountText: string }
export interface ReceiptItemInput { readonly description: string; readonly amountText: string; readonly participantIds: readonly string[] }
export type SplitInput =
  | { readonly type: 'equal' }
  | { readonly type: 'exact' | 'percentage' | 'shares' | 'adjustment'; readonly values: Readonly<Record<string, string>> }
  | { readonly type: 'itemized'; readonly items: readonly ReceiptItemInput[] }

export interface ExpenseEditorInput {
  groupId: string
  description: string
  date: string
  currency: CurrencyCode
  amountText: string
  category: string
  participants: string[]
  payments: PaymentInput[]
  split: SplitInput
  notes?: string
  attachmentRefs: string[]
  recurrence?: Recurrence
  occurrenceEditScope?: 'future' | 'single'
}

export interface ExpenseValidationResult {
  readonly valid: boolean
  readonly errors: Readonly<Record<string, string>>
  readonly draft?: ExpenseDraft
}

export function validateExpenseInput(input: ExpenseEditorInput, members: readonly Member[]): ExpenseValidationResult {
  const errors: Record<string, string> = {}
  const activeIds = new Set(members.map(({ id }) => id))
  const groupId = input.groupId.trim()
  const description = input.description.trim()
  const category = input.category.trim()
  if (!groupId) errors.context = 'Choose a group or friend.'
  if (!description) errors.description = 'Enter a description.'
  if (!category) errors.category = 'Choose a category.'
  if (!isIsoDate(input.date)) errors.date = 'Choose a valid date.'

  let totalMinorAmount: number | undefined
  try {
    assertCurrencyCode(input.currency)
    totalMinorAmount = toMinorUnits(input.amountText, input.currency)
    if (totalMinorAmount <= 0) errors.amount = 'Enter an amount greater than zero.'
  } catch (reason) {
    errors.amount = messageFor(reason, 'Enter a valid amount.')
  }

  const participants = [...input.participants]
  if (participants.length === 0 || new Set(participants).size !== participants.length || participants.some((id) => !activeIds.has(id))) {
    errors.participants = 'Choose each active participant once.'
  }

  const paymentInputs = input.payments.length === 1 && !input.payments[0].amountText.trim() && totalMinorAmount !== undefined
    ? [{ ...input.payments[0], amountText: fromMinorUnits(totalMinorAmount, input.currency) }]
    : input.payments
  const payments = paymentInputs.flatMap(({ participantId, amountText }) => {
    try {
      const minorAmount = toMinorUnits(amountText, input.currency)
      if (minorAmount < 0) throw new Error('Payment amounts cannot be negative.')
      return [{ participantId, money: { currency: input.currency, minorAmount } }]
    } catch {
      errors.payments = 'Enter valid non-negative payer amounts.'
      return []
    }
  })
  if (paymentInputs.length === 0 || new Set(paymentInputs.map(({ participantId }) => participantId)).size !== paymentInputs.length || paymentInputs.some(({ participantId }) => !activeIds.has(participantId))) {
    errors.payments = 'Choose each active payer once.'
  }
  if (totalMinorAmount !== undefined && payments.reduce((sum, payment) => sum + BigInt(payment.money.minorAmount), 0n) !== BigInt(totalMinorAmount)) {
    errors.payments = 'Payer amounts must equal the expense total.'
  }

  let splitMethod: SplitMethod | undefined
  let allocations: ExpenseDraft['allocations'] | undefined
  if (totalMinorAmount !== undefined && totalMinorAmount > 0 && !errors.participants) {
    try {
      splitMethod = splitMethodFromInput(input.split, participants, input.currency)
      allocations = computeAllocations({ currency: input.currency, minorAmount: totalMinorAmount }, splitMethod)
      if (allocations.some(({ participantId }) => !activeIds.has(participantId))) throw new Error('Split contains an inactive participant.')
    } catch (reason) {
      errors.split = messageFor(reason, 'Finish the split so every share matches the total.')
    }
  } else if (!errors.participants) {
    errors.split = 'Enter the total before editing the split.'
  } else {
    errors.split = 'Choose valid participants before editing the split.'
  }

  if (input.recurrence && !isIanaTimeZone(input.recurrence.timeZone)) errors.recurrence = 'Choose a valid time zone.'
  if (input.occurrenceEditScope && input.occurrenceEditScope !== 'single' && input.occurrenceEditScope !== 'future') errors.recurrence = 'Choose whether to edit one occurrence or future expenses.'
  if (input.attachmentRefs.some((reference) => !reference.trim())) errors.receipt = 'Remove invalid receipt references.'

  if (Object.keys(errors).length || totalMinorAmount === undefined || !splitMethod || !allocations) return { valid: false, errors }
  return {
    valid: true,
    errors,
    draft: {
      groupId,
      description,
      date: input.date,
      total: { currency: input.currency, minorAmount: totalMinorAmount },
      payments,
      allocations,
      category,
      splitMethod,
      attachmentRefs: [...input.attachmentRefs],
      ...(input.notes?.trim() ? { notes: input.notes.trim() } : {}),
      ...(input.recurrence ? { recurrence: input.recurrence } : {}),
      ...(input.occurrenceEditScope ? { occurrenceEditScope: input.occurrenceEditScope } : {}),
    },
  }
}

export const useExpenseStore = defineStore('expense-editor', () => {
  const session = getAppSession()
  const editor = reactive<ExpenseEditorInput>(emptyEditor())
  const members = ref<readonly Member[]>([])
  const availableGroups = ref<readonly Group[]>([])
  const contextName = ref('')
  const currentUser = ref<Member>()
  const mode = ref<'add' | 'edit'>('add')
  const origin = ref<ExpenseOrigin>('home')
  const expenseId = ref<string>()
  const revision = ref<number>()
  const errors = ref<Readonly<Record<string, string>>>({})
  const errorSummary = ref('')
  const notice = ref('')
  const receiptMessage = ref('')
  const receiptSuggestions = ref<readonly ReceiptSuggestion[]>([])
  const activeSheet = ref<ExpenseSheet>()
  const focusTarget = ref<string>()
  const lastOperationId = ref<string>()
  const saveState = ref<'idle' | 'pending' | 'saved' | 'failed' | 'conflicted'>('idle')
  const isLoading = ref(false)
  const loadError = ref('')
  let initialFingerprint = JSON.stringify(editor)

  const isDirty = computed(() => JSON.stringify(editor) !== initialFingerprint)
  const returnPath = computed(() => origin.value === 'groups' && editor.groupId ? `/tabs/groups/${editor.groupId}` : `/tabs/${origin.value}`)

  async function initialize(options: { readonly origin: ExpenseOrigin; readonly groupId?: string; readonly expenseId?: string; readonly today?: string }): Promise<void> {
    reset()
    origin.value = options.origin
    expenseId.value = options.expenseId
    mode.value = options.expenseId ? 'edit' : 'add'
    editor.date = options.today ?? new Date().toISOString().slice(0, 10)
    isLoading.value = true
    try {
      const [loadedCurrentUser, groups] = await Promise.all([
        session.repository.app.getCurrentUser(),
        session.repository.groups.list(),
      ])
      currentUser.value = loadedCurrentUser
      availableGroups.value = groups
      if (options.groupId) {
        const [group, loadedMembers] = await Promise.all([
          session.repository.groups.getById(options.groupId),
          session.repository.groups.listMembers(options.groupId),
        ])
        if (!group || group.id !== options.groupId) throw new Error('This group is not available.')
        if (!loadedMembers.some(({ id }) => id === loadedCurrentUser.id)) throw new Error('You are not an active member of this group.')
        members.value = loadedMembers
        contextName.value = group.name
        editor.groupId = group.id
        editor.currency = group.currency
        editor.participants = loadedMembers.map(({ id }) => id)
        editor.payments = [{ participantId: loadedCurrentUser.id, amountText: '' }]
      } else {
        members.value = [loadedCurrentUser]
        editor.participants = [loadedCurrentUser.id]
        editor.payments = [{ participantId: loadedCurrentUser.id, amountText: '' }]
      }
      if (options.expenseId) {
        if (!options.groupId) throw new Error('Editing an expense requires a valid group context.')
        const expense = await session.repository.expenses.getById(options.groupId, options.expenseId)
        if (!expense) throw new Error('This expense is not available.')
        hydrate(expense)
      }
      initialFingerprint = JSON.stringify(editor)
    } catch (reason) {
      loadError.value = messageFor(reason, 'The expense editor could not be loaded.')
    } finally {
      isLoading.value = false
    }
  }

  async function selectContext(groupId: string): Promise<boolean> {
    const group = availableGroups.value.find(({ id }) => id === groupId)
    if (!group) {
      errors.value = { ...errors.value, context: 'This group or friend is not available.' }
      return false
    }
    try {
      const loadedMembers = await session.repository.groups.listMembers(group.id)
      const user = currentUser.value ?? await session.repository.app.getCurrentUser()
      if (!loadedMembers.some(({ id }) => id === user.id)) throw new Error('You are not an active member of this group.')
      const currencyChanged = editor.currency !== group.currency
      members.value = loadedMembers
      contextName.value = group.name
      editor.groupId = group.id
      editor.currency = group.currency
      editor.participants = loadedMembers.map(({ id }) => id)
      editor.payments = [{ participantId: user.id, amountText: '' }]
      editor.split = { type: 'equal' }
      if (currencyChanged) editor.amountText = ''
      const { context: _context, participants: _participants, payments: _payments, split: _split, ...remainingErrors } = errors.value
      errors.value = remainingErrors
      notice.value = currencyChanged
        ? 'The amount, payer amounts, and split values were reset for this context currency.'
        : 'Payers, participants, and split values were reset for the selected context.'
      return true
    } catch (reason) {
      errors.value = { ...errors.value, context: messageFor(reason, 'This group or friend is not available.') }
      return false
    }
  }

  function changeCurrency(currency: CurrencyCode): void {
    if (editor.currency === currency) return
    editor.currency = currency
    editor.amountText = ''
    editor.payments = []
    editor.split = { type: 'equal' }
    notice.value = 'Amount, payer amounts, and split values were reset for the new currency.'
  }

  function submit(operationId = createOperationId()): boolean {
    const validation = validateExpenseInput(editor, members.value)
    errors.value = validation.errors
    if (!validation.valid || !validation.draft) {
      errorSummary.value = `Please fix ${Object.keys(validation.errors).length} highlighted field${Object.keys(validation.errors).length === 1 ? '' : 's'}.`
      saveState.value = 'failed'
      return false
    }
    errorSummary.value = ''
    const command = mode.value === 'edit' && expenseId.value && revision.value !== undefined
      ? { kind: 'expense.edit' as const, operationId, groupId: validation.draft.groupId, expenseId: expenseId.value, expectedRevision: revision.value, draft: validation.draft }
      : { kind: 'expense.add' as const, operationId, ...validation.draft }
    const handle = session.queue.submit(command)
    lastOperationId.value = operationId
    saveState.value = 'pending'
    void handle.result().then((result) => {
      if (result.status !== 'saved') return
      saveState.value = 'saved'
      const savedExpense = 'expense' in result ? result.expense : undefined
      if (savedExpense) {
        revision.value = savedExpense.revision
        initialFingerprint = JSON.stringify(editor)
      }
      notice.value = mode.value === 'edit' ? 'Expense updated.' : 'Expense saved.'
    }).catch(() => {
      const operation = session.queue.get(operationId)
      saveState.value = operation?.status === 'conflicted' ? 'conflicted' : 'failed'
      errorSummary.value = operation?.status === 'conflicted' ? 'This expense changed elsewhere. Your draft and the remote revision are both preserved.' : 'Save failed. Retry or discard the draft from the group journal.'
    })
    return true
  }

  async function attachReceipt(blob: Blob, fileName: string): Promise<void> {
    const reference = await session.receipts.put(blob, { fileName })
    editor.attachmentRefs = [...editor.attachmentRefs, reference]
    const recognition = await session.receiptProvider.recognize(reference)
    if (recognition.status === 'suggestions') {
      receiptSuggestions.value = recognition.items
      receiptMessage.value = recognition.source === 'demo' ? 'Demo suggestions are ready to edit. Confirm them before applying a split.' : 'Suggestions are ready to edit. Confirm them before applying a split.'
    } else {
      receiptSuggestions.value = []
      receiptMessage.value = recognition.reason
    }
  }

  async function removeReceipt(reference: string): Promise<void> {
    editor.attachmentRefs = editor.attachmentRefs.filter((item) => item !== reference)
    if (reference.startsWith('local-receipt:')) await session.receipts.delete(reference as LocalReceiptReference)
    else await session.receiptProvider.delete(reference)
  }

  function confirmReceipt(items: readonly ReceiptItemInput[]): boolean {
    try {
      const total = toMinorUnits(editor.amountText, editor.currency)
      const splitMethod = splitMethodFromInput({ type: 'itemized', items }, editor.participants, editor.currency)
      computeAllocations({ currency: editor.currency, minorAmount: total }, splitMethod)
      editor.split = { type: 'itemized', items: items.map((item) => ({ ...item, participantIds: [...item.participantIds] })) }
      receiptMessage.value = 'Receipt items confirmed and applied to the split.'
      return true
    } catch (reason) {
      receiptMessage.value = messageFor(reason, 'Receipt items must equal the expense total.')
      return false
    }
  }

  function openSheet(sheet: ExpenseSheet, returnFocusId: string): void {
    activeSheet.value = sheet
    focusTarget.value = returnFocusId
  }

  function closeSheet(): void { activeSheet.value = undefined }

  return {
    editor, members, availableGroups, contextName, mode, origin, expenseId, revision, errors, errorSummary, notice, receiptMessage, receiptSuggestions,
    activeSheet, focusTarget, lastOperationId, saveState, isLoading, loadError, isDirty, returnPath,
    initialize, selectContext, changeCurrency, submit, attachReceipt, removeReceipt, confirmReceipt, openSheet, closeSheet,
  }

  function reset(): void {
    Object.assign(editor, emptyEditor())
    members.value = []
    availableGroups.value = []
    contextName.value = ''
    currentUser.value = undefined
    expenseId.value = undefined
    revision.value = undefined
    errors.value = {}
    errorSummary.value = ''
    notice.value = ''
    receiptMessage.value = ''
    receiptSuggestions.value = []
    activeSheet.value = undefined
    focusTarget.value = undefined
    lastOperationId.value = undefined
    saveState.value = 'idle'
    loadError.value = ''
  }

  function hydrate(expense: ExpenseRow): void {
    editor.groupId = expense.groupId
    editor.description = expense.description
    editor.date = expense.date
    editor.currency = expense.total.currency
    editor.amountText = fromMinorUnits(expense.total.minorAmount, expense.total.currency)
    editor.category = expense.category
    editor.participants = expense.allocations.map(({ participantId }) => participantId)
    editor.payments = expense.payments.map(({ participantId, money }) => ({ participantId, amountText: fromMinorUnits(money.minorAmount, money.currency) }))
    editor.split = splitInputFromMethod(expense.splitMethod, expense.total.currency)
    editor.notes = expense.notes ?? ''
    editor.attachmentRefs = [...expense.attachmentRefs]
    editor.recurrence = expense.recurrence
    editor.occurrenceEditScope = expense.occurrenceEditScope
    revision.value = expense.revision
  }
})

function emptyEditor(): ExpenseEditorInput {
  return {
    groupId: '', description: '', date: '', currency: 'USD', amountText: '', category: '', participants: [], payments: [], split: { type: 'equal' }, notes: '', attachmentRefs: [],
  }
}

export function splitMethodFromInput(input: SplitInput, participantIds: readonly string[], currency: CurrencyCode): SplitMethod {
  if (input.type === 'equal') return { type: 'equal', participantIds }
  if (input.type === 'itemized') {
    const items: ItemizedSplitItem[] = input.items.map((item) => ({
      description: item.description.trim(),
      money: { currency, minorAmount: toMinorUnits(item.amountText, currency) },
      participantIds: [...item.participantIds],
    }))
    if (items.some((item) => !item.description || item.participantIds.length === 0 || item.participantIds.some((id) => !participantIds.includes(id)))) throw new Error('Every receipt item needs a description and selected participants.')
    return { type: 'itemized', items }
  }
  const keyed = exactStringKeys(input.values, participantIds)
  if (input.type === 'percentage') return { type: input.type, participantIds, percentages: Object.fromEntries(keyed.map(([id, value]) => [id, parseFinite(value)])) }
  if (input.type === 'shares') return { type: input.type, participantIds, shares: Object.fromEntries(keyed.map(([id, value]) => [id, parseFinite(value)])) }
  const allocations = keyed.map(([participantId, value]) => ({ participantId, money: { currency, minorAmount: toMinorUnits(value, currency) } }))
  if (input.type === 'exact') return { type: input.type, allocations }
  return { type: input.type, participantIds, adjustments: Object.fromEntries(allocations.map(({ participantId, money }) => [participantId, money.minorAmount])) }
}

export function splitInputFromMethod(method: SplitMethod, currency: CurrencyCode): SplitInput {
  if (method.type === 'equal') return { type: method.type }
  if (method.type === 'exact') return { type: method.type, values: Object.fromEntries(method.allocations.map(({ participantId, money }) => [participantId, fromMinorUnits(money.minorAmount, money.currency)])) }
  if (method.type === 'percentage') return { type: method.type, values: Object.fromEntries(Object.entries(method.percentages).map(([id, value]) => [id, String(value)])) }
  if (method.type === 'shares') return { type: method.type, values: Object.fromEntries(Object.entries(method.shares).map(([id, value]) => [id, String(value)])) }
  if (method.type === 'adjustment') return { type: method.type, values: Object.fromEntries(Object.entries(method.adjustments).map(([id, value]) => [id, fromMinorUnits(value, currency)])) }
  return { type: method.type, items: method.items.map((item) => ({ description: item.description, amountText: fromMinorUnits(item.money.minorAmount, item.money.currency), participantIds: [...item.participantIds] })) }
}

export function computeSplitPreview(totalMinorAmount: number, currency: CurrencyCode, participantIds: readonly string[], input: SplitInput) {
  return computeAllocations({ currency, minorAmount: totalMinorAmount }, splitMethodFromInput(input, participantIds, currency))
}

function exactStringKeys(values: Readonly<Record<string, string>>, participantIds: readonly string[]): readonly (readonly [string, string])[] {
  const keys = Object.keys(values).sort()
  const selected = [...participantIds].sort()
  if (keys.length !== selected.length || keys.some((key, index) => key !== selected[index])) throw new Error('Every selected participant needs exactly one split value.')
  return participantIds.map((participantId) => [participantId, values[participantId]] as const)
}

function parseFinite(value: string): number {
  if (!/^(?:\d+)(?:\.\d+)?$/.test(value.trim())) throw new Error('Split values must be non-negative numbers.')
  const parsed = Number(value)
  if (!Number.isFinite(parsed) || parsed < 0) throw new Error('Split values must be non-negative numbers.')
  return parsed
}

function isIsoDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false
  const date = new Date(`${value}T00:00:00.000Z`)
  return !Number.isNaN(date.valueOf()) && date.toISOString().slice(0, 10) === value
}
function isIanaTimeZone(value: string): boolean { try { new Intl.DateTimeFormat('en-US', { timeZone: value }).format(new Date(0)); return true } catch { return false } }
function messageFor(reason: unknown, fallback: string): string { return reason instanceof Error ? reason.message : fallback }
function createOperationId(): string { return globalThis.crypto?.randomUUID?.() ?? `expense-${Date.now().toString(36)}` }
