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

---

## Fix Round 1/5

### Finding mapping

1. **Critical — FAB slot:** Removed the invalid `slot="fixed"` from the direct `ion-tabs` child. The real Ionic render test now asserts that `ion-tabs > ion-fab` has no slot and that its real `IonFabButton` receives the active-stack route. CSS fixes the FAB above the tab bar with a safe-area-aware fixed position.
2. **Important — exact money:** Replaced decimal-string `Number()` conversion with `BigInt` minor-unit division and an `Intl.NumberFormat.formatToParts()` template. The implementation preserves the locale's sign, currency symbol, grouping, digit glyphs, and fixed ISO fraction padding. Regressions cover `Number.MAX_SAFE_INTEGER` in USD/BHD/CLF and negative USD sub-units.
3. **Important — route motion:** Added the public Ionic `iosTransitionAnimation` builder as `navAnimation` in Ionic setup. It retains Ionic forward/back mechanics and reads `prefers-reduced-motion` at every navigation. Normal builder duration is 320ms; Ionic's public animation implementation clamps a requested 0ms duration to a one-frame `getDuration() === 1`, which is its immediate transition behavior.
4. **Important — palette:** Imported Ionic's installed `dark.system`, `high-contrast.system`, and `high-contrast-dark.system` palettes. Brand overrides now define separate light, dark, high-contrast-light, and high-contrast-dark surface/text/divider/avatar/owed/owing tokens. The dark+high-contrast block is ordered and scoped after dark, so it cannot be replaced by light high-contrast values. Owed/owing use high-luminance green/coral on dark surfaces and dark green/red on white surfaces; avatar foreground/background and dividers use explicit high-contrast pairs.
5. **Important — financial grid:** Replaced per-row `auto` money columns with a shared `--su-financial-track: 62px` contract and preserved right-aligned tabular columns at 390px. The persistent reflow class switches narrow viewports to a three-row layout, so long descriptions wrap and neither amount is clipped.
6. **Important — category semantics:** Replaced the `IonButton` category tile with noninteractive 44px category content. It retains the Ionicon and exposes `Category: <name>` text to assistive technology.
7. **Minor — MoneyAmount semantics:** Removed generic-span-only `aria-label` dependence. Visible amount/direction are hidden from duplicate speech and a visually-hidden contextual phrase provides the full debt statement.
8. **Minor — MemberAvatar semantics:** The avatar now has `role="img"` with its member name while both the image alternative and initials avoid duplicate announcement.

### Strict TDD evidence

#### RED

Command:

```sh
pnpm vitest run src/app/__tests__/navigation.spec.ts src/app/__tests__/theme.spec.ts src/components/__tests__/ExpenseRow.spec.ts src/features/shell/__tests__/TabsShell.spec.ts
```

Exit: `1`.

Expected product failures included:

```text
Failed to resolve import "../navigation"
expected "fixed" to be undefined
expected '$90,071,992,547,409.90' to be '$90,071,992,547,409.91'
expected 'BHD 9,007,199,254,740.990' to be 'BHD 9,007,199,254,740.991'
expected '$0.01' to be '-$0.01'
expected true to be false (interactive category button)
expected undefined to be 'img'
Test Files 4 failed (4)
Tests 11 failed | 12 passed (23)
```

The first source-token test invocation used an unsupported Vite URL scheme for `readFileSync`; that test support was corrected before the recorded RED command above, without production changes.

#### GREEN

Command:

```sh
pnpm vitest run src/app/__tests__/navigation.spec.ts src/app/__tests__/theme.spec.ts src/components/__tests__/ExpenseRow.spec.ts src/features/shell/__tests__/TabsShell.spec.ts src/composables/__tests__/useMotion.spec.ts
```

Output:

```text
Test Files 5 passed (5)
Tests 29 passed (29)
```

### Fix-round validation

- `pnpm test` — 17 files passed, 81 tests passed.
- `pnpm run typecheck` — passed.
- `pnpm run build` — passed; Vite built 202 modules.
- `git diff --check` — passed.

