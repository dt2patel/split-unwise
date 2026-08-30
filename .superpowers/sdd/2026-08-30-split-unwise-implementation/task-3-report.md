# Task 3: Repository Contracts, Demo Data, And Offline Commands

## Implementation

Implemented the data slice under `src/data` and deterministic demo seed under `src/demo`.

- `repositories.ts` defines the Firebase-free `AppRepository`, `GroupRepository`, `ExpenseRepository`, and `ActivityRepository` contracts. It also exposes `createRepository()`.
- `lakeHouse.ts` seeds the selected Lake House Weekend group, Maya P. as the current user, the four target members, the five August 26–30, 2026 journal entries shown in the visual target, comments, activity, a monthly Cabin deposit template, and fresh sync state.
- `demoRepository.ts` creates a new in-memory data store per call. It reads groups, members, journal rows, balances, comments, totals, chart series, recurring templates, and activity; `expenses.add()` writes to that in-memory journal and appends an activity event.
- `commandQueue.ts` creates stable client operation records. Duplicate IDs return their original pending/result/error rather than rerunning the side effect. Failed operations alone can retry; `CommandConflictError` produces a conflicted record. Subscribers see deterministic pending, failed, fresh, stale, and conflicted transitions without timers.
- `firebase.ts` treats configuration as complete only when all six `VITE_FIREBASE_*` web settings are present. `firebaseRepository.ts` dynamically loads modular Firebase Auth/Firestore only on the first repository method call; construction and module import neither initialize Firebase nor open a network connection.
- Added `firebase@12.18.0` as the modular Web SDK dependency. No Firebase project configuration or credentials were added.

## RED / GREEN Evidence

1. Repository and seed behavior
   - RED: `pnpm exec vitest run src/data/__tests__/demoRepository.spec.ts src/data/__tests__/commandQueue.spec.ts` failed in both suites before implementation. Vitest reported failed imports for `../demoRepository` and `../commandQueue` (0 tests executed), proving the missing contracts rather than a test typo.
   - GREEN: after the contracts, Lake House seed, in-memory implementation, and queue were added, the same focused command passed: 2 files, 5 tests.
2. Queue transition regression during refactoring
   - RED: the focused command then caught a duplicate `pending` notification on retry (`['pending', 'failed', 'pending', 'pending', 'fresh']`, expected one pending transition per attempt).
   - GREEN: after publishing the retry transition only when its executable promise is installed, the focused command passed: 2 files, 5 tests.

## Validation

- `pnpm exec vitest run src/data/__tests__/demoRepository.spec.ts src/data/__tests__/commandQueue.spec.ts` — passed: 2 files, 5 tests.
- `pnpm test` — passed: 9 files, 38 tests. Installed Ionic packages emitted existing missing-source-map notices; no test failed.
- `pnpm run typecheck` — passed.
- `pnpm run build` — passed. Vite reported the existing chunk-size warning for the 1.14 MB JavaScript chunk.
- `git diff --check` — passed.

## Files Changed

- Added `src/data/repositories.ts`
- Added `src/data/demoRepository.ts`
- Added `src/data/firebaseRepository.ts`
- Added `src/data/commandQueue.ts`
- Added `src/data/firebase.ts`
- Added `src/demo/lakeHouse.ts`
- Added `src/data/__tests__/demoRepository.spec.ts`
- Added `src/data/__tests__/commandQueue.spec.ts`
- Modified `package.json` and `pnpm-lock.yaml` for Firebase
- Added this report

The pre-existing untracked `public/assets/images/*` files were neither changed nor committed.

## Self-Review And Concerns

- The demo rows use Task 2's immutable expense and money shapes. Balances are derived through `computeBalances()` and `simplifyDebts()` rather than duplicated as display-only data.
- The command queue never retries automatically: users or a feature store must explicitly invoke `retry()`, and a fresh/conflicted record cannot be retried. This prevents same-ID duplicate writes while keeping all state changes observable.
- Firebase behavior is contract-complete and lazy, but this task does not include a configured Firebase project, authenticated user, or emulator. Live Firestore security/transaction/idempotency behavior remains for the Firebase rules/functions and emulator work in later tasks.
- Firebase uses the user projection collection for cross-group lookup, matching the documented collection-model direction. A deployed backend must maintain that projection.

---

## Fix Round 1 / 5: Durable Commands, Strict Firebase Boundaries, And Currency Partitions

### Review-Finding Mapping

