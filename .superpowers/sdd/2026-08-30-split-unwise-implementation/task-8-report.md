# Task 8 Implementation Report

Date: 2026-08-31

Implementation baseline: `c061b43`

Scope: Versioned group balance snapshots, pairwise/simplified settlement semantics, immutable settlement audit records, strict offline command recovery, trusted payment-provider handoffs, and mobile Ionic balance/settlement routes.

## Outcome

Task 8 is implemented on the existing principal-owned repository/session/queue boundary. Demo mode now maintains one persisted balance revision across expense and settlement mutations, validates the exact selected debt plan at commit, records partial or full same-currency outside payments exactly once, and retains original payment truth plus a creator/manager-authorized void audit. Firebase reads decode only the server-maintained balance document and settlement records; Firebase financial writes remain explicitly typed unavailable until Task 11.

The Ionic UI now provides separate pairwise and simplified balance views, independent currency sections, one-currency-at-a-time settlement selection involving the current user, explicit outside-payment confirmation, trusted UID-configured PayPal/Venmo handoffs, visible pending/failed/conflict recovery, a durable payment detail route, and audited voiding. All three routed screens hide global chrome and include bounded mobile layouts, safe-area padding, 44-point controls, Dynamic Type wrapping, textual states, and reduced-motion fallbacks.

## Files

### Created

- `src/domain/__tests__/settlements.spec.ts`
- `src/data/__tests__/settlementRepository.spec.ts`
- `src/data/__tests__/task8Decoders.spec.ts`
- `src/data/__tests__/task8QueueSession.spec.ts`
- `src/features/balances/BalancesPage.vue`
- `src/features/balances/SettleUpPage.vue`
- `src/features/balances/SettlementDetailPage.vue`
- `src/features/balances/settlementStore.ts`
- `src/features/balances/paymentProviders.ts`
- `src/features/balances/__tests__/SettleUpPage.spec.ts`
- `src/features/balances/__tests__/settlementStore.spec.ts`
- `src/features/balances/__tests__/paymentProviders.spec.ts`

### Modified

- `src/domain/model.ts`
- `src/domain/balances.ts`
- `src/data/repositories.ts`
- `src/data/demoRepository.ts`
- `src/data/firebaseDecoders.ts`
- `src/data/firebaseRepository.ts`
- `src/data/commandQueue.ts`
- `src/data/session.ts`
- `src/app/router.ts`
- Task 8 and regression tests under `src/app/__tests__`, `src/data/__tests__`, and `src/features/groups/__tests__`

`public/assets/images/app-icon-1024.png` remains untouched and untracked.

## RED-first evidence

### Settlement domain and repository

Production break named: the baseline had no `GroupBalanceSnapshot`, settlement-aware pairwise/simplified recomputation, settlement repository, revision guard, immutable payment record, or audited void.

- Initial RED: 9/9 failed for missing contracts and implementations.
- GREEN: deterministic Lake House plans, simplified raw-cycle behavior, exact pairwise edge reduction, partial/full/no-reversal handling, overpayment, replay, revision/basis conflict, void restoration/permission, normalized fields, atomic Activity, exact-once expense revisions, and explicit EUR/USD isolation all pass.

### Queue, session, and Firebase boundaries

Production break named: schema v5 admitted no strict settlement envelope/result and session/Firebase had no settlement boundary.

- Initial RED: 9/9 failed across strict queue/session and decoder suites.
- GREEN: schema v6 quarantines v5 and amount-only financial shapes, validates complete result/resource/basis/revision/actor identity, isolates full principals, resumes complete intents, registers guarded session handlers, decodes authoritative Firebase reads, and returns typed unavailable Firebase writes.
- Additional RED: a saved settlement with a forged creator but unrelated Activity actor was accepted; GREEN after the queue required matching actor snapshots and timestamps for record and void audit results.

### Provider adapter and store

Production breaks named: no allowlisted provider handoff existed and no race-safe settlement store projected durable commands separately from authoritative balances.

- Provider RED: module import failed; GREEN 3/3 for allowlisted hosts, UID configuration, exact encoding, unsupported configuration/currency, and hostile token rejection.
- Store RED: module import failed; GREEN 4/4 for route-generation suppression, pending reload without optimistic debt reduction, authoritative post-save refresh, conflict retention, and disabled mutation without exact revisions.

### Routes and Ionic pages

Production breaks named: balance/settle routes were placeholders, durable settlement detail was absent, and no confirmation/recovery/void UI existed.

- Router RED: 2 durable-route assertions failed; GREEN after real balance/settle components and the settlement detail route were registered before the generic group route with `hideAppChrome`.
- Page RED: suite import failed for the three missing pages; GREEN for direction wording, current-user scoping, confirmation, duplicate-tap suppression, focus restoration, provider no-record behavior, Pending/Failed/Conflict/Voided text, durable navigation/refresh, missing versus inaccessible state, and retained original payment audit.
- Additional RED: a multi-currency settlement page rendered EUR and USD debts in one choice list; GREEN after a group-default-first currency selector limited the list to one currency at a time.

## Final GREEN verification

### Focused Task 8 matrix

Command:

`pnpm exec vitest run src/domain/__tests__/settlements.spec.ts src/data/__tests__/settlementRepository.spec.ts src/data/__tests__/task8Decoders.spec.ts src/data/__tests__/task8QueueSession.spec.ts src/data/__tests__/firebaseRepository.spec.ts src/features/balances/__tests__/paymentProviders.spec.ts src/features/balances/__tests__/settlementStore.spec.ts src/features/balances/__tests__/SettleUpPage.spec.ts src/app/__tests__/router.spec.ts`

Result: 9 files passed, 75 tests passed, including the final actor-identity regression.

### Full suite and static/build checks

- `pnpm test`: 43 files passed, 497 tests passed.
- `pnpm typecheck`: passed (`vue-tsc --noEmit`).
- `pnpm build`: passed; 328 modules transformed. Vite emitted only its existing large-chunk advisory.
- `git diff --check c061b43`: passed with no whitespace errors.

No browser or Playwright validation was run because the Task 8 assignment explicitly prohibited it.

## Self-review

- Verified saved non-void settlements enter unsimplified pairwise recomputation as inverse ledger obligations; simplified-basis payments may retain raw cycles while pairwise-basis payments reduce the exact directed edge.
- Verified every financial amount remains an integer minor-unit amount and every debt, command, snapshot, UI section, and provider limitation remains currency-specific with no conversion or combined total.
- Verified stale revision/basis requests and denied voids have zero settlement, Activity, plan, or revision effects; exact replay returns the original result without a second increment.
- Verified provider URLs use only allowlisted adapters and trusted UID-keyed recipient tokens. Opening, cancelling, or returning has no command/store/repository side effect.
- Verified pending intent remains separate from authoritative debt, failed operations retain Retry/Discard, conflicts remain visible, and success is acknowledged only after authoritative snapshot/settlement reads contain the saved result.
- Verified strict scalar route IDs, durable back paths, one page `h1`, labelled radio/segment/select semantics, explicit textual financial direction/status, focusable errors, safe areas, wrapping, 44-point targets, and reduced-motion CSS.

## Residual boundaries

- Task 11 must implement authenticated callable settlement record/void transactions plus the authoritative Firebase balance-state writer. Task 8 intentionally does not claim Firebase mutations succeed.
- Provider-confirmed payment state requires future signed server callback evidence. Task 8 handoffs never infer success from launch, cancellation, return, or deep links.
- Browser/device visual evidence remains assigned to Task 12; this task used component/source accessibility checks only, per the no-browser instruction.
