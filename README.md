# Split Unwise

Split Unwise is an Ionic Vue expense-sharing app with Firebase Authentication and a rules-protected Firestore ledger. It supports shared groups and friendships, exact minor-unit splits, audited edits and moves, manual settlements, activity, notifications, and recurring expenses on Firebase's no-billing Spark tier.

## Moving expenses between contexts

Edit an ordinary expense and choose another group or friend to move it. The source edit and target creation commit atomically, with separate immutable source and target revisions and activity records. The destination revalidates active membership, payers, participants, currency, and exact minor-unit totals; retrying the same operation does not duplicate either side.

Recurring expenses must be stopped before moving, because a series belongs to one context. Existing remote receipts must also be removed first and can be reattached after the move. While a move is queued, the source hides it and the destination shows it as pending; a failed move restores the source without leaking a target copy.

## Recurring expenses on Spark

Use **Repeat** in Add Expense to create a weekly, fortnightly, monthly, or yearly series. The first expense and its recurring template are saved together. When an authorized member opens a group or its Recurring screen, the client catches up due items in calendar order:

- Each visit posts at most 24 due occurrences. The Recurring screen reports when more remain and provides a retry.
- Occurrence IDs depend only on the series and due date, so concurrent clients converge on one expense instead of duplicating it.
- Editing **this occurrence** leaves the series unchanged. Any active group member may edit **future expenses** from the current series frontier; creator and acting-member attribution remain distinct in the audit trail.
- Stopping a series prevents future occurrences without deleting its source or previously posted expenses.
- Firestore rechecks every payer and split participant before posting. If a participant is removed from the group, the series stops posting; existing expenses remain in history.

Spark does not run an unattended scheduler. A due expense is posted only after an authorized client opens the relevant screen. True background scheduling requires deploying the Cloud Functions scheduler on a billed Firebase project.

## Verification

```bash
pnpm test
pnpm test:firebase
pnpm typecheck
VITE_BUILD_COMMIT=$(git rev-parse HEAD) pnpm build
pnpm exec cap sync ios
pnpm ios:build
```

The disposable production proof is run separately with `pnpm test:hosted`; its fixture runner provisions verified temporary accounts and bounds cleanup to the exact groups it creates. See [release verification](docs/verification.md) and the [Firebase deployment record](docs/firebase-deployment.md).

## Mobile design evidence

The checked-in [Add Expense audit](.artifacts/design-audit/add-expense-2026-09-01/audit.md) includes 390 × 844 screenshots of the compact editor, Ionic card-modal recurrence editor, and recurring-series screen. These local demo screenshots prove visible layout and hierarchy only; they do not prove hosted Firebase behavior, swipe physics, keyboard movement, assistive-technology output, or physical-device interaction.
