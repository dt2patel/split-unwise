# Task 4b Report: Bounded Add Expense Mobile Polish

## Implementation

- Replaced the expense editor's breakpoint sheet props with Ionic's iOS card-modal contract by passing the mounted `IonPage` element through `presentingElement`. The existing inline `IonModal` and sheet components remain in place.
- Clean sheets now pass the synchronous boolean `true` to `canDismiss`, preserving an uninterrupted swipe gesture. A sheet switches to the existing confirmation callback only after staged input or a child dirty event; backdrop and gesture roles remain guarded.
- Removed the 390px rule that stacked every trailing option value. Category, Currency, Date, Split with, Receipt, and Repeat remain compact three-track rows with shrinkable/wrapping content, bounded trailing space, 52px rows, and overflow guards. Notes intentionally keeps its separate two-column, multi-line layout.
- Replaced the exposed browser file chooser with one hidden, non-tab-stop image input. The visible Receipt row opens that picker while empty and opens Receipt review once an attachment draft exists; its accessible label reflects the current action and the original MIME allowlist is unchanged.
- Added restrained Ionic chevrons to Split with, Receipt, and Repeat while leaving native select/date controls undecorated.
- Preserved toolbar slots, save/cancel and validation behavior, recurrence edit scope, receipt durability, error-summary focus, sheet focus restoration, keyboard avoidance, Dynamic Type wrapping, and reduced-motion rules. The shared expense-sheet CSS required no change.

## TDD Evidence

### RED

Command before production edits:

```sh
pnpm exec vitest run src/features/expenses/__tests__/ExpenseEditorPage.spec.ts
```

Result: **1 file failed; 6 failed, 24 passed**. The six expected failures independently exposed missing `presentingElement`, retained breakpoint props/callback-based clean dismissal, the visible file input and wrong empty-state receipt action, missing disclosure icons, and the active two-column 390px stacking override.

### GREEN

The same focused editor command after the minimum implementation passed: **1 file passed; 30 tests passed**.

## Final Focused Verification

```sh
pnpm exec vitest run src/features/expenses/__tests__/ExpenseEditorPage.spec.ts src/features/expenses/__tests__/ExpenseSheets.spec.ts src/features/expenses/__tests__/SplitEditor.spec.ts src/features/expenses/__tests__/sheetKeyboardAvoidance.spec.ts
pnpm typecheck
git diff --check
```

Results:

- Focused expense editor/sheet suite: **4 files passed; 81 tests passed**.
- Shared build and Vue TypeScript check: **passed**.
- Whitespace check: **clean**.

No broad suite, build, deployment, or browser/device recapture was run, per the Task 4b verification boundary.

## Files Changed

- `src/features/expenses/ExpenseEditorPage.vue`
- `src/features/expenses/__tests__/ExpenseEditorPage.spec.ts`
- `.superpowers/sdd/2026-09-01-spark-recurring-expenses/task-4b-report.md`

The existing untracked audit evidence and recurring-expenses plan were inspected but not modified or added to the commit.

## Concerns

- Automated tests prove the Ionic prop contract, dismissal branching, DOM accessibility behavior, and responsive CSS rules, but do not prove physical swipe feel, VoiceOver output, keyboard animation, or the rendered iOS card appearance on a device.
- The environment continues to emit the existing Node 26 versus Functions Node 22 engine warning, experimental localStorage warning, and Ionic missing-sourcemap warnings. They did not fail the focused commands.