1. **Listener isolation (Critical):** command state is persisted before delivery, and each subscriber is invoked in an isolated `try/catch`. A rendering listener can no longer turn a successful command into a failed/retryable operation or prevent another listener from observing it.
2. **Durable operation IDs (Critical):** all mutable repository operations now carry `operationId` in a discriminated command envelope. `CommandQueue` persists serializable envelope/state records through injectable storage, rehydrates them, and resumes registered handlers. Firebase add-expense uses a user-scoped operation ledger and deterministic expense document ID in a Firestore transaction; repeated IDs return the ledgered result rather than creating another expense. Demo has an equivalent in-memory operation ledger.
3. **Pure contracts:** `repositories.ts` now imports only domain types and exposes no adapter/composition values. `repositoryFactory.ts` owns environment/adaptor selection; `src/data/index.ts` is the feature-facing data import path.
4. **Typed queue states:** optional fields and caller-selected queue generics were replaced with a discriminated `CommandOperation` union, concrete command envelopes, command result unions, and untyped-by-caller `CommandHandle`s.
5. **Firebase decoding:** `firebaseDecoders.ts` strictly validates group projections, groups, members, expenses, allocations, ISO currencies, safe integer amounts, recurrence shape/calendar anchors, comments, and activity event enums. Malformed data throws `DocumentDecodeError`; unknown activity types are never recast as expense activity.
6. **Auth readiness:** Firebase waits for `auth.authStateReady()` before an unauthenticated decision.
7. **Currency partitions:** totals now return a currency-keyed collection and every category/daily chart datum carries its currency. Demo and Firebase aggregation never add amounts across currencies.
8. **Feature extension boundary:** repositories now expose command-oriented interfaces for expense add/edit/delete, comment add, confirmed manual settlement record, group default split, and profile update. Demo executes them deterministically; Firebase records typed `not-supported` results in the operation ledger for mutations not yet implemented, without fabricating provider confirmation.

Firebase configuration now trims values, rejects whitespace-only variables, and selects demo unless all six public values are valid. Firebase construction remains lazy: no SDK dynamic import, initialization, auth lookup, or network read occurs until a repository method is called.

### Regression RED / GREEN Evidence

- **RED:** `pnpm exec vitest run src/data/__tests__/commandQueue.spec.ts src/data/__tests__/demoRepository.spec.ts src/data/__tests__/firebaseDecoders.spec.ts` failed before this round's implementation: `firebaseDecoders` could not resolve, `createMemoryCommandStorage` was absent, previous queue APIs could not provide durable handlers, and the existing demo totals/chart assertions showed cross-currency aggregation. Result: 3 failed files, 8 failed tests plus the missing decoder suite.
- **GREEN:** after the durable command queue, decoders, repository factory, strict Firebase adapter, and partitioned aggregators were implemented, the same focused command passed: 3 files, 12 tests.

### Fix-Round Validation

- `pnpm exec vitest run src/data/__tests__/commandQueue.spec.ts src/data/__tests__/demoRepository.spec.ts src/data/__tests__/firebaseDecoders.spec.ts` — passed: 3 files, 12 tests.
- `pnpm test` — passed: 10 files, 45 tests. Installed Ionic packages emitted existing missing-source-map notices; no test failed.
- `pnpm run typecheck` — passed.
- `pnpm run build` — passed. Vite emitted the existing 1.14 MB chunk-size warning.
- `git diff --check` — passed.

### Fix-Round Files Changed

- Modified `src/data/repositories.ts`, `commandQueue.ts`, `demoRepository.ts`, `firebase.ts`, and `firebaseRepository.ts`
- Added `src/data/repositoryFactory.ts`, `index.ts`, and `firebaseDecoders.ts`
- Modified the existing demo/queue tests and added `src/data/__tests__/firebaseDecoders.spec.ts`
- Appended this report

### Fix-Round Concerns

- The Firestore operation ledger and transaction shape are source-validated, but no Firebase project, authenticated session, or emulator is available in this task; live rules/transaction behavior remains unverified.
- Local browser storage intentionally contains only serializable command metadata and drafts; it contains no credentials. Storage privacy/quota failures leave the in-memory command state usable but cannot provide reload recovery.
- The public cover assets remain pre-existing untracked files and were not changed or staged.

---

## Fix Round 2 / 5: Hydrated Auth, Bound Replay Identity, And Checked Aggregates

### Review-Finding Mapping

1. **Auth hydration:** `firebaseSession.ts` is the sole auth-decision boundary. Every Firebase repository read now first obtains its client/session context through it; `auth.authStateReady()` completes before a user-sensitive Firestore query, profile read, operation ledger read, or unauthenticated decision. Totals share one hydrated context with their expense read rather than racing `listExpenses()` against user lookup.
2. **Replay/resource binding:** `operationIdentity.ts` validates bounded URL-safe operation IDs, canonicalizes the full request excluding only the operation ID, SHA-256 fingerprints it, and derives an expense resource ID from authenticated user ID plus operation ID. Firebase stores uid, kind, group context, fingerprint, and resource ID in the operation ledger, validates all on replay, and rejects mismatches with `OperationReplayConflictError`. Demo applies the same identity check before its ledger returns a prior result.
3. **Checked aggregates:** `aggregates.ts` is shared by demo and Firebase totals/charts. It accumulates as `bigint`, bounds every intermediate and emitted value to JavaScript safe integers, and preserves currency partitions and established sorting behavior.

