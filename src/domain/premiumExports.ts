import type { ActivityItem, ExpenseComment, ExpenseRevision, ExpenseRow, Group, Member, RecurringExpense, SettlementRecord } from '../data/repositories'
import type { GroupSettings } from './groupSettings'
import { protectCsvText, toCsv, toJson, type CsvRow } from './exports'

export interface DurableReceiptDescriptor {
  readonly assetId: string
  readonly fileName: string
  readonly mimeType: 'image/heic' | 'image/heif' | 'image/jpeg' | 'image/png' | 'image/webp'
  readonly byteSize: number
}

export interface ExportSource {
  readonly groups: readonly Group[]
  readonly membersByGroup: ReadonlyMap<string, readonly Member[]>
  readonly expenses: readonly ExpenseRow[]
  readonly settlements: readonly SettlementRecord[]
}

export interface AccountBackupSource extends ExportSource {
  readonly exportedAt: string
  readonly attachmentsByExpenseId?: ReadonlyMap<string, readonly DurableReceiptDescriptor[]>
  readonly activity?: readonly ActivityItem[]
  readonly comments?: readonly ExpenseComment[]
  readonly revisions?: readonly ExpenseRevision[]
  readonly recurring?: readonly RecurringExpense[]
  readonly settings?: readonly GroupSettings[]
}

export interface BuiltExport { readonly content: string; readonly rowCount: number }

export function buildTransactionCsv(source: ExportSource): BuiltExport {
  const memberIds = [...new Set([...source.membersByGroup.values()].flatMap((members) => members.map(({ id }) => id)))].sort(compare)
  const impactColumns = memberIds.map((id) => `${id}_impact_minor`)
  const rows: CsvRow[] = []
  for (const expense of confirmedExpenses(source.expenses)) {
    const impacts = Object.fromEntries(memberIds.map((id) => [`${id}_impact_minor`, expenseImpact(expense, id)]))
    rows.push({
      type: 'expense', id: safeText(expense.id), group_id: safeText(expense.groupId), date: expense.date,
      description: safeText(expense.description), category: safeText(expense.category), method: '', note: safeText(expense.notes ?? ''),
      currency: expense.total.currency, amount_minor: expense.total.minorAmount, ...impacts,
    })
  }
  for (const settlement of confirmedSettlements(source.settlements)) {
    const impacts = Object.fromEntries(memberIds.map((id) => [`${id}_impact_minor`, settlementImpact(settlement, id)]))
    rows.push({
      type: 'settlement', id: safeText(settlement.settlementId), group_id: safeText(settlement.groupId), date: settlement.occurredOn,
      description: 'Payment', category: '', method: safeText(settlement.method), note: safeText(settlement.note ?? ''),
      currency: settlement.money.currency, amount_minor: settlement.money.minorAmount, ...impacts,
    })
  }
  rows.sort((left, right) => compare(String(left.date), String(right.date)) || compare(String(left.id), String(right.id)) || compare(String(left.type), String(right.type)))
  const columns = ['type', 'id', 'group_id', 'date', 'description', 'category', 'method', 'note', 'currency', 'amount_minor', ...impactColumns]
  return { content: toCsv(rows, columns), rowCount: rows.length }
}

