# Split Unwise Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build and deploy a mobile-first Ionic Vue shared-expense application with full baseline and premium-equivalent product flows.

**Architecture:** A route-first Ionic Vue client uses isolated domain modules and repository interfaces, with deterministic demo and Firebase adapters. Four independent tab stacks provide native iOS navigation while durable workflows use routes and short decisions use sheets.

**Tech Stack:** Vue 3, TypeScript, Ionic Vue, Vue Router, Pinia, Firebase Auth/Firestore/Storage/Functions/Hosting, Vitest, Vue Test Utils, Playwright-compatible browser verification, Capacitor-ready ports.

**Spec:** `docs/superpowers/specs/2026-08-30-split-unwise-design.md`

## Global Constraints

- Primary visual viewport is 390 × 844 and the selected visual target is `exec-762153cd-21ae-4109-8839-b6e16212bfac.png`.
- App name is `Split Unwise`; public UI uses an original lilac/periwinkle identity and original assets.
- All money is represented as integer minor units with an ISO 4217 currency code.
- Ionic runs in `ios` mode and uses four independent tab stacks; Add Expense is an action, not a tab.
- Every write exposes `fresh`, `stale`, `pending`, `failed`, or `conflicted` state.
- `prefers-reduced-motion: reduce`, Dynamic Type, VoiceOver, 44-point targets, dark mode, and non-color semantics are mandatory.
- Firebase-backed behavior and demo behavior must use the same repository interfaces.
- Provider integrations are never reported as live unless real credentials and end-to-end confirmation prove them.

---

### Task 1: Project Foundation And Test Harness

**Files:**
- Create: `package.json`, `vite.config.ts`, `vitest.config.ts`, `tsconfig.json`, `index.html`
- Create: `src/main.ts`, `src/App.vue`, `src/app/router.ts`, `src/app/theme.css`
- Create: `src/tests/setup.ts`, `src/app/__tests__/router.spec.ts`

**Interfaces:**
- Produces: `createAppRouter(): Router` and a mountable `App.vue` with Ionic `ios` mode.

- [ ] Write a router test proving the four roots and group-detail route resolve.
- [ ] Run `pnpm vitest run src/app/__tests__/router.spec.ts` and confirm it fails before the router exists.
- [ ] Install the declared dependencies and implement the Ionic/Vite foundation.
- [ ] Run the focused test, `pnpm typecheck`, and `pnpm build`.
- [ ] Commit foundation files.

### Task 2: Domain Money, Splits, Balances, And Recurrence

**Files:**
- Create: `src/domain/model.ts`, `src/domain/money.ts`, `src/domain/splits.ts`
- Create: `src/domain/balances.ts`, `src/domain/recurrence.ts`, `src/domain/exports.ts`
- Test: `src/domain/__tests__/*.spec.ts`

**Interfaces:**
- Produces: `Money`, `Expense`, `Allocation`, `SplitMethod`, `computeAllocations`, `computeBalances`, `simplifyDebts`, `nextOccurrence`, `toCsv`, and `toJson`.

- [ ] Write failing tests for zero-decimal/three-decimal currencies and half-away-from-zero rounding.
- [ ] Write failing tests for equal, exact, percentage, shares, adjustment, and itemized splits, including remainder distribution.
- [ ] Write failing tests for pairwise balances, debt simplification, recurrence dates, CSV quoting, and JSON stability.
- [ ] Implement pure domain functions until the focused suites pass.
- [ ] Run all domain tests and commit the domain slice.

### Task 3: Repository Contracts, Demo Data, And Offline Commands

**Files:**
- Create: `src/data/repositories.ts`, `src/data/demoRepository.ts`, `src/data/firebaseRepository.ts`
- Create: `src/data/commandQueue.ts`, `src/data/firebase.ts`, `src/demo/lakeHouse.ts`
- Test: `src/data/__tests__/demoRepository.spec.ts`, `src/data/__tests__/commandQueue.spec.ts`

**Interfaces:**
- Produces: `AppRepository`, `GroupRepository`, `ExpenseRepository`, `ActivityRepository`, `createRepository()`, and `CommandQueue`.
- Consumes: domain types from Task 2.

- [ ] Test deterministic Lake House group, members, journal rows, balances, comments, and charts.
- [ ] Test idempotent command IDs and transitions through pending, failed, retry, and conflict.
- [ ] Implement demo repository and local command queue.
- [ ] Implement the Firebase adapter behind environment-variable detection without changing feature consumers.
- [ ] Run repository tests and commit the data slice.