### Regression RED / GREEN Evidence

- **RED:** `pnpm exec vitest run src/data/__tests__/operationIdentity.spec.ts src/data/__tests__/firebaseSession.spec.ts src/data/__tests__/aggregates.spec.ts` failed before implementation: all three requested seams were unresolved (`operationIdentity`, `firebaseSession`, and `aggregates`; 3 failed files, 0 tests run).
- **GREEN:** after the shared seams and adapter wiring, `pnpm exec vitest run src/data/__tests__/operationIdentity.spec.ts src/data/__tests__/firebaseSession.spec.ts src/data/__tests__/aggregates.spec.ts src/data/__tests__/commandQueue.spec.ts src/data/__tests__/demoRepository.spec.ts src/data/__tests__/firebaseDecoders.spec.ts` passed: 6 files, 16 tests. It covers hydrated-auth gating, exact replay vs payload/group conflicts, cross-user resource separation, unsafe operation IDs, aggregate overflow, and all previous data contracts.

### Fix-Round Validation

- Focused command above — passed: 6 files, 16 tests.
- `pnpm test` — passed: 13 files, 49 tests. Existing Ionic source-map notices were emitted; no test failed.
- `pnpm run typecheck` — passed.
- `pnpm run build` — passed. Vite emitted the existing 1.14 MB chunk-size warning.
- `git diff --check` — passed.

### Fix-Round Files Changed

- Added `src/data/firebaseSession.ts`, `operationIdentity.ts`, and `aggregates.ts`
- Added focused tests for the three modules
- Modified `commandQueue.ts`, `demoRepository.ts`, `firebaseRepository.ts`, and the demo repository test
- Appended this report

### Fix-Round Concerns

- The replay identity and Firebase transaction record are pure/source-tested only. A Firebase emulator or authenticated project is still required to prove Firestore transaction/rule behavior under concurrent real clients.
- SHA-256 uses the Web Crypto API supplied by supported browsers and the test runtime; environments without Web Crypto will fail command identity creation rather than silently weakening replay protection.
- Pre-existing untracked `public/` assets and unrelated controller files remain untouched.

---

## Fix Round 3 / 5: Queue Envelope Conflicts And Ledger Resource Binding

### Review-Finding Mapping

1. **Queue envelope replay:** `CommandQueue.submit()` now compares the complete stable canonical envelope fingerprint when an operation ID is already known. Any payload, group, or kind change atomically persists a `conflicted` operation/handle without invoking another handler. Completion/error handling also verifies that a superseded pending operation cannot overwrite that conflict. `OperationReplayConflictError` from a registered handler is mapped to the same non-retryable conflicted state; only genuine failures can retry.
2. **Ledger resource binding:** replay identity assertion now includes `resourceId`. Firebase validates the stored identity, including deterministic uid-plus-operation resource ID, before decoding/returning a ledgered expense. A corrupt resource ID is therefore a replay conflict rather than a new-command-context decode.

### Regression RED / GREEN Evidence

- **RED:** `pnpm exec vitest run src/data/__tests__/commandQueue.spec.ts src/data/__tests__/operationIdentity.spec.ts` ran 10 tests with 3 expected failures: changed payload replay resolved the old result, a handler `OperationReplayConflictError` was not a `CommandConflictError`, and a corrupt `resourceId` passed identity assertion.
- **GREEN:** after canonical queue comparison, conflict mapping, stale-completion protection, and resource-ID assertion were added, `pnpm exec vitest run src/data/__tests__/commandQueue.spec.ts src/data/__tests__/operationIdentity.spec.ts src/data/__tests__/firebaseSession.spec.ts src/data/__tests__/aggregates.spec.ts src/data/__tests__/demoRepository.spec.ts src/data/__tests__/firebaseDecoders.spec.ts` passed: 6 files, 19 tests.

### Fix-Round Validation

- Focused command above — passed: 6 files, 19 tests.
- `pnpm test` — passed: 13 files, 52 tests. Existing Ionic source-map notices were emitted; no test failed.
- `pnpm run typecheck` — passed.
- `pnpm run build` — passed. Vite emitted the existing 1.14 MB chunk-size warning.
- `git diff --check` — passed.

### Fix-Round Files Changed

- Modified `src/data/commandQueue.ts`, `operationIdentity.ts`, and their focused tests
- Appended this report

### Fix-Round Concern

- The transaction call path is source/pure-test verified but still needs an emulator-authenticated concurrency test in its dedicated Firebase work to establish backend rule behavior. Public assets and controller files remain untouched.