export function buildAccountBackup(source: AccountBackupSource): BuiltExport {
  if (!isIsoTimestamp(source.exportedAt)) throw new Error('Backup export timestamp must be an ISO instant')
  const groups = source.groups.filter(({ syncState }) => syncState === 'fresh').sort((left, right) => compare(left.id, right.id)).map((group) => ({
    id: group.id,
    name: group.name,
    currency: group.currency,
    memberIds: [...group.memberIds].sort(compare),
    members: [...(source.membersByGroup.get(group.id) ?? [])].sort((left, right) => compare(left.id, right.id)).map((member) => ({
      id: member.id, displayName: member.displayName, initials: member.initials, canManage: member.canManage === true,
    })),
  }))
  const groupIds = new Set(groups.map(({ id }) => id))
  const expenses = confirmedExpenses(source.expenses).filter(({ groupId }) => groupIds.has(groupId)).sort(transactionOrder).map((expense) => backupExpense(expense, source.attachmentsByExpenseId?.get(expense.id) ?? []))
  const settlements = confirmedSettlements(source.settlements).filter(({ groupId }) => groupIds.has(groupId)).sort(settlementOrder).map((settlement) => ({
    settlementId: settlement.settlementId,
    groupId: settlement.groupId,
    senderId: settlement.senderId,
    recipientId: settlement.recipientId,
    money: { ...settlement.money },
    basis: { ...settlement.basis },
    method: settlement.method,
    occurredOn: settlement.occurredOn,
    note: settlement.note ?? '',
    createdBy: { ...settlement.createdBy },
    createdAt: settlement.createdAt,
    revision: settlement.revision,
  }))
  const activity = (source.activity ?? []).filter((item) => groupIds.has(item.groupId) && item.syncState === 'fresh').sort((left, right) => compare(left.createdAt, right.createdAt) || compare(left.id, right.id)).map((item) => ({
    id: item.id, groupId: item.groupId, operationId: item.operationId, kind: item.kind, subject: { ...item.subject }, actor: { ...item.actor },
    ...(item.expenseId ? { expenseId: item.expenseId } : {}), ...(item.revision ? { revision: item.revision } : {}), ...(item.commentId ? { commentId: item.commentId } : {}), ...(item.settlementId ? { settlementId: item.settlementId } : {}), createdAt: item.createdAt,
  }))
  const comments = (source.comments ?? []).filter((item) => groupIds.has(item.groupId) && item.syncState === 'fresh').sort((left, right) => compare(left.createdAt, right.createdAt) || compare(left.commentId, right.commentId)).map((item) => ({
    commentId: item.commentId, groupId: item.groupId, expenseId: item.expenseId, operationId: item.operationId, author: { ...item.author }, body: item.body, createdAt: item.createdAt, ...(item.deletedAt ? { deletedAt: item.deletedAt } : {}),
  }))
  const revisions = (source.revisions ?? []).filter((item) => groupIds.has(item.groupId)).sort((left, right) => compare(left.groupId, right.groupId) || compare(left.expenseId, right.expenseId) || left.revision - right.revision || compare(left.id, right.id)).map((item) => ({
    id: item.id, groupId: item.groupId, expenseId: item.expenseId, revision: item.revision, operationId: item.operationId, action: item.action, actor: { ...item.actor }, createdAt: item.createdAt, expense: backupExpense(item.expense, []),
  }))
  const recurring = (source.recurring ?? []).filter((item) => groupIds.has(item.groupId) && item.syncState === 'fresh').sort((left, right) => compare(left.groupId, right.groupId) || compare(left.id, right.id)).map((item) => ({
    id: item.id, groupId: item.groupId, description: item.description, total: { ...item.total }, payments: item.payments.map(cloneAllocation), recurrence: { ...item.recurrence, anchor: { ...item.recurrence.anchor } }, nextDate: item.nextDate,
  }))
  const settings = (source.settings ?? []).filter((item) => groupIds.has(item.groupId)).sort((left, right) => compare(left.groupId, right.groupId)).map((item) => ({ schemaVersion: item.schemaVersion, groupId: item.groupId, revision: item.revision, ...(item.defaultSplit ? { defaultSplit: cloneSplit(item.defaultSplit) } : {}) }))
  return {
    content: toJson({ version: 1, exportedAt: source.exportedAt, groups, expenses, settlements, activity, comments, revisions, recurring, settings }),
    rowCount: expenses.length + settlements.length + activity.length + comments.length + revisions.length + recurring.length + settings.length,
  }
}