### Remaining QA boundary

The `terminal.local` browser relay is unreachable, so browser-visible FAB placement, 390px reflow, and live OS palette verification remain a later browser QA activity. The real-Ionic DOM test covers the direct-child/slot/active-route contract without a shallow slot stub. The Vite chunk-size advisory and upstream Ionic sourcemap notices remain non-blocking.

---

## Fix Round 2/5

### Finding mapping

1. **Exact locale grouping:** `MoneyAmount` now gives the native `Intl.NumberFormat` formatter a `BigInt` whole-unit value, then inserts the exact minor-unit fraction into the formatter's signed/currency-ordered part template. No grouping size or threshold is inferred. The `es-ES` EUR `1000.00` regression matches native output without a thousands separator, while the prior en-US maximum-safe and negative sub-unit regressions remain covered.
2. **Dynamic Type at 390:** Added the SSR-safe `useExpenseRowLayout` seam. A `ResizeObserver` schedules a post-layout measurement; only actual `scrollWidth > clientWidth` applies `expense-row--reflow`. At a measured 390px default row the two fixed 62px financial tracks stay in place; simulated same-width overflow switches to multi-row layout and cleanup disconnects the observer.
3. **Complete palette and contrast:** Each light, dark, high-contrast-light, and high-contrast-dark block now declares the full Ionic primary tuple: primary, RGB, contrast, contrast RGB, shade, and tint. Category foreground is mode-specific. Pure WCAG contrast tests cover body text, primary foreground, divider, avatar, owed, and owing against their corresponding surfaces in all four modes at >=4.5:1.
4. **FAB safe area:** Removed custom `position`, `right`, and `bottom` declarations. The direct `IonFab` now relies solely on its public `vertical="bottom"` and `horizontal="end"` placement inside `ion-tabs`; only button presentation/press styling remains.

### Strict TDD evidence

#### RED

Command:

```sh
pnpm vitest run src/composables/__tests__/useExpenseRowLayout.spec.ts src/components/__tests__/ExpenseRow.spec.ts src/app/__tests__/theme.spec.ts
```

Exit: `1`.

Observed expected failures:

```text
Failed to resolve import "../useExpenseRowLayout"
expected '1.000,00 €' to be '1000,00 €'
expected ExpenseRow source to contain 'useExpenseRowLayout'
expected AppFab source not to contain 'position: fixed'
expected 1 to be greater than or equal to 4 (Ionic primary tuple)
Test Files 3 failed (3)
Tests 4 failed | 39 passed (43)
```

#### GREEN

Command:

```sh
pnpm vitest run src/composables/__tests__/useExpenseRowLayout.spec.ts src/components/__tests__/ExpenseRow.spec.ts src/app/__tests__/theme.spec.ts
```

Output:

```text
Test Files 3 passed (3)
Tests 44 passed (44)
```

### Fix-round validation

- `pnpm test` — 18 files passed, 108 tests passed.
- `pnpm run typecheck` — passed.
- `pnpm run build` — passed; Vite built 202 modules.
- `git diff --check` — passed.

### Remaining QA boundary

The browser relay remains unavailable. The measured-overflow and real-Ionic public-prop tests cover the terminal-verifiable behavior; final browser visual confirmation of 390px Dynamic Type and Ionic safe-area placement remains later QA. The Vite chunk-size advisory and upstream Ionic sourcemap notices are non-blocking.

---

## Fix Round 3/5

### Finding mapping

1. **Stable Dynamic Type reflow:** `useExpenseRowLayout` now remembers the available width that triggered reflow and holds that state across follow-up `ResizeObserver` notifications at the same width. `ExpenseRow` explicitly invalidates the measurement only when rendered row content inputs change. This prevents the post-reflow layout from clearing its own state while still allowing a genuine width or content change to re-evaluate it. The observer remains disconnected on unmount.
2. **Pending sync contrast:** Pending status now uses the mode-aware `--ion-color-primary` token rather than the fixed accent. Contrast regressions cover its foreground/background pair in light, dark, high-contrast-light, and high-contrast-dark modes at >=4.5:1.
3. **iOS branded surfaces:** Brand background/text overrides now target `:root.ios`, matching Ionic's installed palette specificity. Each of the four modes declares surface/text RGB companion tokens and applies them as Ionic background/text RGB values, so forced iOS mode retains the branded surfaces even after the Ionic system palette import.

