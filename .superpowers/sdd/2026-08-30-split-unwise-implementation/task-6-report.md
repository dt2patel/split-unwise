# Task 6 report — Expense composer and every split method

## Status

DONE_WITH_CONCERNS

## What changed

- Replaced `payerId` everywhere with canonical `payments: readonly Allocation[]`, including the domain, Lake House seed, aggregates, recurrence, demo/Firebase repositories, decoders, group journal, and shared rows. Multi-payer balances use checked `bigint` intermediates and preserve exact participant nets.
- Closed percentage, shares, and adjustment keyed-map validation so keys must exactly match the selected participants.
- Expanded expense persistence with revisions, update timestamps, split method, notes, durable attachment references, recurrence/time zone, occurrence edit scope, `getById`, optimistic edit, and saved add/edit/delete result shapes. Demo edits increment revisions, conflict on stale revisions, and correctly clear removed optional fields.
- Added one app-scoped repository/queue session. The durable queue exposes defensive snapshots, typed failures, failed-only retry/discard, conflict retention, unsupported-result failure, and reload resume.
- Added IndexedDB-backed receipt blob storage and upload/recognition/delete ports. Commands contain only durable references. Demo recognition is explicitly unavailable, retains the image, and supports editable manual items, tax, tip, assignments, and explicit confirmation.
- Added full-screen origin-scoped add/edit routes and a native Ionic editor based on the official Apple add-expense composition: Cancel/title/Save, a repository-backed group/direct-group context picker, category/description, amount/currency, multi-payer and split summary, date, participants, receipt, notes, recurrence, and one staged sheet at a time.
- Added Equal, Exact, Percentage, Shares, Adjustment, and Itemized split editors, all routed through `toMinorUnits` and `computeAllocations`.
- Added inline validation with connected `aria-invalid`/`aria-describedby` messages and a focused assertive summary. Currency changes explicitly reset amount-dependent inputs.
- Added backdrop/gesture confirmation for dirty staged sheets, deterministic focus restoration, 44-point paid/split and sheet targets, short stable transitions, and reduced-motion fallbacks.
- Projected queued adds/edits into the group journal immediately. Pending, failed, and conflicted rows survive store recreation; failed rows expose Retry and Discard; saved rows reconcile without duplication.
- Changed composer chrome authority to `route.meta.hideAppChrome` and migrated the Lake House FAB to `/tabs/groups/expenses/new?groupId=lake-house-weekend`, retaining a legacy redirect.

## Reference inspection

The supplied Apple CDN URL no longer returned the requested asset. The current official Apple listing's add-expense screenshot was downloaded through Apple's current listing metadata and visually inspected before UI implementation. Its full-screen iOS form hierarchy informed this original indigo/lilac implementation; no Splitwise branding or assets were copied.

## Strict TDD evidence

Implementation proceeded in the required dependency order: domain/financial model, repository contracts and adapters, durable queue/session, receipt ports, store validation, split matrix, staged sheets, routes/editor, then pending-journal integration.

### RED

The staged RED runs produced expected failures before their production changes:

- Domain/model tests failed on the absent `payments` contract, multi-payer net preservation, and incomplete keyed maps.
- Repository/decoder/queue tests failed on missing revision/edit results, strict Firebase financial decoding, snapshots, durable resume, failed-only discard, and unsupported failure typing.
- Receipt/store tests failed before local receipt references, unavailable recognition, create/edit hydration, exponent-aware validation, and persisted-first submission existed.
- Split/sheet tests failed before all six methods, multi-payer staging, recurrence time zones, and manual receipt confirmation existed.
- Router/editor/journal tests failed before origin edit routes, metadata chrome suppression, accessible full-screen composition, staged dismissal, context selection, and pending reconciliation existed.
- Final corrective RED command:

  `pnpm vitest run src/data/__tests__/demoRepository.spec.ts src/features/expenses/__tests__/ExpenseEditorPage.spec.ts`

  Result before the corrective implementation: 2 expected failures covering removal of persisted optional edit fields and missing connected accessibility attributes.

### GREEN

Focused checkpoints included:

- Domain/data/group contract slice — 94 tests passed.
- Receipt ports — 2 tests passed.
- Expense store — 9 tests passed.
- Six-method split matrix — 8 tests passed.
- Staged payer/participant/recurrence/receipt sheets — 4 tests passed.
- Router/chrome slice — 45 tests passed.
- Expense editor, including context selection and dirty backdrop/gesture dismissal — 5 tests passed before the final accessibility regression was added.
- Pending journal/group-store slice — 5 tests passed.
- Shared row/pending/group-detail slice — 37 tests passed.
- Corrective command above — 2 files passed, 12 tests passed.

## Final verification

- `pnpm test` — 27 files passed, 197 tests passed.
- `pnpm typecheck` — passed.
- `pnpm build` — passed; Vite emits only its existing large-chunk advisory.
- `git diff --check` — passed.

## Files

- Domain/data: `src/domain/model.ts`, `balances.ts`, `splits.ts`; `src/data/repositories.ts`, `demoRepository.ts`, `firebaseDecoders.ts`, `firebaseRepository.ts`, `commandQueue.ts`, `session.ts`, `receipts.ts`, aggregates, seed data, and focused tests.
- Composer: `src/features/expenses/ExpenseEditorPage.vue`, `expenseStore.ts`, `components/ContextSheet.vue`, `PayerSheet.vue`, `ParticipantSheet.vue`, `SplitEditor.vue`, `RecurrenceSheet.vue`, `ReceiptReview.vue`, shared sheet styles, and focused tests.
- Integration: `src/app/router.ts`, `src/features/shell/TabsShell.vue`, `src/features/groups/groupStore.ts`, `GroupDetailPage.vue`, `src/components/ExpenseRow.vue`, and their tests.

## Residual QA and provider boundaries

- Production receipt upload/OCR remains intentionally unavailable until a credentialed provider is configured. The local image and complete manual itemization path remain usable; no live-provider claim is made.
- Firebase financial mutations remain typed unavailable until Task 11 supplies authenticated callable Functions with the required cross-document integrity and audit behavior.
- The receipt lifecycle is unit-tested through the port's deterministic memory seam; actual IndexedDB persistence, camera/gallery integration, swipe physics, safe areas, Dynamic Type, and 390 × 844 visual comparison remain Task 12 browser/device QA.
- Vite's existing large-chunk advisory and upstream Ionic sourcemap notices are non-blocking.
- `public/assets/images/app-icon-1024.png` remains untouched, untracked, and unstaged for Task 12.

## Self-review

- No feature imports Firestore directly; all reads and mutations use repository interfaces.
- No `File` or `Blob` enters a serialized command.
- No second payer authority remains.
- Conflicts preserve both the local draft and remote record and cannot be discarded/retried as ordinary failures.
- Financial display does not roll/count money, and pending-row transforms are disabled for reduced motion.
- Optional note/recurrence/scope removal and every rendered validation relationship have explicit regressions.