### Task 4: Native Shell, Theme, Motion, And Shared Components

**Files:**
- Create: `src/features/shell/TabsShell.vue`, `src/components/AppFab.vue`, `src/components/MoneyAmount.vue`
- Create: `src/components/ExpenseRow.vue`, `src/components/MemberAvatar.vue`, `src/components/SyncStatus.vue`
- Create: `src/composables/useMotion.ts`, `src/composables/useHaptics.ts`, `src/composables/useNetwork.ts`
- Test: `src/components/__tests__/ExpenseRow.spec.ts`, `src/composables/__tests__/useMotion.spec.ts`

**Interfaces:**
- Produces: shared financial components and CSS variables `--su-motion-fast`, `--su-motion-route`, `--su-accent`, `--su-owed`, and `--su-owing`.

- [ ] Test stable amount alignment, textual debt direction, sync labels, and reduced-motion classes.
- [ ] Implement the four-tab iOS shell and theme tokens.
- [ ] Implement the restrained animation primitives from the spec.
- [ ] Run component tests, typecheck, and a production build.
- [ ] Commit the shell and visual system.

### Task 5: Home, Groups, And Selected Group Journal

**Files:**
- Create: `src/features/home/HomePage.vue`, `src/features/groups/GroupsPage.vue`
- Create: `src/features/groups/GroupDetailPage.vue`, `src/features/groups/groupStore.ts`
- Create: `src/features/groups/components/ActionRail.vue`, `GroupHero.vue`, `BalanceSummary.vue`
- Test: `src/features/groups/__tests__/GroupDetailPage.spec.ts`

**Interfaces:**
- Consumes: `GroupRepository`, `ExpenseRow`, and motion primitives.
- Produces: `/tabs/home`, `/tabs/groups`, and `/tabs/groups/:groupId` screens.

- [ ] Test the selected Lake House hierarchy, one August divider, action labels, accessible add action, and expense/activity switch.
- [ ] Implement home and group lists with real routing.
- [ ] Implement the selected group journal and scroll-collapse behavior.
- [ ] Run tests and capture the 390 × 844 screen for source comparison.
- [ ] Commit the core browsing journey.

### Task 6: Expense Composer And Every Split Method

**Files:**
- Create: `src/features/expenses/ExpenseEditorPage.vue`, `src/features/expenses/expenseStore.ts`
- Create: `src/features/expenses/components/SplitEditor.vue`, `PayerSheet.vue`, `ParticipantSheet.vue`
- Create: `src/features/expenses/components/ReceiptReview.vue`, `RecurrenceSheet.vue`
- Test: `src/features/expenses/__tests__/ExpenseEditorPage.spec.ts`, `SplitEditor.spec.ts`

**Interfaces:**
- Consumes: `computeAllocations`, `ExpenseRepository`, `CommandQueue`.
- Produces: valid `ExpenseDraft` objects and add/edit routes.

- [ ] Test required fields, allocation equality, currency rounding, dirty-sheet dismissal, and every split method.
- [ ] Implement the full-screen composer with payer, people, category, date, notes, attachment, and recurrence controls.
- [ ] Implement receipt upload and editable itemization with manual fallback.
- [ ] Save through the command queue and animate the pending row into the journal.
- [ ] Run tests and commit expense creation/editing.

### Task 7: Expense Detail, Comments, Activity, And Notifications

**Files:**
- Create: `src/features/expenses/ExpenseDetailPage.vue`
- Create: `src/features/activity/ActivityPage.vue`, `src/features/activity/activityStore.ts`
- Create: `src/features/comments/CommentThread.vue`, `src/features/notifications/NotificationCenter.vue`
- Test: `src/features/activity/__tests__/ActivityPage.spec.ts`

**Interfaces:**
- Consumes: immutable expense revisions and `ActivityRepository`.
- Produces: expense detail, comments, edit/delete audit events, and the Activity tab.

- [ ] Test chronological audit rendering, comments, edit attribution, deletion confirmation, and notification read state.
- [ ] Implement expense detail and comment composer.
- [ ] Implement activity filters and notification preferences.
- [ ] Run tests and commit the audit slice.

### Task 8: Balances, Simplification, And Settlement

**Files:**
- Create: `src/features/balances/BalancesPage.vue`, `src/features/balances/SettleUpPage.vue`
- Create: `src/features/balances/settlementStore.ts`, `src/features/balances/paymentProviders.ts`
- Test: `src/features/balances/__tests__/SettleUpPage.spec.ts`

