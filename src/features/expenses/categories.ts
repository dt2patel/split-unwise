/** The categories an expense can be filed under, in the order the editor offers them. */
export const EXPENSE_CATEGORIES = ['Food', 'Transport', 'Lodging', 'Supplies', 'Entertainment', 'Utilities', 'Other'] as const

export type ExpenseCategory = (typeof EXPENSE_CATEGORIES)[number]
