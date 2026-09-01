# Add Expense mobile refinement audit

Viewport: 390 x 844. Source: local demo mode from the current production code path before the polish pass.

## Step 1 — Add Expense start

Health: needs polish, structurally sound.

- Strength: the native toolbar, context selector, description/amount hierarchy, and payer/split sentence make the primary task obvious.
- UX risk: the 390px media rule stacks every option value under its label. Category, currency, date, participant count, receipt, notes, and repeat consume too much vertical space and do not read like compact iOS settings rows.
- UX risk: the raw browser file input is exposed as a second receipt control. It is visually inconsistent and makes the Receipt row's action ambiguous.
- Accessibility: controls are labelled and the toolbar/tap targets are usable. Keep focus restoration and error-summary behavior intact during polish.

Evidence: `01-add-expense-start.png`.

## Step 2 — Recurrence editor

Health: usable, visually generic.

- Strength: Cancel/Apply, explicit frequency choices, time zone, and schedule explanation are clear.
- UX risk: the breakpoint sheet reads as a generic bottom drawer and leaves a large blank canvas. The requested native iOS direction is Ionic's card-modal presentation with swipe dismissal.
- Accessibility: selected state is perceivable, and the dirty-state dismissal guard is important. Preserve the guard when adding swipe dismissal.

Evidence: `02-recurrence-sheet.png`.

## Step 3 — Payer editor

Health: clear, with room for native polish.

- Strength: the payer list is easy to scan and touch targets are comfortably sized.
- UX risk: the same bottom-sheet container and web-checkbox treatment make the surface feel less native than the surrounding Ionic app.
- Scope decision: convert the shared editor overlay to an Ionic card modal now; do not refactor every sheet's internal controls unless a targeted change is needed for layout or accessibility.

Evidence: `03-payer-sheet.png`.

## Bounded recommendations selected for implementation

1. Replace breakpoint sheet props with Ionic card-modal presentation using `presentingElement`; keep swipe-to-dismiss plus the existing dirty-change confirmation.
2. Keep option labels and values in compact, overflow-safe inline rows at 390px instead of forcing every value onto a second line.
3. Hide the native file input and let the Receipt row trigger file selection when empty or open review when an attachment exists.
4. Add consistent trailing disclosure affordances to modal-opening rows without changing the feature hierarchy.
5. Re-capture the same three states at 390 x 844, inspect overflow and focus behavior, then verify the hosted build after deployment.

## Post-polish evidence

### Add Expense editor

`04-add-expense-polished.png` shows the local demo editor at 390 x 844 after the polish pass. Category, currency, date, participants, receipt, and repeat use compact inline rows with trailing affordances; the raw file input is not visibly duplicated; and the full form remains vertically scrollable without visible horizontal clipping.

### Recurrence card modal

`05-recurrence-card-modal.png` shows the recurrence editor presented as an Ionic card modal with a visible presenting layer, native-style Cancel/Apply actions, frequency choices, time zone, and schedule guidance. The screenshot proves the card-modal geometry and visible controls, not swipe physics or dirty-dismiss confirmation behavior.

### Recurring management

`06-recurring-expenses-mobile.png` shows the local demo Recurring screen at 390 x 844 with series state, amount, schedule, next date, latest-expense navigation, future-edit action, and stop-series action visible without horizontal clipping. It does not prove the Firebase catch-up transaction, concurrent-client convergence, cancellation authorization, or hosted navigation.

## Evidence limits

Screenshots can verify hierarchy, spacing, clipping, and visible control treatment. All six images are local demo evidence, not a hosted or native-runtime proof. Swipe physics, keyboard movement, VoiceOver output, Dynamic Type, dirty-dismiss behavior, file-picker behavior, live Firebase mutations, and physical-device interaction require interactive/browser or native tests and are not proven by the screenshots alone.