function backupExpense(expense: ExpenseRow, descriptors: readonly DurableReceiptDescriptor[]): Record<string, unknown> {
  return {
    id: expense.id, groupId: expense.groupId, description: expense.description, date: expense.date, total: { ...expense.total },
    payments: expense.payments.map(cloneAllocation), allocations: expense.allocations.map(cloneAllocation), category: expense.category, notes: expense.notes ?? '',
    splitMethod: cloneSplit(expense.splitMethod), ...(expense.recurrence ? { recurrence: { ...expense.recurrence, anchor: { ...expense.recurrence.anchor } } } : {}),
    ...(expense.occurrenceEditScope ? { occurrenceEditScope: expense.occurrenceEditScope } : {}), ...(expense.recurringTemplateId ? { recurringTemplateId: expense.recurringTemplateId } : {}),
    revision: expense.revision, createdAt: expense.createdAt, updatedAt: expense.updatedAt, ...(expense.deletedAt ? { deletedAt: expense.deletedAt } : {}),
    ...(expense.createdBy ? { createdBy: { ...expense.createdBy } } : {}), ...(expense.updatedBy ? { updatedBy: { ...expense.updatedBy } } : {}), attachments: validatedDescriptors(descriptors),
  }
}

function cloneSplit(value: ExpenseRow['splitMethod']): ExpenseRow['splitMethod'] { return JSON.parse(JSON.stringify(value)) as ExpenseRow['splitMethod'] }

function confirmedExpenses(expenses: readonly ExpenseRow[]): readonly ExpenseRow[] { return expenses.filter((expense) => expense.syncState === 'fresh' && expense.deletedAt === undefined) }
function confirmedSettlements(settlements: readonly SettlementRecord[]): readonly SettlementRecord[] { return settlements.filter((settlement) => settlement.syncState === 'fresh' && settlement.void === undefined) }
function expenseImpact(expense: ExpenseRow, participantId: string): number {
  const paid = expense.payments.filter((row) => row.participantId === participantId).reduce((sum, row) => checkedAdd(sum, row.money.minorAmount), 0)
  const share = expense.allocations.filter((row) => row.participantId === participantId).reduce((sum, row) => checkedAdd(sum, row.money.minorAmount), 0)
  return checkedAdd(paid, -share)
}
function settlementImpact(settlement: SettlementRecord, participantId: string): number {
  if (settlement.senderId === participantId) return settlement.money.minorAmount
  if (settlement.recipientId === participantId) return -settlement.money.minorAmount
  return 0
}
function checkedAdd(left: number, right: number): number {
  if (!Number.isSafeInteger(left) || !Number.isSafeInteger(right) || !Number.isSafeInteger(left + right)) throw new Error('Export money must remain within safe integer range')
  return left + right
}
function safeText(value: string): string { return protectCsvText(value.normalize('NFC')) }
function transactionOrder(left: ExpenseRow, right: ExpenseRow): number { return compare(left.date, right.date) || compare(left.id, right.id) }
function settlementOrder(left: SettlementRecord, right: SettlementRecord): number { return compare(left.occurredOn, right.occurredOn) || compare(left.settlementId, right.settlementId) }
function cloneAllocation(value: ExpenseRow['allocations'][number]): ExpenseRow['allocations'][number] { return { participantId: value.participantId, money: { ...value.money } } }
function validatedDescriptors(values: readonly DurableReceiptDescriptor[]): readonly DurableReceiptDescriptor[] {
  return values.filter(({ assetId }) => !assetId.startsWith('local-receipt:')).map((value) => {
    if (!/^asset-[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value.assetId)) throw new Error('Backup receipt asset ID is invalid')
    if (!value.fileName.trim() || value.fileName.length > 255 || /[\\/\u0000-\u001f\u007f]/.test(value.fileName)) throw new Error('Backup receipt file name is invalid')
    if (!['image/heic', 'image/heif', 'image/jpeg', 'image/png', 'image/webp'].includes(value.mimeType)) throw new Error('Backup receipt MIME type is invalid')
    if (!Number.isSafeInteger(value.byteSize) || value.byteSize <= 0 || value.byteSize > 15 * 1024 * 1024) throw new Error('Backup receipt byte size is invalid')
    return { ...value }
  }).sort((left, right) => compare(left.assetId, right.assetId))
}
function isIsoTimestamp(value: string): boolean { return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) && !Number.isNaN(Date.parse(value)) }
function compare(left: string, right: string): number { return left < right ? -1 : left > right ? 1 : 0 }
