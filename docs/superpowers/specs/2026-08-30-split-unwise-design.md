# Split Unwise Product And System Design

**Date:** 2026-08-30
**Status:** Approved for implementation by the user's instruction to build the selected option without another approval gate.

## Outcome

Build Split Unwise as a mobile-first Ionic Vue application that supports the complete shared-expense lifecycle: accounts, friends, groups, expenses, every documented split method, balances, debt simplification, settlements, recurring expenses, comments, attachments, search, exports, notifications, activity history, receipt itemization, analytics, multiple currencies, group defaults, offline work, and accessible iOS-quality interaction. Deploy the web/PWA build to a dedicated Firebase project and keep the code ready for Capacitor iOS packaging.

The selected visual target is the refined Lake House Weekend group journal at:

`/Users/adityapatel/.codex/generated_images/01a050b8-0173-7fb2-afa0-8fc1aef33a3d/exec-762153cd-21ae-4109-8839-b6e16212bfac.png`

## Product Principles

- Use familiar expense-sharing jobs and native iOS conventions while keeping Split Unwise's name, lilac/periwinkle palette, typography, component composition, copy, icons, and imagery original.
- Make every financial state explicit in words; color is supporting information only.
- Treat addition, editing, settlement, and deletion as auditable commands rather than silent mutations.
- Keep amounts visually stable. No count-up animations, celebratory motion, or layout shifts around money.
- Preserve a useful offline experience: cached reads, local drafts, pending writes, retry, and conflict visibility.
- Premium-equivalent features are available in-product without a paywall. External providers may still require provider credentials or commercial approval.

## Primary Navigation

The app uses four independent Ionic tab stacks:

1. **Home** — personal balance overview, friends, recent groups, search, add expense.
2. **Groups** — group list, group journal, balances, totals, charts, recurring expenses, settings.
3. **Activity** — auditable changes, comments, payment and notification history.
4. **Account** — profile, appearance, currencies, notifications, exports, offline status, data controls.

Add Expense is a floating action in the current stack, not a destination tab. Expense, group, member, search, and settlement pages are durable routes. Payer, participant, category, split-method, date, filter, and attachment choices use Ionic sheets.

## Core Journeys

### Create And Share A Group

The user creates a named group, chooses a type and cover, invites friends by email or share link, chooses a base currency, optionally enables debt simplification, and optionally defines a default split. The group opens to the selected journal design with its cover, overlapping monogram, balance sentence, compact action rail, expense/activity segment, and month-grouped ledger.

### Add Or Edit An Expense

The full-screen composer collects description, amount, currency, payer or multiple payers, group/friends, date, category, notes, attachment, recurrence, and one split method. Supported methods are:

- equal shares;
- exact amounts;
- percentages;
- weighted shares;
- adjustment, where one or more fixed adjustments are applied before the remainder is split;
- itemized receipt lines assigned to one or more participants.

The editor continuously validates that allocations equal the expense total after currency rounding. Saving immediately shows a pending row, writes an immutable activity event, and resolves to posted, failed, or conflicted state.

### Review Balances And Settle

Balances show pairwise obligations and an optional simplified repayment plan. Settle Up selects debtor, creditor, currency, amount, date, note, and method. Recording cash or an external transfer updates the ledger. Provider-specific payment options are represented through a provider interface so PayPal/Venmo/bank-like links can be configured without coupling the core ledger to one provider.

### Search, Analyze, And Export

Full-history search covers description, notes, group, friend, category, amount, and date range. Totals distinguish paid, owed share, settlements, and net change. Charts show balance over time, category spending, monthly spend, and member contribution. Export supports CSV and JSON for a group or the entire account.

### Receipts And Recurrence

Users may capture or upload a receipt. The app stores the image, creates editable OCR suggestions, and requires confirmation before itemized allocations affect the ledger. Recurring templates support weekly, fortnightly, monthly, and yearly schedules; edits may apply to one occurrence or the future series.

## Information Architecture And Components

### Application Shell

- `AppShell` owns Ionic mode, router outlet, safe areas, global toasts, offline banner, and reduced-motion behavior.
- `TabsShell` owns the four tab stacks and the tab bar.
- `AppFab` launches the current stack's expense route and provides light haptic feedback where supported.

### Shared Financial Components

- `MoneyAmount` formats minor-unit integers with currency and debt direction.
- `ExpenseRow` renders a stable date/category/description/amount grid and sync state.
- `BalanceSummary` renders total owed/owing/settled state in text and color.
- `MemberAvatar` and `GroupAvatar` render image or deterministic initials.
- `ActionRail` provides Settle Up, Balances, Totals, Charts, Recurring, Search, and Export actions.
- `SyncStatus` exposes saved, pending, failed, stale, and conflicted states.
- `SplitEditor` owns equal, exact, percentage, shares, adjustment, and itemized allocation editors.
- `ReceiptReview` owns receipt preview, editable OCR lines, taxes/tip, and assignments.
- `ChartPanel` owns accessible SVG/canvas-free data visualizations using semantic HTML and the selected chart library.

## Client Architecture

Use Vue 3, TypeScript, Ionic Vue, Vue Router, Pinia, Firebase's modular SDK, and Vitest. Domain logic remains framework-independent.

