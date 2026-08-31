# Task 7 Implementation Report

Date: 2026-08-31

Original implementation baseline: `a7bbf24`

Fix round 1 review baseline: `e0531ea`

Fix round 2 review baseline: `969e3fe`

Fix round 3 review baseline: `ca44a68`

Scope: Expense detail, immutable audit/revisions, comments, global Activity, and principal-owned notifications.

## Outcome

Task 7 is implemented on top of the principal-scoped Task 6 repository/session/queue boundary. Demo mode now provides complete immutable expense revisions and activity, author/manager mutation authorization, user-comment tombstones, durable comment attachment replay, an account-wide Activity feed, and notification read/preferences behavior. Firebase Task 7 reads are decoded and principal guarded; Firebase mutations continue to return explicit typed `not-supported` results until Task 11.

The UI now has all four origin-scoped detail routes, exact group-context validation, native Ionic expense detail, audit and comment surfaces, a real Activity tab, notifications/preferences, semantic expense/activity links, and retained tombstone states. Edit Cancel/Save returns to the originating detail route.

## Files

### Created

- `src/data/__tests__/auditRepositories.spec.ts`
- `src/data/__tests__/task7Decoders.spec.ts`
- `src/data/__tests__/task7QueueSession.spec.ts`
- `src/features/activity/ActivityPage.vue`
- `src/features/activity/activityStore.ts`
- `src/features/activity/__tests__/ActivityPage.spec.ts`
- `src/features/comments/CommentThread.vue`
- `src/features/comments/__tests__/CommentThread.spec.ts`
- `src/features/expenses/ExpenseDetailPage.vue`
- `src/features/expenses/__tests__/ExpenseDetailPage.spec.ts`
- `src/features/notifications/NotificationCenter.vue`
- `src/features/notifications/__tests__/NotificationCenter.spec.ts`

### Modified

- `src/app/router.ts`
- `src/app/__tests__/router.spec.ts`
- `src/components/ExpenseRow.vue`
- `src/components/__tests__/ExpenseRow.spec.ts`
- `src/data/repositories.ts`
- `src/data/demoRepository.ts`
- `src/data/firebaseDecoders.ts`
- `src/data/firebaseRepository.ts`
- `src/data/commandQueue.ts`
- `src/data/session.ts`
- `src/data/__tests__/commandQueue.spec.ts`
- `src/data/__tests__/demoRepository.spec.ts`
- `src/data/__tests__/session.spec.ts`
- `src/demo/lakeHouse.ts`
- `src/features/expenses/expenseStore.ts`
- `src/features/expenses/__tests__/ExpenseEditorPage.spec.ts`
- `src/features/groups/GroupDetailPage.vue`
- `src/features/groups/groupStore.ts`
- `src/features/groups/__tests__/GroupDetailPage.spec.ts`
- `src/features/groups/__tests__/groupStore.spec.ts`
- `src/features/groups/__tests__/pendingJournal.spec.ts`
- `src/features/shell/__tests__/TabsShell.spec.ts`

`public/assets/images/app-icon-1024.png` was intentionally left untouched and untracked.

## RED-first evidence

### Repository, revisions, authorization, comments, Activity, notifications

Production break named: Task 6 had no revision repository, structured account-wide audit, complete comment repository/tombstones, or notification repository.

- Command: `pnpm vitest run src/data/__tests__/auditRepositories.spec.ts`
- RED: 14/14 failed against the baseline interfaces/implementation, including missing `listRevisions`, account Activity, comments, notifications, and author/manager identity.
- GREEN: 14/14 passed after the minimal repository/domain/demo implementation.

### Firebase boundary decoding

Production break named: Task 6 decoders could not safely decode manager capability, actor snapshots, immutable revisions, structured comments/activity, or principal-owned notifications.

- Command: `pnpm vitest run src/data/__tests__/task7Decoders.spec.ts`
- RED: 5/5 failed on absent/incorrect Task 7 decoders.
- GREEN: 5/5 passed with strict ISO timestamps and identity checks.

### Queue schema, full envelopes/results, replay, and session races

Production break named: persisted schema v3 did not understand Task 7 shapes, new envelopes could persist before complete validation, new results were not identity checked, and resumed writes blocked cached activation.

