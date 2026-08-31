import { describe, expect, it } from 'vitest'
import type { ActivityItem, ExpenseComment, ExpenseRevision, ExpenseRow, Group, Member, RecurringExpense, SettlementRecord } from '../../data/repositories'
import { buildAccountBackup, buildTransactionCsv } from '../premiumExports'

const group: Group = { id: 'lake', name: 'Lake House', currency: 'USD', memberIds: ['maya', 'alex'], syncState: 'fresh' }
const members: readonly Member[] = [
  { id: 'alex', displayName: 'Alex', initials: 'AR', isCurrentUser: false },
  { id: 'maya', displayName: 'Maya', initials: 'MP', isCurrentUser: true, canManage: true },
]

describe('typed premium exports', () => {
  it('rejects a normalized-looking export timestamp that is not a real calendar instant', () => {
    expect(() => buildAccountBackup({ exportedAt: '2026-02-30T12:00:00.000Z', groups: [], membersByGroup: new Map(), expenses: [], settlements: [] })).toThrow('timestamp')
  })

  it('emits deterministic expense and settlement rows with currency and signed member impacts', () => {
    const csv = buildTransactionCsv({ groups: [group], membersByGroup: new Map([[group.id, members]]), expenses: [expense()], settlements: [settlement()] })
    expect(csv.rowCount).toBe(2)
    expect(csv.content.split('\n')).toEqual([
      'type,id,group_id,date,description,category,method,note,currency,amount_minor,alex_impact_minor,maya_impact_minor',
      'expense,expense-a,lake,2026-08-01,Groceries,Food,,,USD,1000,-600,600',
      'settlement,settlement-a,lake,2026-08-02,Payment,,cash,Thanks,USD,200,200,-200',
      '',
    ])
  })

  it('protects every user-controlled CSV text cell from formula injection', () => {
    const malicious = { ...expense(), description: ' =SUM(A1:A2)', notes: '\t@payload', category: '-cmd' }
    const content = buildTransactionCsv({ groups: [group], membersByGroup: new Map([[group.id, members]]), expenses: [malicious], settlements: [] }).content
    expect(content).toContain("' =SUM(A1:A2)")
    expect(content).toContain("'-cmd")
    expect(content).toContain("'\t@payload")
  })

  it('limits CSV rows and member columns to the fresh authorized group set', () => {
    const rogue = { ...expense(), id: 'rogue-expense', groupId: 'rogue', description: 'Do not export' }
    const content = buildTransactionCsv({
      groups: [group],
      membersByGroup: new Map([
        [group.id, members],
        ['rogue', [{ id: 'outsider', displayName: 'Outsider', initials: 'OS', isCurrentUser: false }]],
      ]),
      expenses: [expense(), rogue],
      settlements: [{ ...settlement(), settlementId: 'rogue-settlement', groupId: 'rogue' }],
    }).content

    expect(content).not.toContain('rogue')
    expect(content).not.toContain('outsider_impact_minor')
    expect(content).not.toContain('Do not export')
  })

  it('builds a versioned allowlisted JSON backup and includes only validated durable receipt descriptors', () => {
    const backup = buildAccountBackup({
      exportedAt: '2026-08-31T20:00:00.000Z', groups: [group], membersByGroup: new Map([[group.id, members]]), expenses: [expense()], settlements: [settlement()],
      attachmentsByExpenseId: new Map([['expense-a', [
        { assetId: 'asset-receipt-a', fileName: 'receipt.jpg', mimeType: 'image/jpeg', byteSize: 1234 },
        { assetId: 'local-receipt:secret', fileName: 'local.jpg', mimeType: 'image/jpeg', byteSize: 50 },
      ]]]),
    })
    expect(backup.rowCount).toBe(2)
    const parsed = JSON.parse(backup.content) as Record<string, unknown>
    expect(parsed).toMatchObject({ version: 1, exportedAt: '2026-08-31T20:00:00.000Z' })
    expect(backup.content).toContain('asset-receipt-a')
    expect(backup.content).not.toContain('local-receipt:')
    expect(backup.content).not.toContain('attachmentRefs')
    expect(backup.content).not.toContain('operationId')
  })

  it('includes allowlisted audit history, comments, recurrence, and versioned settings', () => {
    const row = expense()
    const activity: ActivityItem = {
      id: 'activity-a', groupId: group.id, operationId: 'operation-a', kind: 'expense.created',
      subject: { kind: 'expense', id: row.id, label: row.description }, actor: { id: 'maya', displayName: 'Maya' },
      expenseId: row.id, revision: 1, createdAt: row.createdAt, syncState: 'fresh',
    }
    const comment: ExpenseComment = {
      commentId: 'comment-a', groupId: group.id, expenseId: row.id, operationId: 'operation-comment',
      author: { id: 'alex', displayName: 'Alex' }, body: 'I checked this.', attachmentRefs: ['local-receipt:private'],
      createdAt: '2026-08-01T13:00:00.000Z', syncState: 'fresh',
    }
    const revision: ExpenseRevision = {
      id: 'revision-a', groupId: group.id, expenseId: row.id, revision: 1, operationId: 'operation-a', action: 'created',
      actor: { id: 'maya', displayName: 'Maya' }, createdAt: row.createdAt, expense: row,
    }
    const recurring: RecurringExpense = {
      id: 'recurring-a', groupId: group.id, description: 'Rent', total: { currency: 'USD', minorAmount: 120000 },
      payments: [{ participantId: 'maya', money: { currency: 'USD', minorAmount: 120000 } }],
      recurrence: { frequency: 'monthly', anchor: { month: 8, day: 1 }, timeZone: 'America/Chicago' },
      nextDate: '2026-09-01', syncState: 'fresh',
    }
    const backup = buildAccountBackup({
      exportedAt: '2026-08-31T20:00:00.000Z', groups: [group], membersByGroup: new Map([[group.id, members]]), expenses: [row], settlements: [],
      activity: [activity], comments: [comment], revisions: [revision], recurring: [recurring],
      settings: [{ schemaVersion: 1, groupId: group.id, revision: 2, defaultSplit: { type: 'equal', participantIds: ['maya', 'alex'] } }],
    })

    expect(backup.rowCount).toBe(6)
    expect(JSON.parse(backup.content)).toMatchObject({
      activity: [{ id: 'activity-a', operationId: 'operation-a' }],
      comments: [{ commentId: 'comment-a', operationId: 'operation-comment', body: 'I checked this.' }],
      revisions: [{ id: 'revision-a', operationId: 'operation-a', expense: { id: 'expense-a' } }],
      recurring: [{ id: 'recurring-a', description: 'Rent' }],
      settings: [{ schemaVersion: 1, groupId: 'lake', revision: 2 }],
    })
    expect(backup.content).not.toContain('local-receipt:private')
    expect(backup.content).not.toContain('attachmentRefs')
  })

  it('rejects a revision whose embedded snapshot crosses the authorized group or expense identity', () => {
    const row = expense()
    const revision: ExpenseRevision = {
      id: 'revision-crossed', groupId: group.id, expenseId: row.id, revision: 1, operationId: 'operation-a', action: 'created',
      actor: { id: 'maya', displayName: 'Maya' }, createdAt: row.createdAt, expense: { ...row, groupId: 'rogue' },
    }

    expect(() => buildAccountBackup({
      exportedAt: '2026-08-31T20:00:00.000Z', groups: [group], membersByGroup: new Map([[group.id, members]]), expenses: [row], settlements: [], revisions: [revision],
    })).toThrow('revision identity')
  })
})

