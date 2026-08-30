# Task 5 report — Home, Groups, and selected group journal

## Status

DONE_WITH_CONCERNS

## What changed

- Added Pinia 3.0.4 and installed it at the application composition root.
- Added repository-backed Home and Groups pages with durable navigation to Lake House Weekend.
- Added a Pinia group store that consumes `createRepository()` and derives every current-user journal position from each expense payer and allocation snapshot.
- Added the selected Lake House group detail experience: real cover asset, `LW` monogram, truthful net balance, newest-first August ledger, category Ionicons, action rail, local Expenses/Activity segment, group-scoped FAB, and scroll-collapse motion.
- Replaced the no-heading route placeholder with route-specific accessible pages for Activity, Account, add-expense, and later group actions.
- Added durable routes for Settle up, Balances, Totals, Charts, Export, settings, and the group-scoped expense composer.
- Hid the global four-tab chrome on group-scoped routes and restored it at the four tab roots.
- Extended `ExpenseRow` with its journal presentation while preserving its existing general-purpose layout and Dynamic Type reflow behavior.
- Added and tracked `public/assets/images/lake-house-cover.png`. `public/assets/images/app-icon-1024.png` remains intentionally untracked and unstaged for Task 12.

## TDD evidence

### RED

Command:

`pnpm vitest run src/features/groups/__tests__/GroupDetailPage.spec.ts src/features/shell/__tests__/TabsShell.spec.ts src/app/__tests__/router.spec.ts`

Observed result before implementation: 24 expected behavioral failures and 15 passing baseline checks. Failures covered the absent journal hierarchy, truthful row/net values, action destinations, local view switching, scroll collapse, route-specific headings and links, scoped routes, and global tab-bar suppression.

### GREEN

Focused command:

`pnpm vitest run src/features/groups/__tests__/GroupDetailPage.spec.ts src/features/shell/__tests__/TabsShell.spec.ts src/app/__tests__/router.spec.ts`

Result: 3 files passed, 39 tests passed.

Full verification:

- `pnpm test` — 19 files passed, 139 tests passed.
- `pnpm typecheck` — passed.
- `pnpm build` — passed; Vite emitted only its existing large-chunk advisory.
- `git diff --check` — passed.

## Financial proof

The UI derives, and tests independently assert, Maya's positions from repository payer/allocation data:

- Groceries: you lent $127.50.
- Kayak rental: you borrowed $15.00.
- Cabin deposit: you borrowed $100.00.
- Dinner: you borrowed $18.25.
- Gas for the boat: you lent $42.00.
- Group net: Maya is owed $36.25.

The illustrative `$137.07` value from the generated reference is explicitly excluded by the component test.

## Deviations and concerns

- Settle up, Balances, Totals, Charts, Export, settings, and expense composition have real durable router actions, but their full workflows remain clearly labeled route-specific placeholders because Tasks 6, 8, and 9 own those implementations.
- The controller's `terminal.local` in-app browser relay was already unreachable while the Vite listener was healthy. No browser screenshot or source-vs-prototype visual QA is claimed for this task. The exact 390 × 844 crop, footer/FAB position, and Dynamic Type behavior remain residual visual risks for Task 12's browser gate.
- Pinia was pinned to 3.0.4 because the registry's current 4.0.3 release introduced an unmet `@vue/devtools-api` peer against this Ionic/Vue dependency graph.

## Self-review

- No Firestore imports or UI-only financial fixtures were introduced in feature code.
- Every standard visual symbol uses Ionicons; the supplied lake image is the only new visible raster asset.
- Financial text is stable and explicit; money does not animate.
- Motion stays within 160–180 ms and is disabled by the existing reduced-motion rules.
- Action targets are at least 44 points and icon-only settings/add controls have accessible names.