### Strict TDD evidence

#### RED

Command:

```sh
pnpm vitest run src/composables/__tests__/useExpenseRowLayout.spec.ts src/components/__tests__/ExpenseRow.spec.ts src/app/__tests__/theme.spec.ts
```

Exit: `1`.

Observed expected failures before the round-three production changes:

```text
FAIL useExpenseRowLayout > switches a 390px row to reflow only when measured content overflows and cleans up
expected false to be true

FAIL SyncStatus > uses the mode-aware Ionic primary token for pending status
expected SyncStatus source to contain '.sync-status--pending { color: var(--ion-color-primary); }'

FAIL Split Unwise theme > scopes branded Ionic surfaces to iOS and preserves their RGB companions in every mode
expected 0 to be greater than or equal to 4

Test Files 3 failed (3)
Tests 3 failed | 47 passed (50)
```

#### GREEN

Command:

```sh
pnpm vitest run src/composables/__tests__/useExpenseRowLayout.spec.ts src/components/__tests__/ExpenseRow.spec.ts src/app/__tests__/theme.spec.ts
```

Output:

```text
Test Files 3 passed (3)
Tests 50 passed (50)
```

### Fix-round validation

- `pnpm test` — 18 files passed, 114 tests passed.
- `pnpm run typecheck` — passed.
- `pnpm run build` — passed; Vite built 202 modules.
- `git diff --check` — passed.

### Remaining QA boundary

The terminal browser relay remains unavailable, so browser-visible Dynamic Type behavior and live forced-iOS palette verification remain later QA. Terminal regressions cover reflow persistence, observer cleanup, token contrast, and iOS-specific source contracts. The existing Vite chunk-size advisory and upstream Ionic sourcemap notices remain non-blocking.

---

## Fix Round 4/5

### Finding mapping

1. **Invariant reflow measurement:** While `expense-row--reflow` is active, `useExpenseRowLayout` now removes that class only long enough to synchronously read the unreflowed grid's `scrollWidth` and `clientWidth`, then restores it before updating reactive state. The probe runs inside one JavaScript task, so there is no painted intermediate layout and no dependency on a second observer callback. Same-width observer callbacks stay latched; invalidated content and a real available-width change re-evaluate the intrinsic grid in either direction. Observer cleanup remains unchanged.

### Strict TDD evidence

#### RED

Command:

```sh
pnpm vitest run src/composables/__tests__/useExpenseRowLayout.spec.ts
```

Exit: `1`.

Observed expected failure before the invariant probe was implemented:

```text
FAIL useExpenseRowLayout > probes unreflowed content for invalidation and width changes without dropping the reflow class
expected false to be true

Test Files 1 failed (1)
Tests 1 failed | 1 passed (2)
```

#### GREEN

Command:

```sh
pnpm vitest run src/composables/__tests__/useExpenseRowLayout.spec.ts src/components/__tests__/ExpenseRow.spec.ts
```

Output:

```text
Test Files 2 passed (2)
Tests 19 passed (19)
```

The new composable regression drives a class-bound row through: intrinsic overflow, same-width content invalidation while reflowed, content shrink and growth, width growth from 390px to 450px, width shrink back to 390px, and unmount cleanup.

### Fix-round validation

- `pnpm test` — 18 files passed, 115 tests passed.
- `pnpm run typecheck` — passed.
- `pnpm run build` — passed; Vite built 202 modules.
- `git diff --check` — passed.

### Remaining QA boundary

The terminal browser relay remains unavailable, so rendered Dynamic Type behavior remains later browser QA. The no-paint synchronous probe and state transitions are covered with class-bound DOM regression tests; Vite's existing chunk-size advisory and upstream Ionic sourcemap notices are non-blocking.
