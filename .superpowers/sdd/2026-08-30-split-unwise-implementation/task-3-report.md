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
