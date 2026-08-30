# Task 2: Domain Money, Splits, Balances, And Recurrence

## Implementation

Implemented a framework-independent TypeScript domain slice under `src/domain`:

- `model.ts` defines immutable money, expense, allocation, split, balance, debt, and recurrence contracts.
- `money.ts` stores monetary values as integer minor units, uses an explicit ISO 4217 exponent map (zero- and three-decimal currencies, otherwise two decimals), and converts decimal input with half-away-from-zero rounding.
- `splits.ts` computes exact-sum allocations for equal, exact, percentage, shares, adjustment, and itemized methods. Remainders go to input participant order.
- `balances.ts` aggregates expenses into canonical signed pairwise obligations and derives a deterministic positive-only settlement plan per currency while preserving net positions.
- `recurrence.ts` advances date-only ISO occurrences in UTC and clamps monthly/yearly dates to the target month's final day.
- `exports.ts` emits CSV with deterministic columns and RFC-style quote escaping, and recursively key-sorted JSON with a trailing newline.

## Type Decisions

- A `Money` value is `{ currency, minorAmount }`; all money arithmetic is safe-integer minor-unit arithmetic.
- An `Expense` has one `payerId` in this slice. Multiple-payer expense construction is a later application concern; its persisted rows can still be represented as one or more balanced expenses.
- Pairwise balances canonicalize the two participant IDs lexicographically. A positive amount means `fromParticipantId` owes `toParticipantId`; a negative amount reverses that obligation.
- Adjustment splits use non-negative fixed minor-unit additions before equally sharing the residual. This is the narrowest unambiguous interpretation of fixed adjustments and prevents negative allocations.
- `nextOccurrence` is date-only and stateless: each call clamps the given date's day into the next target month/year. A future recurring-template layer that needs a permanent original-day anchor should store that anchor separately.

## RED / GREEN Evidence

1. Money conversion
   - RED: `pnpm vitest run src/domain/__tests__/money.spec.ts` failed with `Failed to resolve import "../money"` (0 tests), proving the missing contract.
   - GREEN: after `model.ts` and `money.ts`, the same command passed: 1 file, 3 tests.
2. Split allocation methods
   - RED: `pnpm vitest run src/domain/__tests__/splits.spec.ts` failed with `Failed to resolve import "../splits"` (0 tests).
   - GREEN: after `splits.ts`, the same command passed: 1 file, 6 tests.
3. Signed balances and simplification
   - RED: `pnpm vitest run src/domain/__tests__/balances.spec.ts` failed with `Failed to resolve import "../balances"` (0 tests).
   - GREEN: after `balances.ts`, the same command passed: 1 file, 2 tests.
4. Recurrence
   - RED: `pnpm vitest run src/domain/__tests__/recurrence.spec.ts` failed with `Failed to resolve import "../recurrence"` (0 tests).
   - GREEN: after `recurrence.ts`, the same command passed: 1 file, 3 tests.
5. Stable exports
   - RED: `pnpm vitest run src/domain/__tests__/exports.spec.ts` failed with `Failed to resolve import "../exports"` (0 tests).
   - GREEN: after `exports.ts`, the same command passed: 1 file, 2 tests.

## Validation

- `pnpm vitest run src/domain/__tests__` — 5 files passed, 16 tests passed.
- `pnpm typecheck` — passed.
- `pnpm build` — passed. Vite reported its existing/expected chunk-size warning for a 1.14 MB JavaScript chunk.
- `pnpm test` — 7 files passed, 25 tests passed. Vitest reported missing source-map files from installed Ionic packages; no test failures occurred.
- `git diff --check` — passed.

## Files Changed

- Added `src/domain/model.ts`
- Added `src/domain/money.ts`
- Added `src/domain/splits.ts`
- Added `src/domain/balances.ts`
- Added `src/domain/recurrence.ts`
- Added `src/domain/exports.ts`
- Added `src/domain/__tests__/money.spec.ts`
- Added `src/domain/__tests__/splits.spec.ts`
- Added `src/domain/__tests__/balances.spec.ts`
- Added `src/domain/__tests__/recurrence.spec.ts`
- Added `src/domain/__tests__/exports.spec.ts`
- Added this report

The pre-existing untracked `public/assets/images/*` files were not changed and are excluded from the commit.

## Self-Review And Concerns

- Remainder paths are covered for equal, percentage, shares, adjustment residuals, and item lines; each produces exactly the input total.
- Simplification is intentionally deterministic by currency and participant ID, avoiding cross-currency netting and locale-sensitive ordering.
- The currently scoped money conversion accepts decimal number input by its JavaScript string form. Application/UI layers should prefer decimal strings when accepting user input so no binary floating-point value is introduced before this boundary.
- No framework, Ionic, Firebase, router, dependency, or public-asset changes were made.
