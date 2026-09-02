import { computed, reactive, ref } from 'vue'
import { defineStore } from 'pinia'
import { getAppSession } from '../../data/session'
import type { ExpenseDraft, ExpenseRow, Group, Member } from '../../data/repositories'
import type { LocalReceiptReference, ReceiptAsset, ReceiptDurability, ReceiptSuggestion } from '../../data/receipts'
import { assertCurrencyCode, fromMinorUnits, toMinorUnits, type CurrencyCode } from '../../domain/money'
import { currencyPickerOrder, loadCurrencyPreferences, SUPPORTED_CURRENCIES } from '../account/currencyPreferences'
import { computeAllocations } from '../../domain/splits'
import type { ItemizedSplitItem, Recurrence, SplitMethod } from '../../domain/model'
import { consumeTransactionImportDraft } from '../transactions/transactionImportDrafts'

export type ExpenseOrigin = 'account' | 'activity' | 'groups' | 'home'
export type ExpenseSheet = 'context' | 'participants' | 'payers' | 'receipt' | 'recurrence' | 'split'

export interface PaymentInput { readonly participantId: string; readonly amountText: string }
export interface ReceiptItemInput { readonly description: string; readonly amountText: string; readonly participantIds: readonly string[] }
export type SplitInput =
  | { readonly type: 'equal' }
  | { readonly type: 'exact' | 'percentage' | 'shares' | 'adjustment' | 'reimbursement'; readonly values: Readonly<Record<string, string>> }
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
  occurrenceEditScope?: 'future' | 'occurrence'
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
  if (input.occurrenceEditScope && input.occurrenceEditScope !== 'occurrence' && input.occurrenceEditScope !== 'future') errors.recurrence = 'Choose whether to edit this occurrence or future expenses.'
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
      ...(input.split.type === 'reimbursement' ? { reimbursement: true as const } : {}),
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
  const currencyOptions = ref<readonly CurrencyCode[]>(SUPPORTED_CURRENCIES)
  const members = ref<readonly Member[]>([])
  const availableGroups = ref<readonly Group[]>([])
  const contextName = ref('')
  const currentUser = ref<Member>()
  const mode = ref<'add' | 'edit'>('add')
  const origin = ref<ExpenseOrigin>('home')
  const expenseId = ref<string>()
  const sourceGroupId = ref<string>()
  const revision = ref<number>()
  const recurringTemplateId = ref<string>()
  const errors = ref<Readonly<Record<string, string>>>({})
  const errorSummary = ref('')
  const notice = ref('')
  const receiptMessage = ref('')
  const receiptPreview = ref<ReceiptAsset>()
  const receiptSuggestions = ref<readonly ReceiptSuggestion[]>([])
  const activeSheet = ref<ExpenseSheet>()
  const focusTarget = ref<string>()
  const lastOperationId = ref<string>()
  const saveState = ref<'idle' | 'pending' | 'saved' | 'failed' | 'conflicted'>('idle')
  const isLoading = ref(false)
  const hasInitialized = ref(false)
  const loadError = ref('')
  let initialFingerprint = JSON.stringify(editor)
  let initializationRequest = 0
  let contextSelectionRequest = 0
  let contextSelectionTarget: string | undefined
  let receiptAttachmentRequest = 0
  let receiptRecognitionRequest = 0

  const isDirty = computed(() => JSON.stringify(editor) !== initialFingerprint)
  const returnPath = computed(() => {
    if (mode.value === 'edit' && sourceGroupId.value && editor.groupId && sourceGroupId.value !== editor.groupId) {
      return origin.value === 'groups' ? `/tabs/groups/${encodeURIComponent(editor.groupId)}` : `/tabs/${origin.value}`
    }
    if (mode.value === 'edit' && expenseId.value && editor.groupId) {
      return `/tabs/${origin.value}/expenses/${encodeURIComponent(expenseId.value)}?groupId=${encodeURIComponent(editor.groupId)}`
    }
    return origin.value === 'groups' && editor.groupId ? `/tabs/groups/${encodeURIComponent(editor.groupId)}` : `/tabs/${origin.value}`
  })
  const canSubmit = computed(() => hasInitialized.value && !isLoading.value && !loadError.value && saveState.value !== 'pending')
  const receiptDurability = computed<ReceiptDurability | undefined>(() => receiptPreview.value?.durability)

  async function initialize(options: { readonly origin: ExpenseOrigin; readonly groupId?: string; readonly expenseId?: string; readonly importDraftId?: string; readonly today?: string }): Promise<void> {
    const request = ++initializationRequest
    invalidateEditorSubrequests()
    reset()
    origin.value = options.origin
    expenseId.value = options.expenseId
    mode.value = options.expenseId ? 'edit' : 'add'
    isLoading.value = true
    const nextEditor = emptyEditor()
    nextEditor.date = options.today ?? new Date().toISOString().slice(0, 10)
    try {
      const ready = (session as typeof session & { readonly ready?: Promise<void> }).ready
      if (ready) await ready
      const [loadedCurrentUser, groups, principal] = await Promise.all([
        session.repository.app.getCurrentUser(),
        session.repository.groups.list(),
        session.principal,
      ])
      const currencyPreferences = loadCurrencyPreferences(principal)
      currencyOptions.value = currencyPickerOrder(currencyPreferences)
      if (!options.groupId && !options.expenseId) nextEditor.currency = currencyPreferences.defaultCurrency
      let loadedMembers: readonly Member[] = [loadedCurrentUser]
      let loadedContextName = ''
      let loadedExpense: ExpenseRow | undefined
      if (options.groupId) {
        const [group, groupMembers, settings] = await Promise.all([
          session.repository.groups.getById(options.groupId),
          session.repository.groups.listMembers(options.groupId),
          session.repository.groups.getSettings(options.groupId),
        ])
        if (!group || group.id !== options.groupId) throw new Error('This group is not available.')
        if (!groupMembers.some(({ id }) => id === loadedCurrentUser.id)) throw new Error('You are not an active member of this group.')
        loadedMembers = groupMembers
        loadedContextName = group.name
        nextEditor.groupId = group.id
        nextEditor.currency = group.currency
        const defaultSplit = settings.defaultSplit
        if (!options.expenseId && defaultSplit && defaultSplit.participantIds.some((id) => !groupMembers.some((member) => member.id === id))) throw new Error('The shared default split references an inactive member and must be cleared.')
        nextEditor.participants = [...(!options.expenseId && defaultSplit ? defaultSplit.participantIds : groupMembers.map(({ id }) => id))]
        nextEditor.payments = [{ participantId: loadedCurrentUser.id, amountText: '' }]
        nextEditor.split = !options.expenseId && defaultSplit ? splitInputFromMethod(defaultSplit, group.currency) : { type: 'equal' }
      } else {
        nextEditor.participants = [loadedCurrentUser.id]
        nextEditor.payments = [{ participantId: loadedCurrentUser.id, amountText: '' }]
      }
      if (options.expenseId) {
        if (!options.groupId) throw new Error('Editing an expense requires a valid group context.')
        loadedExpense = await session.repository.expenses.getById(options.groupId, options.expenseId)
        if (!loadedExpense) throw new Error('This expense is not available.')
        if (loadedExpense.groupId !== options.groupId) throw new Error('The loaded expense did not match its group context.')
        Object.assign(nextEditor, editorInputFromExpense(loadedExpense))
      }
      const pristineFingerprint = JSON.stringify(nextEditor)
      const imported = !options.expenseId && options.importDraftId ? consumeTransactionImportDraft(principal, options.importDraftId) : undefined
      if (imported) {
        if (options.groupId && imported.money.currency !== nextEditor.currency) throw new Error('The imported transaction currency does not match this group. Open the import from Account and choose a compatible group.')
        nextEditor.description = imported.description
        nextEditor.date = imported.date
        nextEditor.currency = imported.money.currency
        nextEditor.amountText = fromMinorUnits(imported.money.minorAmount, imported.money.currency)
        nextEditor.category = 'Other'
      }
      const localReceipt = nextEditor.attachmentRefs.find((reference): reference is LocalReceiptReference => reference.startsWith('local-receipt:'))
      const loadedReceiptPreview = localReceipt ? await session.receipts.get(localReceipt) : undefined
      if (request !== initializationRequest) return
      Object.assign(editor, nextEditor)
      currentUser.value = loadedCurrentUser
      availableGroups.value = groups
      members.value = loadedMembers
      contextName.value = loadedContextName
      revision.value = loadedExpense?.revision
      sourceGroupId.value = loadedExpense?.groupId
      recurringTemplateId.value = loadedExpense?.recurringTemplateId
      receiptPreview.value = loadedReceiptPreview
      notice.value = imported ? 'Review the imported transaction, choose who shares it, then save when every detail is correct.' : ''
      initialFingerprint = imported ? pristineFingerprint : JSON.stringify(editor)
      hasInitialized.value = true
    } catch (reason) {
      if (request !== initializationRequest) return
      loadError.value = messageFor(reason, 'The expense editor could not be loaded.')
    } finally {
      if (request === initializationRequest) isLoading.value = false
    }
  }

  async function selectContext(groupId: string): Promise<boolean> {
    const editorRequest = initializationRequest
    const request = ++contextSelectionRequest
    contextSelectionTarget = groupId
    const group = availableGroups.value.find(({ id }) => id === groupId)
    if (!group) {
      errors.value = { ...errors.value, context: 'This group or friend is not available.' }
      return false
    }
    if (mode.value === 'edit' && recurringTemplateId.value && sourceGroupId.value && group.id !== sourceGroupId.value) {
      errors.value = { ...errors.value, context: 'Recurring expenses cannot move to another group or friend. Stop the series first.' }
      return false
    }
    if (mode.value === 'edit' && sourceGroupId.value && group.id !== sourceGroupId.value
      && editor.attachmentRefs.some((reference) => !reference.startsWith('local-receipt:'))) {
      errors.value = { ...errors.value, context: 'Remove existing receipts before moving this expense. You can reattach them in the new group or friend.' }
      return false
    }
    try {
      const [loadedMembers, settings, user] = await Promise.all([
        session.repository.groups.listMembers(group.id),
        session.repository.groups.getSettings(group.id),
        currentUser.value ? Promise.resolve(currentUser.value) : session.repository.app.getCurrentUser(),
      ])
      if (!isCurrentContextSelection(editorRequest, request, group.id)) return false
      if (!loadedMembers.some(({ id }) => id === user.id)) throw new Error('You are not an active member of this group.')
      const currencyChanged = editor.currency !== group.currency
      members.value = loadedMembers
      contextName.value = group.name
      editor.groupId = group.id
      editor.currency = group.currency
      const defaultSplit = settings.defaultSplit
      if (defaultSplit && defaultSplit.participantIds.some((id) => !loadedMembers.some((member) => member.id === id))) throw new Error('The shared default split references an inactive member and must be cleared.')
      editor.participants = [...(defaultSplit?.participantIds ?? loadedMembers.map(({ id }) => id))]
      editor.payments = [{ participantId: user.id, amountText: '' }]
      editor.split = defaultSplit ? splitInputFromMethod(defaultSplit, group.currency) : { type: 'equal' }
      if (currencyChanged) editor.amountText = ''
      const { context: _context, participants: _participants, payments: _payments, split: _split, ...remainingErrors } = errors.value
      errors.value = remainingErrors
      notice.value = currencyChanged
        ? 'The amount, payer amounts, and split values were reset for this context currency.'
        : 'Payers, participants, and split values were reset for the selected context.'
      return true
    } catch (reason) {
      if (!isCurrentContextSelection(editorRequest, request, group.id)) return false
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

  function changeDate(date: string): void {
    editor.date = date
    if (!editor.recurrence || !isIsoDate(date)) return
    const [, month, day] = date.split('-').map(Number)
    editor.recurrence = { ...editor.recurrence, anchor: { month, day } }
  }

  async function submit(requestedOperationId?: string): Promise<boolean> {
    if (mode.value === 'edit' && (!sourceGroupId.value || !expenseId.value || revision.value === undefined)) {
      errorSummary.value = 'This edit is missing its expense revision. Reload the expense before saving.'
      saveState.value = 'failed'
      return false
    }
    if (!canSubmit.value) return false
    if (mode.value === 'edit' && recurringTemplateId.value && !editor.occurrenceEditScope) {
      errors.value = { ...errors.value, recurrence: 'Choose whether to edit this occurrence or future expenses.' }
      errorSummary.value = 'Choose whether to edit this occurrence or future expenses.'
      saveState.value = 'failed'
      return false
    }
    const validation = validateExpenseInput(editor, members.value)
    errors.value = validation.errors
    if (!validation.valid || !validation.draft) {
      errorSummary.value = `Please fix ${Object.keys(validation.errors).length} highlighted field${Object.keys(validation.errors).length === 1 ? '' : 's'}.`
      saveState.value = 'failed'
      return false
    }
    errorSummary.value = ''
    const operationId = requestedOperationId ?? createOperationId()
    const editorContext = initializationRequest
    const submittedFingerprint = JSON.stringify(editor)
    const submittedReceiptReference = receiptPreview.value?.reference
    const refreshSubmittedReceipt = submittedReceiptReference && validation.draft.attachmentRefs.includes(submittedReceiptReference)
      ? submittedReceiptReference
      : undefined
    const moving = mode.value === 'edit' && sourceGroupId.value !== undefined && sourceGroupId.value !== validation.draft.groupId
    const command = mode.value === 'edit'
      ? { kind: 'expense.edit' as const, operationId, groupId: sourceGroupId.value!, expenseId: expenseId.value!, expectedRevision: revision.value!, draft: validation.draft }
      : { kind: 'expense.add' as const, operationId, ...validation.draft }
    lastOperationId.value = operationId
    saveState.value = 'pending'
    let handle
    try {
      const localReceipts = [...new Set(validation.draft.attachmentRefs.filter((reference): reference is LocalReceiptReference => reference.startsWith('local-receipt:')))]
      for (const reference of localReceipts) {
        const claimed = await session.receipts.claim(reference, operationId)
        if (!claimed) throw new Error('A local receipt is no longer available. Reattach the receipt before saving.')
      }
      if (editorContext !== initializationRequest || lastOperationId.value !== operationId) return false
      handle = session.queue.submit(command)
    } catch (reason) {
      if (editorContext === initializationRequest && lastOperationId.value === operationId) {
        saveState.value = 'failed'
        errorSummary.value = messageFor(reason, 'The expense could not be queued.')
      }
      return false
    }
    void handle.result().then(async (result) => {
      if (editorContext !== initializationRequest || lastOperationId.value !== operationId) return
      if (result.status !== 'saved') return
      saveState.value = 'saved'
      const savedExpense = 'expense' in result ? result.expense : undefined
      if (savedExpense) {
        expenseId.value = savedExpense.id
        sourceGroupId.value = savedExpense.groupId
        revision.value = savedExpense.revision
        initialFingerprint = submittedFingerprint
      }
      if (refreshSubmittedReceipt) await refreshReceiptPreview(refreshSubmittedReceipt, editorContext)
      if (editorContext !== initializationRequest || lastOperationId.value !== operationId) return
      notice.value = mode.value === 'edit' ? (moving ? `Expense moved to ${contextName.value}.` : 'Expense updated.') : 'Expense saved.'
    }).catch(async () => {
      if (editorContext !== initializationRequest || lastOperationId.value !== operationId) return
      if (refreshSubmittedReceipt) await refreshReceiptPreview(refreshSubmittedReceipt, editorContext)
      if (editorContext !== initializationRequest || lastOperationId.value !== operationId) return
      const operation = session.queue.get(operationId)
      saveState.value = operation?.status === 'conflicted' ? 'conflicted' : 'failed'
      errorSummary.value = operation?.status === 'conflicted' ? 'This expense changed elsewhere. Your draft and the remote revision are both preserved.' : 'Save failed. Retry or discard the draft from the group journal.'
    })
    return true
  }

  async function attachReceipt(blob: Blob, fileName: string): Promise<boolean> {
    const editorRequest = initializationRequest
    const attachmentRequest = ++receiptAttachmentRequest
    receiptRecognitionRequest += 1
    const reference = await session.receipts.put(blob, { fileName })
    if (!isCurrentReceiptAttachment(editorRequest, attachmentRequest)) {
      await rollbackStaleAttachment(reference)
      return false
    }
    editor.attachmentRefs = [...editor.attachmentRefs, reference]
    const preview = await session.receipts.get(reference)
    if (!isCurrentReceiptAttachment(editorRequest, attachmentRequest) || !editor.attachmentRefs.includes(reference) || !preview) {
      await rollbackStaleAttachment(reference)
      return false
    }
    receiptPreview.value = preview
    receiptSuggestions.value = []
    receiptMessage.value = ''
    const recognitionRequest = ++receiptRecognitionRequest
    try {
      const recognition = await session.receiptProvider.recognize(reference, editor.groupId)
      if (!isCurrentReceiptRecognition(editorRequest, recognitionRequest, reference)) {
        if (editorRequest !== initializationRequest) await discardStaleReceipt(reference)
        return false
      }
      if (recognition.status === 'suggestions') {
        receiptSuggestions.value = recognition.items
        receiptMessage.value = recognition.source === 'demo' ? 'Demo suggestions are ready to edit. Confirm them before applying a split.' : 'Suggestions are ready to edit. Confirm them before applying a split.'
      } else {
        receiptSuggestions.value = []
        receiptMessage.value = recognition.reason
      }
    } catch {
      if (!isCurrentReceiptRecognition(editorRequest, recognitionRequest, reference)) {
        if (editorRequest !== initializationRequest) await discardStaleReceipt(reference)
        return false
      }
      receiptSuggestions.value = []
      receiptMessage.value = 'Receipt recognition failed. The image is still saved here, and you can enter items manually.'
    }
    return true
  }

  async function discardStaleReceipt(reference: LocalReceiptReference): Promise<void> {
    try { await session.receipts.delete(reference) } catch { /* a stale editor cannot surface cleanup errors */ }
  }

  async function rollbackStaleAttachment(reference: LocalReceiptReference): Promise<void> {
    editor.attachmentRefs = editor.attachmentRefs.filter((item) => item !== reference)
    if (receiptPreview.value?.reference === reference) receiptPreview.value = undefined
    await discardStaleReceipt(reference)
  }

  async function removeReceipt(reference: string): Promise<void> {
    if (receiptPreview.value?.reference === reference) {
      receiptRecognitionRequest += 1
      receiptPreview.value = undefined
      receiptSuggestions.value = []
      receiptMessage.value = ''
    }
    editor.attachmentRefs = editor.attachmentRefs.filter((item) => item !== reference)
    if (reference.startsWith('local-receipt:')) {
      await session.receipts.delete(reference as LocalReceiptReference)
    }
    else await session.receiptProvider.delete(reference)
  }

  async function refreshReceiptPreview(reference: LocalReceiptReference, editorRequest: number): Promise<void> {
    try {
      const refreshed = await session.receipts.get(reference)
      if (editorRequest !== initializationRequest || receiptPreview.value?.reference !== reference || !editor.attachmentRefs.includes(reference) || !refreshed) return
      receiptPreview.value = refreshed
    } catch { /* durability refresh must not replace the authoritative save result */ }
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
  function leaveEditor(): void { initializationRequest += 1; invalidateEditorSubrequests(); activeSheet.value = undefined }

  function invalidateEditorSubrequests(): void {
    contextSelectionRequest += 1
    contextSelectionTarget = undefined
    receiptAttachmentRequest += 1
    receiptRecognitionRequest += 1
  }

  function isCurrentContextSelection(editorRequest: number, request: number, groupId: string): boolean {
    return editorRequest === initializationRequest && request === contextSelectionRequest && contextSelectionTarget === groupId
  }

  function isCurrentReceiptAttachment(editorRequest: number, request: number): boolean {
    return editorRequest === initializationRequest && request === receiptAttachmentRequest
  }

  function isCurrentReceiptRecognition(editorRequest: number, request: number, reference: LocalReceiptReference): boolean {
    return editorRequest === initializationRequest
      && request === receiptRecognitionRequest
      && receiptPreview.value?.reference === reference
      && editor.attachmentRefs.includes(reference)
  }

  return {
    editor, members, availableGroups, contextName, mode, origin, expenseId, sourceGroupId, revision, recurringTemplateId, errors, errorSummary, notice, receiptMessage, receiptSuggestions, receiptPreview, receiptDurability,
    activeSheet, focusTarget, lastOperationId, saveState, isLoading, hasInitialized, loadError, isDirty, returnPath, canSubmit,
    initialize, selectContext, changeCurrency, changeDate, submit, attachReceipt, removeReceipt, confirmReceipt, openSheet, closeSheet, leaveEditor, currencyOptions,
  }

  function reset(): void {
    Object.assign(editor, emptyEditor())
    members.value = []
    availableGroups.value = []
    contextName.value = ''
    currentUser.value = undefined
    expenseId.value = undefined
    sourceGroupId.value = undefined
    revision.value = undefined
    recurringTemplateId.value = undefined
    errors.value = {}
    errorSummary.value = ''
    notice.value = ''
    receiptMessage.value = ''
    receiptSuggestions.value = []
    receiptPreview.value = undefined
    activeSheet.value = undefined
    focusTarget.value = undefined
    lastOperationId.value = undefined
    saveState.value = 'idle'
    hasInitialized.value = false
    loadError.value = ''
  }

})

function editorInputFromExpense(expense: ExpenseRow): ExpenseEditorInput {
  return {
    groupId: expense.groupId,
    description: expense.description,
    date: expense.date,
    currency: expense.total.currency,
    amountText: fromMinorUnits(expense.total.minorAmount, expense.total.currency),
    category: expense.category,
    participants: expense.allocations.map(({ participantId }) => participantId),
    payments: expense.payments.map(({ participantId, money }) => ({ participantId, amountText: fromMinorUnits(money.minorAmount, money.currency) })),
    split: splitInputFromMethod(expense.splitMethod, expense.total.currency, expense.reimbursement === true),
    notes: expense.notes ?? '',
    attachmentRefs: [...expense.attachmentRefs],
    recurrence: expense.recurrence,
  }
}

function emptyEditor(): ExpenseEditorInput {
  return {
    groupId: '', description: '', date: '', currency: 'USD', amountText: '', category: '', participants: [], payments: [], split: { type: 'equal' }, notes: '', attachmentRefs: [],
    recurrence: undefined,
    occurrenceEditScope: undefined,
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
  if (input.type === 'exact' || input.type === 'reimbursement') return { type: 'exact', allocations }
  return { type: input.type, participantIds, adjustments: Object.fromEntries(allocations.map(({ participantId, money }) => [participantId, money.minorAmount])) }
}

export function splitInputFromMethod(method: SplitMethod, currency: CurrencyCode, reimbursement = false): SplitInput {
  if (method.type === 'equal') return { type: method.type }
  if (method.type === 'exact') return { type: reimbursement ? 'reimbursement' : method.type, values: Object.fromEntries(method.allocations.map(({ participantId, money }) => [participantId, fromMinorUnits(money.minorAmount, money.currency)])) }
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
