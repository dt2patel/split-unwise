# Spark Recurring Expenses Completion Plan

> **Execution note:** Follow the repository's test-driven and subagent-driven workflow. Do not claim automatic background scheduling on the Firebase Spark plan; the client performs deterministic catch-up whenever an authorized member opens the recurring screen or a group detail screen.

**Goal:** Make recurring expenses fully usable in the deployed Firebase Spark application: create a series from the existing expense editor, deterministically post every due occurrence once, edit one occurrence or the future series, cancel future occurrences without deleting history, and manage series from a native-mobile group screen.

**Architecture:** Keep Cloud Functions as the preferred server-side scheduler when billing is enabled, but add a security-rule-protected Spark path. The initial expense and recurring template are created in one Firestore transaction. Each due occurrence owns an ID derived only from the template ID and occurrence date, so concurrent clients cannot create duplicates. A successful materialization transaction creates the occurrence and advances the template together. The UI catches up at most 24 occurrences per visit and exposes a manual retry.

**Technology:** Ionic Vue 3, TypeScript, Pinia, Firebase Web SDK/Firestore transactions, Firestore Security Rules emulator, Vitest, Playwright.

---

## Task 1: Define the recurring-series contract

**Files:**

- Modify: `src/data/repositories.ts`
- Modify: `src/data/firebaseDecoders.ts`
- Modify: `src/data/__tests__/firebaseDecoders.spec.ts`
- Modify: `src/domain/recurrence.ts`
- Modify: `src/domain/__tests__/recurrence.spec.ts`

**Steps:**

1. Add failing tests for active/cancelled template decoding, creator/revision metadata, and stable occurrence identity.
2. Extend `RecurringExpense` with `status`, `allocations`, `category`, `splitMethod`, `anchorDate`, `revision`, `createdBy`, and optional last-occurrence metadata needed by management UI and safe mutations.
3. Add a pure `recurringOccurrenceId(templateId, occurrenceDate)` helper. It must accept only strict IDs and ISO dates and return the same bounded ID for every user/device.
4. Add repository commands and results for `recurrence.materialize` and `recurrence.cancel`; include a stable operation ID and expected template revision on cancellation.
5. Run the focused domain and decoder tests.

## Task 2: Enable recurrence creation and edits on Firebase Spark

**Files:**

- Modify: `src/data/firebaseSparkMutations.ts`
- Modify: `src/data/firebaseRepository.ts`
- Modify: `src/data/commandQueue.ts`
- Modify: `src/data/session.ts`
- Modify: `src/data/demoRepository.ts`
- Modify: `src/data/__tests__/firebaseSparkMutations.spec.ts`
- Modify: `src/data/__tests__/firebaseSparkFlow.emulator.spec.ts`
- Modify: `src/data/__tests__/demoRepository.spec.ts`

**Steps:**

1. Replace the existing unit test that expects Spark recurrence rejection with failing tests for deterministic template creation and template linkage on the expense.
2. In the Spark add transaction, create the initial expense and an `active` recurring template together. The template ID and `recurringTemplateId` must be derived from the existing operation identity, and replays must return the same records.
3. Add failing emulator tests proving two authorized clients racing to materialize the same due date create one expense, one ledger effect, and one template advancement.
4. Implement `recurrence.materialize` as a Firestore transaction. Validate that the requested date equals the template's current `nextDate`, create the deterministic occurrence with the caller as actor, and atomically advance `nextDate`/revision. Treat an already-created occurrence as a replay and never create a second expense.
5. Add `materializeDue(groupId, throughDate, maxOccurrences = 24)` in the group repository to run consecutive occurrence commands until the next date is in the future or the cap is reached.
6. Implement `recurrence.cancel` as an active-to-cancelled template update with optimistic revision checking. Past expenses remain untouched.
7. For an expense edit with `occurrenceEditScope: 'future'`, update the linked active template's description, money, allocations, category, split method, recurrence, and next date in the same transaction. An `occurrence` edit changes only that expense.
8. Mirror the behavior in the demo repository and command queue parsing, then run focused unit/emulator tests.

## Task 3: Secure recurring writes in Firestore Rules

**Files:**

- Modify: `firestore.rules`
- Modify: `src/data/__tests__/firebaseSparkFlow.emulator.spec.ts`
- Modify: `src/data/__tests__/security.contract.spec.ts`

**Steps:**

1. Write emulator tests that deny non-members, malformed recurrence values, client-chosen duplicate identities, skipped dates, backwards `nextDate`, creator impersonation, broad template updates, cancellation with the wrong revision, and recurrence edits that do not match the linked expense.
2. Add allowlisted validators for template create, deterministic materialization update, future-series update, and cancellation. Require active membership and cross-check the corresponding expense with `getAfter`.
3. Ensure direct template deletion remains denied and inactive templates cannot materialize.
4. Run rules, Spark-flow, and security-contract tests.

## Task 4: Build the native-mobile recurring management screen

**Files:**

- Create: `src/features/groups/RecurringExpensesPage.vue`
- Create: `src/features/groups/__tests__/RecurringExpensesPage.spec.ts`
- Modify: `src/features/groups/GroupDetailPage.vue`
- Modify: `src/features/groups/components/ActionRail.vue`
- Modify: `src/features/groups/__tests__/GroupDetailPage.spec.ts`
- Modify: `src/app/router.ts`
- Modify: `src/app/__tests__/router.spec.ts`

**Steps:**

1. Write a component test for a 390px-friendly list with amount, frequency, next date, active/cancelled state, loading skeleton, empty state, retry, and cancel confirmation.
2. Build an Ionic page with a compact iOS-style header and cards. On entry, catch up due active templates through the current local ISO date, refresh the list, and show a truthful status message when the 24-occurrence cap is reached.
3. Link each active template to its latest expense/edit flow where available. Cancellation must use an Ionic alert and preserve past expenses.
4. Add `/tabs/groups/:groupId/recurring`, expose `Recurring` in `ActionRail`, and trigger background catch-up from group detail without delaying its first usable render.
5. Respect reduced motion, keep 44px tap targets, and verify no horizontal overflow at 390x844.
6. Run component and router tests.

## Task 5: Verify, document, deploy, and publish

**Files:**

- Modify: `README.md`
- Modify: `docs/verification.md`
- Modify: `docs/deployment.md`

**Steps:**

1. Document the Spark catch-up model honestly: due items post when an authorized member opens the group/recurring screen; true unattended schedules require the Functions deployment on a billed Firebase project.
2. Run `pnpm test`, `pnpm test:firebase`, `pnpm build`, `pnpm exec cap sync ios`, and the iOS build command recorded in `docs/verification.md`.
3. Deploy Firestore rules and Hosting to `split-unwise-aditya`.
4. Test the hosted app at 390x844 with two real disposable Firebase users: create a past-due series, prove one occurrence after concurrent catch-up, edit one occurrence, edit future occurrences, cancel the series, and confirm historical expenses remain.
5. Re-run the hosted login/friendship/group creation proof and inspect browser console/network errors.
6. Commit, push the exact branch SHA to `origin/codex/split-unwise-build`, verify `git ls-remote`, and confirm hosted build metadata matches that SHA.