**Interfaces:**
- Consumes: `computeBalances`, `simplifyDebts`, and repository settlement commands.
- Produces: pairwise and simplified balances plus recorded settlements.

- [ ] Test debtor/creditor direction, partial/full settlement, overpayment protection, and record-only provider semantics.
- [ ] Implement balances and simplified-plan views.
- [ ] Implement the settlement form and configurable provider links.
- [ ] Run tests and commit settlement behavior.

### Task 9: Premium Analytics, Search, Defaults, And Exports

**Files:**
- Create: `src/features/analytics/TotalsPage.vue`, `src/features/analytics/ChartsPage.vue`
- Create: `src/features/search/SearchPage.vue`, `src/features/groups/GroupSettingsPage.vue`
- Create: `src/features/exports/ExportPage.vue`
- Test: `src/features/analytics/__tests__/ChartsPage.spec.ts`, `src/features/search/__tests__/SearchPage.spec.ts`

**Interfaces:**
- Consumes: group expenses, settlements, `toCsv`, and `toJson`.
- Produces: totals, accessible charts, full-history search, default splits, and downloadable exports.

- [ ] Test totals semantics, chart accessible summaries, combined filters, saved defaults, and export content.
- [ ] Implement totals and charts without hiding data behind color.
- [ ] Implement search/filter and group default-split settings.
- [ ] Implement client CSV/JSON downloads and commit premium-equivalent tools.

### Task 10: Account, Authentication, Appearance, And Invitations

**Files:**
- Create: `src/features/auth/AuthPage.vue`, `src/features/auth/authStore.ts`
- Create: `src/features/account/AccountPage.vue`, `src/features/account/AppearancePage.vue`
- Create: `src/features/invitations/InviteSheet.vue`
- Test: `src/features/auth/__tests__/authStore.spec.ts`, `src/features/account/__tests__/AccountPage.spec.ts`

**Interfaces:**
- Consumes: Firebase Auth when configured and demo identity otherwise.
- Produces: sign-in, profile, dark/system appearance, currencies, data controls, and invitation links.

- [ ] Test demo/Firebase mode selection, appearance persistence, and invitation URL creation.
- [ ] Implement auth and account routes.
- [ ] Implement invitation sharing with web fallback.
- [ ] Run tests and commit account features.

### Task 11: Firebase Rules, Functions, Indexes, And Hosting

**Files:**
- Create: `firebase.json`, `.firebaserc`, `firestore.rules`, `firestore.indexes.json`, `storage.rules`
- Create: `functions/package.json`, `functions/tsconfig.json`, `functions/src/index.ts`
- Test: `functions/src/__tests__/ledger.spec.ts`, `src/data/__tests__/security.contract.spec.ts`

**Interfaces:**
- Consumes: the collection model and invariants from the spec.
- Produces: deployable Firebase resources and callable functions for recurrence, notifications, OCR adapter, and large exports.

- [ ] Test membership, participant, allocation, revision, and storage-path authorization with Firebase emulators.
- [ ] Implement Firestore and Storage rules plus required indexes.
- [ ] Implement idempotent callable/trigger functions with provider interfaces.
- [ ] Run emulator tests and Firebase config validation.
- [ ] Commit Firebase resources.

### Task 12: Visual QA, Accessibility, Capacitor Readiness, And Deployment

**Files:**
- Create: `capacitor.config.ts`, `public/manifest.webmanifest`, `public/icons/*`
- Create: `docs/verification.md`, `docs/firebase-deployment.md`
- Modify: visual and feature files identified by comparison.

**Interfaces:**
- Consumes: the completed app and Firebase project.
- Produces: verified build, production Hosting URL, and a record of live versus credential-gated capabilities.

- [ ] Run unit/component suites, typecheck, production build, and Firebase emulator suites.
- [ ] Start the app and verify 390 × 844, iPad, dark mode, reduced motion, keyboard, sheets, and offline states.
- [ ] Compare the selected source image and rendered group detail at the same viewport; fix visible mismatches and compare again.
- [ ] Create/select the dedicated Firebase project, configure web credentials without committing secrets, and deploy Hosting, Firestore, Storage, indexes, and Functions that the account permits.
- [ ] Load the production URL, refresh nested routes, exercise a Firebase-backed create/edit/settle flow, and record provider/billing blockers precisely.
- [ ] Commit verification documentation.