```text
src/
  app/             app shell, routes, boot, theme
  domain/          money, splits, balances, recurrence, exports
  data/            repository contracts, Firebase and demo adapters
  features/        auth, home, groups, expenses, activity, analytics, account
  components/      reusable visual components
  composables/     motion, network, haptics, keyboard, dialogs
  demo/            deterministic Lake House seed data
```

Pages call feature stores or use cases; they do not call Firestore directly. Repository interfaces permit a deterministic demo adapter when Firebase environment variables are absent and a Firebase adapter when configured.

## Firebase Architecture

### Services

- **Authentication:** email/password plus Google sign-in on web; provider ports allow Apple sign-in in Capacitor.
- **Cloud Firestore:** users, friendships, groups, memberships, expenses, settlements, recurring templates, comments, activity events, invitations, notification preferences, and device tokens.
- **Cloud Storage:** group covers, avatars, receipts, and comment attachments.
- **Cloud Functions:** invitation acceptance, recurring occurrence materialization, receipt OCR adapter, push fan-out, export generation for large datasets, and ledger invariant checks.
- **Hosting:** the Ionic PWA with single-page rewrites and immutable hashed assets.

### Collections

```text
users/{userId}
friendships/{friendshipId}
groups/{groupId}
groups/{groupId}/members/{userId}
groups/{groupId}/expenses/{expenseId}
groups/{groupId}/settlements/{settlementId}
groups/{groupId}/recurring/{templateId}
groups/{groupId}/comments/{commentId}
groups/{groupId}/activity/{eventId}
invitations/{invitationId}
users/{userId}/notifications/{notificationId}
users/{userId}/devices/{deviceId}
```

All money is stored as integer minor units with an ISO 4217 currency code. Expense allocations are immutable snapshots. Edits create a new revision and activity event. Group membership is the authorization boundary. Cross-group queries use user-visible projection documents or collection-group indexes rather than broad reads.

### Security Invariants

- A user may read a group only while they are an active member.
- A user may create expenses only for groups they belong to and only with participants who belong to that group.
- Allocation totals, payer totals, and the expense total must match exactly in minor units.
- Only an expense author or group administrator may edit or delete an expense; every change emits an activity event.
- Storage paths mirror group membership checks and restrict content type and size.
- Client-computed balances are treated as presentation; server-side validation protects authoritative writes.

## Offline And Synchronization

Firestore persistence is enabled on supported browsers. The command layer adds client operation IDs so retried writes are idempotent. Drafts are stored locally before upload. UI sync states are `fresh`, `stale`, `pending`, `failed`, and `conflicted`. Network status only changes guidance; it never claims a write succeeded.

Conflicts retain both the local draft and remote revision. The user can reload the remote version or save the draft as a new revision. Destructive actions are disabled while the target revision is unknown.

## Motion System

- Ionic's iOS push/pop transition is the route default, targeting 300–350 ms.
- The group cover, avatar, title, and balance collapse through transform and opacity only; content does not reflow during the transition.
- The add button scales to 0.97 on press, returns with a restrained spring, and uses a shared-origin transition into the composer when supported.
- Sheets use native breakpoints and dimming; stacked sheets are avoided.
- New or updated expense rows move 8–12 px and fade over 180–220 ms. Amount text never counts or rolls.
- Segment and filter changes use a 140–180 ms cross-fade with stable container height.
- Successful saves use a light haptic and textual confirmation. Errors use visible copy and an optional warning haptic.
- `prefers-reduced-motion: reduce` removes springs, cover interpolation, and non-essential transforms while retaining immediate state changes.

## Accessibility And Responsive Behavior

- iPhone portrait is the primary surface at a 390 × 844 reference viewport.
- iPad uses an Ionic split pane for group/expense master-detail where space permits.
- Touch targets are at least 44 points, labels scale with Dynamic Type, and layouts wrap rather than clip.
- Every icon-only action has an accessible name; debt direction, sync state, and chart values are not conveyed by color alone.
- VoiceOver order follows the visual hierarchy. Sheets restore focus on dismissal. Save and error states use an `aria-live` region.
- The app supports system light/dark appearance and high contrast.

## Error Handling

- Validation failures stay inline next to the owning field and summarize at save.
- Firebase permission, quota, offline, and conflict errors map to actionable user copy.
- Failed commands remain visible with Retry and Discard Draft actions.
- Receipt recognition failures preserve the image and fall back to manual item entry.
- Export failures preserve filters and allow retry.
- Provider payment failures do not create a settlement until confirmation is recorded.

## Testing And Verification

- Unit tests cover minor-unit arithmetic, rounding, every split method, balance aggregation, simplification, recurrence, exports, and conflict/idempotency rules.
- Component tests cover expense composition, split validation, group journal states, settlement confirmation, search, charts, and reduced motion.
- Firestore emulator tests cover group membership, writes, storage access, indexes, and activity emission.
- Browser verification covers 390 × 844 and iPad widths, keyboard behavior, route transitions, sheets, dark mode, offline mode, and accessibility.
- Production deployment is verified by loading the Firebase Hosting URL, navigating the core flow, refreshing a nested route, and confirming Firebase reads/writes with a non-demo account.

## Delivery Boundaries

The Firebase deployment can include the complete product and demoable provider/OCR interfaces. Real bank transfers, PayPal/Venmo settlement confirmation, transactional email, Apple push, and production OCR require provider credentials, legal/commercial approval, paid cloud services, or native signing assets that are not present in the repository. Their adapters and UI remain first-class features; production activation is separately verifiable and must not be claimed from a mock response.