function expense(): ExpenseRow {
  return {
    id: 'expense-a', groupId: 'lake', description: 'Groceries', date: '2026-08-01', total: { currency: 'USD', minorAmount: 1000 },
    payments: [{ participantId: 'maya', money: { currency: 'USD', minorAmount: 1000 } }],
    allocations: [{ participantId: 'maya', money: { currency: 'USD', minorAmount: 400 } }, { participantId: 'alex', money: { currency: 'USD', minorAmount: 600 } }],
    category: 'Food', notes: '', splitMethod: { type: 'equal', participantIds: ['maya', 'alex'] }, attachmentRefs: ['local-receipt:never-export'],
    createdAt: '2026-08-01T12:00:00.000Z', updatedAt: '2026-08-01T12:00:00.000Z', revision: 1, syncState: 'fresh',
  }
}
function settlement(): SettlementRecord {
  return {
    settlementId: 'settlement-a', groupId: 'lake', operationId: 'operation-secret', senderId: 'alex', recipientId: 'maya', money: { currency: 'USD', minorAmount: 200 },
    basis: { kind: 'simplified', senderId: 'alex', recipientId: 'maya', currency: 'USD', debtMinor: 200 }, method: 'cash', occurredOn: '2026-08-02', note: 'Thanks',
    createdBy: { id: 'maya', displayName: 'Maya' }, createdAt: '2026-08-02T12:00:00.000Z', revision: 1, syncState: 'fresh',
  }
}
