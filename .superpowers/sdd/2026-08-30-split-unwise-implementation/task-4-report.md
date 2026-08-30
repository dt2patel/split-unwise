# Task 4: Native Shell, Theme, Motion, And Shared Components

## Summary

- Added an iOS Ionic four-tab shell with Ionicons and an Add Expense FAB that stays outside the tab bar and resolves to the active tab stack's creation route.
- Added `MoneyAmount`, `ExpenseRow`, `MemberAvatar`, `SyncStatus`, `AppFab`, and capability-safe motion, haptic, and network composables.
- Added indigo/violet/lilac theme tokens, tabular financial numerals, explicit debt and sync text, reduced-motion overrides, dark/high-contrast token refinements, 44px controls, and Vite `terminal.local` allowance.
- Added `ionicons` as a direct dependency; no hand-drawn SVG, CSS art, emoji, or image placeholders were added.

## TDD evidence

### RED: shared visual system

Command:

```sh
pnpm vitest run src/components/__tests__/ExpenseRow.spec.ts src/composables/__tests__/useMotion.spec.ts src/features/shell/__tests__/TabsShell.spec.ts
```

Exit: `1`.

Observed expected failures before production files existed:

```text
Error: Failed to resolve import "../AppFab.vue" from "src/components/__tests__/ExpenseRow.spec.ts". Does the file exist?
Error: Failed to resolve import "../useHaptics" from "src/composables/__tests__/useMotion.spec.ts". Does the file exist?
FAIL TabsShell > keeps Add Expense outside the four-tab bar as a current-stack action
Error: Unable to get [data-testid="add-expense"]
Test Files 3 failed (3)
Tests 1 failed | 4 passed (5)
```

### RED: active-stack creation routes

Command:

```sh
pnpm vitest run src/app/__tests__/router.spec.ts
```

Exit: `1`.

The four new `/tabs/*/expenses/new` cases each warned that no route matched and received `undefined` rather than the expected `*-expense-create` name.

### GREEN: focused contracts

Command:

```sh
pnpm vitest run src/app/__tests__/router.spec.ts src/components/__tests__/ExpenseRow.spec.ts src/composables/__tests__/useMotion.spec.ts src/features/shell/__tests__/TabsShell.spec.ts
```

Output:

```text
Test Files 4 passed (4)
Tests 28 passed (28)
```

## Final validation

- `pnpm test` — 15 files passed, 71 tests passed.
- `pnpm run typecheck` — passed.
- `pnpm run build` — passed; Vite built 201 modules.
- `git diff --check` — passed.

## Files

- `src/features/shell/TabsShell.vue`, `src/app/router.ts`, `src/app/theme.css`, `vite.config.ts`
- `src/components/AppFab.vue`, `MoneyAmount.vue`, `ExpenseRow.vue`, `MemberAvatar.vue`, `SyncStatus.vue`
- `src/composables/useMotion.ts`, `useHaptics.ts`, `useNetwork.ts`
- `src/components/__tests__/ExpenseRow.spec.ts`, `src/composables/__tests__/useMotion.spec.ts`, and updated shell/router tests
- `package.json`, `pnpm-lock.yaml`

## Concerns

- The Vite build reports its standard large-chunk advisory for the current Ionic bundle; it is not a build failure.
- Vitest prints missing upstream Ionic sourcemap notices; all suites still pass.
- Expense editor routes intentionally use the existing placeholder until Task 6 supplies the composer; their per-tab route shape preserves the independent tab-stack boundary now.
- `public/assets/images/app-icon-1024.png` and `public/assets/images/lake-house-cover.png` remain untracked and untouched; they are not part of this task's commit.