- Command: `pnpm vitest run src/data/__tests__/task7QueueSession.spec.ts`
- RED: 8 failed / 1 passed initially.
- GREEN: 11/11 passed after schema v4, full pre-persist validation, new result guards, registered session handlers, stale-session guards, and non-blocking resume.
- Additional RED: comment receipt promotion expected `remote-receipt:comment-attachment` but received `local-receipt:comment-attachment`; GREEN after comment commands joined the atomically persisted receipt preparation boundary.
- Additional RED: a valid comment delete was rejected because the tombstone retained the immutable creation operation ID; GREEN after delete result validation separated comment creation identity from delete activity identity.

### Four detail routes and route metadata

Production break named: no origin-scoped detail route existed.

- Command: `pnpm vitest run src/app/__tests__/router.spec.ts`
- RED: 8 assertions failed for the four missing named routes and `hideAppChrome` metadata.
- GREEN: all router tests passed with the four routes registered before generic group routes.

### Expense detail and destructive state

Production break named: no real expense-detail component existed.

- Command: `pnpm vitest run src/features/expenses/__tests__/ExpenseDetailPage.spec.ts`
- RED: suite import failed because `ExpenseDetailPage.vue` did not exist.
- GREEN: 9/9 passed for exact context, all origins/back paths, inaccessible/repeated context, tombstones, plural payments, attribution, audit, confirmation focus, and deletion single-flight behavior.

### Comment thread and durable projection

Production break named: no comment thread/composer existed, and the queue did not restore a pending draft after component recreation.

- Command: `pnpm vitest run src/features/comments/__tests__/CommentThread.spec.ts`
- RED: initial suite import failed because `CommentThread.vue` did not exist.
- RED: durable pending test rendered 0 pending rows instead of 1 after submission/recreation.
- GREEN: 7/7 passed for chronological semantics, author-only deletion, validation focus, saved dedupe, failed Retry/Discard, retained tombstones, closed composer, and pending reload projection.

### Global Activity

Production break named: the Activity tab was still a placeholder and had no account-wide store, filtering, queue projection, or validated destinations.

- Command: `pnpm vitest run src/features/activity/__tests__/ActivityPage.spec.ts`
- RED: suite import failed because the page/store did not exist.
- GREEN: 6/6 passed for stable newest-first order/ties, self-actions, non-mutating filters, validated links, pending reload projection, and conflict suppression.

### Notifications

Production break named: no notification center, unread UI, read queue projection, preference UI, or failure recovery existed.

- Command: `pnpm vitest run src/features/notifications/__tests__/NotificationCenter.spec.ts`
- RED: suite import failed because `NotificationCenter.vue` did not exist.
- GREEN: 4/4 passed for principal-owned order/unread semantics, idempotent mark-one, inclusive mark-all cutoff behavior, durable preferences, and failed Retry/Discard.

### Semantic expense links and group wiring

Production break named: expense rows were not links, and naively wrapping rows would nest retry/conflict actions inside an anchor.

- Command: `pnpm vitest run src/components/__tests__/ExpenseRow.spec.ts`
- RED: the expected semantic `.expense-row__body` anchor was absent.
- GREEN: 23/23 passed with a non-action body link and all mutation controls outside it.
- Command: `pnpm vitest run src/features/groups/__tests__/GroupDetailPage.spec.ts -t "links durable journal"`
- RED: durable journal row had a `div` body and no destination.
- GREEN: durable IDs link to the Groups-origin detail; `pending:` IDs remain noninteractive.

### Edit return and authorization

Production break named: edit Cancel/Save returned to the stack root, and a direct edit URL rendered for a non-author/non-manager.

- Command: `pnpm vitest run src/features/expenses/__tests__/ExpenseEditorPage.spec.ts -t "returns an"`
- RED: 4/4 origin cases returned to stack roots.
- GREEN: 4/4 return to the exact originating detail route.
- Command: `pnpm vitest run src/features/expenses/__tests__/ExpenseEditorPage.spec.ts -t "fails closed when a direct edit"`
- RED: unauthorized editor rendered with Save enabled and no alert.
- GREEN: editor fails closed before initialization.

