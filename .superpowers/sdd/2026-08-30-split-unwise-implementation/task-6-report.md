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

## Fix Round 1 — 2026-08-30

### Security, consistency, and lifecycle corrections

- Replaced account-agnostic queue persistence with a strict version-2 document stored under a UID-specific key. Every operation records its originating UID; cross-user, malformed, and obsolete records are quarantined, and submit/resume remain unavailable until repository identity hydration binds the session.
- Added explicit network, permission, validation, conflict, unsupported, missing-handler, and unknown failure mapping. Only network failures are retryable; only failed operations can be discarded, while reconciled terminal operations can be acknowledged and pruned.
- Made editor initialization and saving race-safe. Route initialization has request identity, loading/failure states, and stale-result suppression. Save is single-flight, owns one operation ID per attempt, and ignores completions from a superseded editor context. Edit mode without both an ID and revision fails closed.
- Recomputes canonical allocations from `splitMethod` at the repository boundary and rejects contradictory caller allocations. Delete now requires `expectedRevision`, preserves local delete intent and the remote revision on conflict, and produces a revisioned tombstone on success.
- Reconciles the journal from repository rows plus queue results using the highest confirmed revision, applies tombstones, derives posted balances from reconciled rows, acknowledges confirmed successes, and renders local/remote conflict versions with explicit remote-reload and local-retention actions.
- Hardened receipt storage with MIME, size, filename, and non-empty blob validation and with IndexedDB transaction-completion/abort handling. Durable local previews restore after navigation. Add/edit execution promotes local receipt references before the authoritative repository call when upload is available while retaining the persisted local reference for retry and honestly preserving the local fallback when upload is unavailable.
- Standardized recurring-instance edit scope to `occurrence | future`, preserved the recurring-template backlink, and deterministically resets the recurrence anchor after a valid date change.
- Made percentage defaults total exactly 100 for three and four participants. Split/recurrence controls now expose keyboard-operable radio semantics.
- Added bounded, sticky, keyboard/safe-area-aware sheet scrolling; precise invalid-field focus and descriptions; 44-point receipt assignments; wrapping/growing composer and receipt layouts for Dynamic Type; and mode-aware Ionic primary/contrast foregrounds.
- Validates the exact operation, expense, and group identity of saved and conflict results before they can affect durable state. Reusing an operation ID with a different envelope now fails without mutating the original operation, including while its first attempt is still pending.
- Requires `occurrence | future` for every recurring-instance edit. Context and receipt work are request-scoped, so stale async completions cannot change a replaced editor; recognition failure retains the local image and manual-item path.
- Gives delete conflicts their own visible intent and “delete latest version” action, permits every failed operation to be discarded independently of retryability, retires older saved versions with a confirmed tombstone, and resolves conflicts against the highest current repository revision rather than a stale payload.

### Fix-round RED evidence

Each correction began with an isolated failing regression:

- Queue/auth/session: 13 initial expected failures, then 2 focused failures for obsolete recurrence scope and receipt promotion.
- Repository/delete canonicalization: 6 expected failures.
- Journal reconciliation and conflict actions: 7 expected failures.
- Editor lifecycle: 7 expected failures; receipt storage: 3; recurrence decoding: 1; durable preview restoration: 1.
- Sheets, keyboard semantics, percentage defaults, focus, scrolling, receipt reflow, and contrast: 14 initial expected failures plus focused follow-up regressions.
- Page Dynamic Type and journal foreground tokens: 1 and 2 expected failures respectively.
- Adversarial queue identity/replay checks: 9 expected failures; recurring-scope and stale editor/receipt lifecycle checks: 5 expected failures; delete-conflict, discard, tombstone-watermark, and latest-remote journal checks: 8 expected failures.

### Fix-round GREEN and final verification

- Queue/session focused slice: 31/31 passed; broader data/journal slice: 73/73 passed.
- Repository/decoder focused slice: 19/19 passed.
- Final queue/journal/group-row focused slice: 83/83 passed.
- Sheet/split/theme component slice: 48/48 passed.
- Editor/store/page slice: 29/29 passed.
- `pnpm test` — 27 files passed, 265 tests passed.
- `pnpm typecheck` — passed.
- `pnpm build` — passed; Vite emitted only the existing large-chunk advisory.
- `git diff --check` — passed.

### Fix-round residual QA

- No browser or Playwright verification is claimed. Real iOS Dynamic Type, keyboard, safe-area, sheet gesture, IndexedDB reload, and 390 × 844 visual checks remain device/browser QA.
- Production upload/OCR and Firebase mutations remain honest typed provider boundaries pending their credentialed/server implementations.
- Upstream Ionic sourcemap and Node localStorage experimental warnings remain non-blocking test-environment notices.
- `public/assets/images/app-icon-1024.png` remains untouched, untracked, and unstaged.