## Fix round 1 RED-first evidence

The review hardening pass closed every independent finding without deferring behavior to Task 11 or Task 12.

### Durable data, queue, Firebase, and decoding boundaries

Production breaks named: demo authoritative results disappeared with a new repository instance; prepared envelopes could drift beyond declared receipt promotion; a frozen session could leak a stale resume rejection; tombstones polluted Firebase live aggregates; notification unread reads used inconsistent representations; timeline ties depended on host locale; Firebase feeds fetched all documents before paging; and revision/activity decoders accepted cross-field corruption.

- Command: `pnpm vitest run src/data/__tests__/auditRepositories.spec.ts src/data/__tests__/task7Decoders.spec.ts src/data/__tests__/task7QueueSession.spec.ts src/data/__tests__/firebaseRepository.spec.ts`
- RED: 15 failed / 26 passed across the four review suites.
- GREEN: 4 files passed / 41 tests passed.
- Result: demo state and replay ledgers are versioned and rehydrated across repository instances; queue schema v5 persists `submittedAt`, observes resume failures, and restricts prepared changes to position-preserving local-to-remote receipt promotion; Firebase live queries exclude tombstones, use one `readAt: null` unread representation, server ordering/limits/cursors, and filter-aware continuation; strict decoders enforce IDs and action/kind invariants.

### Strict route context, Activity, notifications, and ordering

Production breaks named: repeated query scalars were accepted inconsistently; pending Activity invented occurrence/epoch times; pagination and authoritative unread totals were absent; notification preferences appeared enabled before a successful load; and punctuation/case ties used locale-dependent ordering.

- RED: 4/4 origin routes accepted repeated `groupId`; 3 Activity tests failed; 3 notification tests failed.
- GREEN: repeated `groupId` fails closed in all four origins; Activity pagination/timestamps/byte ordering passed; all 7 notification tests passed with server cursor continuation, authoritative unread count, disabled unknown preferences, and explicit load retry.

### Comment, keyboard, expense deletion, audit, and attachment recovery

Production breaks named: a pre-queue receipt claim failure left the composer locked; attachments exposed internal references and could not be removed; durable comment and expense deletions were not rehydrated; delete conflicts had no resolution; keyboard avoidance scrolled the component instead of Ionic's real scroll host; and audit history lacked usable diffs/snapshots.

- RED: 3 comment recovery tests, 1 non-zero-layout Ionic scroll-host test, and 5 expense detail tests failed. A deeper full-snapshot assertion then failed once before completion.
- GREEN: 10 CommentThread tests, 6 keyboard tests, and 13 ExpenseDetail tests passed.
- Result: claim failure resets submission state; attachments show filename/durability/preview availability with Remove and never render storage refs; exact pending/failed/conflicted delete operations survive recreation with Retry/Discard/reload/delete-latest controls and duplicate suppression; keyboard calculations target `ion-content.getScrollElement()`; audit rows have concise diffs and expandable full snapshots.

### Group Activity integration

Production breaks named: Group Activity omitted durable queue projections, reused the expense month heading, did not refresh on Ionic view entry, and exposed undersized inline links.

- RED: 2/2 focused Group Activity tests failed.
- GREEN: 2/2 passed with the shared queue projection, `submittedAt` date groups, `onIonViewWillEnter` refresh, and a full-width link body with a minimum 44px target.

## Fix round 2 RED-first evidence

This review pass closed all ten independent findings without deferral.

### Preparation immutability and same-principal queue races

Production breaks named: a preparer could mutate the stored envelope by reference and thereby defeat semantic-equivalence validation; a frozen queue could also persist its old pending snapshot after a newer same-principal queue had already stored a fresh completion.

- Command: `pnpm vitest run src/data/__tests__/task7QueueSession.spec.ts`
- RED: 2 focused tests failed: in-place preparation changed the authoritative command intent, and the released old queue replaced the newer fresh shared-storage record with pending state.
- GREEN: 19/19 passed after preparing independent clones against an untouched snapshot and removing the stale-session write. The original pending record remains durable/adoptable when no newer session has reconciled it.

### Exact comment recovery

Production breaks named: failed comment drafts remained editable even though Retry replayed the immutable stored body/attachments; conflicted adds left a disabled composer with no recovery; and comment-delete conflict acknowledgement could precede a failed repository reload.

- Command: `pnpm vitest run src/features/comments/__tests__/CommentThread.spec.ts`
- RED: the focused lock and conflicted-add checks both failed; the reload-failure regression was added to the same cluster and retained the expected conflicted record until recovery.
- GREEN: 13/13 passed. Pending/failed/conflicted drafts lock the exact displayed body and attachments with explicit copy, failed drafts retain Retry/Discard, conflicted adds have an explicit discard-and-start-again action, and delete conflicts are acknowledged only after the authoritative comments/user reload succeeds.

### Rehydrated deletion and ISO audit money

Production breaks named: a deletion restored as pending could stay in a saving state after its queue result became fresh/stale, and audit snapshots assumed every currency used two fraction digits.

- Command: `pnpm vitest run src/features/expenses/__tests__/ExpenseDetailPage.spec.ts`
- RED: 1 rehydrated-delete reconciliation test and 3 exponent table cases (JPY, BHD, CLF) failed.
- GREEN: 17/17 passed. Exact durable delete results immediately apply their tombstone, reconcile retained audit data, close comments, and leave saving state; audit totals and allocations use the shared ISO-exponent formatter.

### Filter-aware Activity pagination

Production break named: filtering only the already-loaded all-activity page could falsely show no results when matching records existed after the first 100 rows.

- Command: `pnpm vitest run src/features/activity/__tests__/ActivityPage.spec.ts`
- RED: the selected-filter server query/pagination regression failed.
- GREEN: 10/10 passed. Filter changes load their own server page and cursor; continuation remains bound to the selected filter and stale results cannot merge after a filter change.

### Notification generation and durable failure recovery

Production breaks named: an older load-more request could merge after a newer authoritative refresh, and a recreated component hid persisted failed notification operations because its transient error string was empty.

- Command: `pnpm vitest run src/features/notifications/__tests__/NotificationCenter.spec.ts`
- RED: 2/2 new regressions failed.
- GREEN: 9/9 passed. Root refresh/unmount invalidates page generations, and durable failed operations independently restore their message plus Retry/Discard actions.

## Fix round 3 RED-first evidence

This interleaving pass closed all three independent findings without deferral.

- Focused command: `pnpm vitest run src/data/__tests__/task7QueueSession.spec.ts src/features/activity/__tests__/ActivityPage.spec.ts src/features/notifications/__tests__/NotificationCenter.spec.ts -t "late network failure|deferred old-filter page|old cursor while"`
- RED: 3 failed / 38 skipped, with one intended failure in each affected file.
- GREEN: 3 passed / 38 skipped after the scoped guards.

### Frozen-session rejection normalization

Production break named: when an old session froze while its repository call was in flight, a later ordinary network/server rejection bypassed the post-call active check and persisted `failed` over a newer same-principal `fresh` result.

- RED: the shared-storage record changed from the replacement session's `fresh` completion to the frozen session's late `network` failure.
- GREEN: the regression passed after guarded repository calls began checking session activity on both fulfillment and rejection. A post-freeze rejection is normalized to `StaleAppSessionError`, so the queue leaves the durable record untouched and adoptable.

### Activity filter/page generations

Production break named: changing filters while an old page was deferred retained the old cursor and loading-more state, so continuation was not synchronously bound to the new filter root.

- RED: `nextCursor` still referenced the old all-activity page and `isLoadingMore` remained set during the comments transition.
- GREEN: the regression passed after every root/filter load invalidated the page generation, synchronously cleared its cursor/loading-more state, and blocked continuation until the exact root/filter generation completed. Deferred old-filter pages cannot merge.

### Notification refresh/page generations

Production break named: an authoritative refresh left the old cursor enabled until completion, allowing a page request started during that refresh to use and later merge the old cursor.

- RED: the in-flight refresh started a cursor request for `notification-c`, the prior root's cursor.
- GREEN: the regression passed after refresh synchronously invalidated/cleared continuation and pagination required a completed root generation plus the exact cursor snapshot. The next accepted page used only the refreshed root cursor.

## Final GREEN verification

### Focused Task 7 matrix

Command:

`pnpm vitest run src/data/__tests__/auditRepositories.spec.ts src/data/__tests__/task7Decoders.spec.ts src/data/__tests__/task7QueueSession.spec.ts src/app/__tests__/router.spec.ts src/features/expenses/__tests__/ExpenseDetailPage.spec.ts src/features/expenses/__tests__/ExpenseEditorPage.spec.ts src/features/comments/__tests__/CommentThread.spec.ts src/features/activity/__tests__/ActivityPage.spec.ts src/features/notifications/__tests__/NotificationCenter.spec.ts src/components/__tests__/ExpenseRow.spec.ts src/features/groups/__tests__/GroupDetailPage.spec.ts`

Fix-round-1 focused result: 14 files passed, 223 tests passed.

Fix-round-2 affected-suite command:

`pnpm vitest run src/data/__tests__/task7QueueSession.spec.ts src/features/comments/__tests__/CommentThread.spec.ts src/features/expenses/__tests__/ExpenseDetailPage.spec.ts src/features/activity/__tests__/ActivityPage.spec.ts src/features/notifications/__tests__/NotificationCenter.spec.ts`

Fix-round-2 affected-suite result: 5 files passed, 68 tests passed.

Fix-round-3 affected-suite command:

`pnpm vitest run src/data/__tests__/task7QueueSession.spec.ts src/features/activity/__tests__/ActivityPage.spec.ts src/features/notifications/__tests__/NotificationCenter.spec.ts`

Fix-round-3 affected-suite result: 3 files passed, 41 tests passed.

### Full suite

- Command: `pnpm test`
- Result: 36 files passed, 450 tests passed.

### Static/build checks

- Command: `pnpm typecheck`
- Result: passed (`vue-tsc --noEmit`).
- Command: `pnpm build`
- Result: passed; 316 modules transformed. Vite emitted only its existing large-chunk advisory.
- Command before fix-round-3 commit: `git diff --check ca44a68`
- Result: passed with no whitespace errors.
- Command after fix-round-3 implementation commit: `git diff --check ca44a68..HEAD`
- Result: passed with no whitespace errors.

No browser or Playwright validation was run because the Task 7 brief explicitly prohibited it.

## Self-review

- Verified one repository/session/queue remains scoped to the complete `{mode, projectId, uid}` principal; all new surfaces pass through the stale-session guard.
- Verified expense edit/delete sends the exact hydrated revision and demo conflicts have zero revision/activity/comment/notification side effects.
- Verified author/manager permission is enforced both at the repository boundary and at direct-route UI initialization; unknown capability/author data fails closed.
- Verified comment delete preserves immutable creation operation identity while its delete activity carries the delete operation identity.
- Verified local comment attachments are claimed by the command and the prepared execution mapping is durable without rewriting the original command envelope.
- Verified Activity and notifications reconcile by operation/notification identity, retain durable pending/failed intent, and do not convert conflicts into canonical audit.
- Verified notification read state remains distinct from sync state and preferences do not mutate Activity or existing notification history.
- Verified all four detail destinations are derived locally from validated structured IDs; arbitrary stored URLs/HTML are never used.
- Verified expense/action links contain no nested Retry/Discard/conflict controls and pending add IDs are not links.
- Verified one page `h1`, labelled lists/sections, valid canonical times, textual states, 44px controls, safe-area/VisualViewport handling, bounded tablet detail layout, and reduced-motion CSS.
- Verified Firebase mutations continue to return explicit typed unavailable results; no cloud save or provider behavior is faked.

## Residual boundaries

- Task 11 must supply authenticated Firebase callable mutations. Task 7 intentionally does not claim Firebase writes succeed.
- Email/push delivery providers are outside Task 7. Preferences are durable repository state affecting future delivery only; no provider is simulated.
- Task 12 may refine broader visual polish and app-wide responsive composition. Task 7 includes the required bounded tablet seam, mobile safe areas, Dynamic Type wrapping, and reduced-motion behavior.
- Build output retains Vite's non-failing large-chunk advisory; code-splitting optimization is outside this audit slice.
- The user-owned untracked app icon remains untouched.
