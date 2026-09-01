# Split Unwise release verification

Current hosted Firebase load and mobile-group feature source: `3ba53c1e6b716ba8b01265e540b044d4d1ac7b3f`

The recurring-expense work described below is a local release candidate. Task 5 intentionally did not deploy or mutate the Firebase project, so hosted recurrence is not claimed until the new rules and Hosting build are deployed and `pnpm test:hosted` passes against that exact release.

Date: 2026-09-01 (America/Chicago)

## Task 5 local release gate

| Check | Result | Evidence |
| --- | --- | --- |
| Unit and component suite | Pass | `pnpm test`: 83 files passed, 7 skipped; 788 tests passed, 54 skipped |
| Type safety | Pass | `pnpm typecheck` |
| Firestore rules | Pass | `pnpm test:firebase`: 22 emulator-backed rules tests, including deterministic recurrence, removed-participant denial, exact-frontier edits, revision-checked cancellation, and the existing expense/comment/settlement/notification boundaries |
| Spark Auth/group/ledger flows | Pass | `pnpm test:firebase`: 7 emulator-backed flows, including recurrence concurrency/replay and occurrence/future/cancellation semantics |
| Functions and service behavior | Pass | `pnpm test:firebase`: 18 Functions/service tests; 47 total Firebase emulator checks across rules, Spark flows, and Functions |
| Disposable hosted proof | Prepared, not executed | `pnpm exec vitest run src/data/__tests__/productionHosted.spec.ts`: one test intentionally skipped without fixture credentials. Run `pnpm test:hosted` only after the matching rules and Hosting deployment. |
| Production web bundle and artifact policy | Post-commit gate | Run `VITE_BUILD_COMMIT=$(git rev-parse HEAD) pnpm build` from the release commit; the ignored Task 5 report records the exact output. |
| Reference-rate provider | Prior hosted evidence, not rerun | The prior live ECB-backed USD/EUR response matched the strict contract and allowed the Capacitor origin through CORS. |
| Capacitor synchronization | Post-commit gate | Run `pnpm exec cap sync ios` after the exact-commit web build. |
| Native compile | Post-commit gate | Run `pnpm ios:build`; unsigned Debug build for a generic iOS simulator. |
| Simulator package | Prior release evidence | `artifacts/Split-Unwise-c76dde2-Simulator.zip`; embedded source commit `c76dde21e688bc4b7063b6487fc2ab3e6a7cb041`; SHA-256 `5dbadcf2a281ba9c3b383e4425a9b381b6111462399984c23c761d4645dc8bf9` |
| Firebase Hosting | Unchanged | No deployment in Task 5. The production domains and build metadata still represent the hosted source identified above. |
| Whitespace integrity | Pass | `git diff --check` and `git diff --cached --check` |

In the prior release, the largest natural framework chunk was 1,133,240 bytes raw and about 242 KB gzip, below the enforced 1.2 MB raw / 300 KB gzip ceilings. Manually partitioning Ionic/Vue vendor cycles caused runtime failures in JavaScriptCore, so the project keeps Vite's valid framework graph while retaining route-level lazy loading. Task 5 rechecks the current committed bundle through the enforced artifact policy after commit.

## Native runtime evidence

The compiled `App.app` was installed and launched, not inferred from a web build.

| Surface | Result | Evidence |
| --- | --- | --- |
| iPhone 14, 390 × 844 points, light | Pass | [Screenshot](verification-assets/iphone14-light.png) |
| iPhone 14, 390 × 844 points, dark | Pass | [Screenshot](verification-assets/iphone14-dark.png) |
| iPhone 14, maximum Dynamic Type | Pass with expected scroll reflow | [Screenshot](verification-assets/iphone14-dynamic-type-max.png) |
| iPad Air 11-inch, portrait | Pass for the native home shell | [Screenshot](verification-assets/ipad-air-11-light.png) |
| Safe areas and home indicator | Pass on the observed iPhone and iPad surfaces | Same screenshots |
| App startup failure handling | Pass by fault injection during diagnosis | A caught startup failure produces a visible recovery surface rather than a blank view |

The final iPhone simulator identifier was `DDFB4C2D-624E-4783-BBD5-1EAC2EE9A904`; the iPad simulator identifier was `348D09B8-FC5D-4936-8ED8-69FC1D92AF5C`. Both ran the Apple iOS 26.5 simulator runtime installed through Xcode.

The prior P1 native build was installed on the iPhone simulator, launched as bundle `app.splitunwise.mobile`, and rendered the real Firebase Email/Password sign-in surface at 390 × 844 points. The new `c76dde21e688bc4b7063b6487fc2ab3e6a7cb041` native build compiled for the generic simulator and its packaged `App.app` contains that exact source identifier; this release did not repeat interactive simulator installation. Native Auth uses explicit local persistence without a browser popup resolver, avoiding the WKWebView OAuth-helper startup hang caught during release verification.

## Add Expense and recurring mobile evidence

The local demo was inspected at 390 × 844 after the Add Expense polish and recurring-management work:

| Surface | Observed evidence | Boundary |
| --- | --- | --- |
| Compact Add Expense editor | [Screenshot](../.artifacts/design-audit/add-expense-2026-09-01/04-add-expense-polished.png) | Visible hierarchy, inline rows, disclosure affordances, and no observed horizontal clipping |
| Ionic recurrence card modal | [Screenshot](../.artifacts/design-audit/add-expense-2026-09-01/05-recurrence-card-modal.png) | Visible card-modal presentation and controls; swipe physics and dirty-dismiss behavior were not proven by the image |
| Recurring management screen | [Screenshot](../.artifacts/design-audit/add-expense-2026-09-01/06-recurring-expenses-mobile.png) | Visible status, amount, schedule, next date, edit, and stop actions; no hosted transaction behavior is inferred |

The complete before/after notes are in the [design audit](../.artifacts/design-audit/add-expense-2026-09-01/audit.md). These are static local-demo screenshots, not hosted Firebase or installed-native runtime evidence. Keyboard movement, VoiceOver, Dynamic Type on these specific screens, file-picker behavior, swipe dismissal, and physical-device interaction remain outside their proof boundary.

## PWA, offline, and update behavior

- A real Workbox service worker precaches only the public shell and local build assets. It has no background-sync owner for financial commands.
- Service-worker registration is production-web-only and disabled inside Capacitor.
- A waiting update is explicit. Pending, failed, or conflicted commands and device-only receipt drafts block activation; choosing Later preserves the waiting worker.
- `/__/`, `/api/`, emulator URLs, the demo Firebase project identity, source maps, and the 1024-pixel source icon are excluded from the release artifact.
- Hosting policy makes only hashed `/assets/**` immutable. The HTML shell, manifest, service worker, Workbox loader, startup diagnostics, icons, and build metadata revalidate.
- Global offline, update-ready, offline-ready, and update-blocked status is rendered in an announced app-level surface.
- The Hosting CSP permits only the exact `https://api.frankfurter.dev` reference-rate origin in addition to the existing Firebase origins. Rate responses are not runtime-cached by the service worker.

## Reference currency conversion

- Group actions now open a native-styled conversion screen with a preferred target-currency picker, dated reference values, retryable per-currency failures, and reduced-motion-safe entry animation.
- The provider accepts only a matching requested pair, a real ISO effective date, and a finite positive rate from the European Central Bank through Frankfurter.
- Conversion uses rational `BigInt` arithmetic and both ISO currency exponents; the release suite explicitly covers USD-to-JPY zero-decimal conversion.
- Converted values are informational previews only. The feature does not create commands, relabel money, combine currencies, alter balances, or change settlement values.

## Debt simplification

- Group settings expose a native Ionic toggle for the saved Simplify Debts preference. Any active member may toggle it; only a manager may change the default split.
- A toggle is a versioned, replay-safe `group.simplify-debts` command. It atomically advances settings and balance revisions, preserves the saved default split and both pairwise/simplified plans, and records deterministic group activity.
- Balances open the group's saved plan by default while keeping both plans inspectable. The behavior remains per-currency and never nets unlike currencies together.
- Domain, demo persistence/quarantine, strict queue hydration, Firebase decoding, UI permissions, saved-plan selection, transaction replay, and stale-revision conflict behavior are covered by the release suites.

## Recurring expenses

- Add Expense can create weekly, fortnightly, monthly, or yearly recurrence. On Spark, the source expense and active template are created atomically and replay to the same records.
- An authorized client catches up when the group detail or Recurring screen opens. A visit materializes at most 24 due occurrences; the Recurring screen reports when more work remains and exposes an explicit retry.
- Each occurrence ID is derived from the template ID and ISO due date. Firestore advances the template and writes the occurrence/activity atomically, so concurrent clients converge on one ledger entry.
- An occurrence-only edit leaves the template unchanged. A future-series edit must target the exact current source/occurrence frontier and is authorized for that expense's author or a group manager. Cancellation requires the exact template revision and leaves the source plus every posted occurrence intact.
- Rules revalidate all template payers and split participants for every materialization. If an involved participant is removed, later occurrences stop posting; historical expenses remain readable ledger history.
- Spark has no unattended scheduler. Catch-up happens only after an authorized client opens the relevant screen. True background scheduling requires the Functions scheduler on a billed Firebase project.
- Unit, emulator, rules, and UI tests cover these semantics. The disposable hosted proof now exercises a past-due two-user series, concurrent catch-up, cross-user semantic replay, occurrence/future edits, manager cancellation, retained history, no post-cancellation catch-up, and the additional activity-derived notifications. It was compiled in its disabled/skipped mode during local preparation but was not executed because this task did not deploy the required client and rules.

## Hosted release evidence

- Production: `https://split-unwise-aditya.web.app` and `https://split-unwise-aditya.firebaseapp.com`.
- Both hosts returned `200` for `/`, `/manifest.webmanifest`, `/sw.js`, `/tabs/activity`, `/build-info.json`, and a hashed JavaScript asset.
- Root and nested app-shell responses have `no-cache, no-store, must-revalidate`; the manifest revalidates; the service worker is non-cacheable; hashed assets retain `public, max-age=31536000, immutable`.
- Root and nested route bodies were byte-identical, proving the Hosting rewrite. The final build metadata is checked against the deployed source commit after each release.
- The reviewed CSP, `X-Content-Type-Options`, `X-Frame-Options`, `Referrer-Policy`, and `Permissions-Policy` headers were observed on both production domains.
- Hosting auto-init is the only source of production Web SDK configuration. The Capacitor shell uses the same endpoint through an explicit `Access-Control-Allow-Origin: *` rule; the payload contains Firebase's public app metadata only.

## Production identity and shared-group evidence

- Firebase Authentication was initialized remotely and verified as Identity Platform subtype with Email/Password enabled, passwords required, Google enabled, and both production domains authorized.
- A live production SDK run created an owner and a friend as temporary Auth accounts in separate Firebase app sessions. The owner bootstrapped a profile, created a complete group bundle, and generated a fragment-only invitation capability. The friend bootstrapped a profile, inspected the invitation, accepted it atomically, and read the two-member group. A fresh owner session then read the same persisted group.
- A second live production SDK run created two fresh temporary Auth accounts. The owner added a $24.00 immutable expense split equally with the friend, retried the identical operation, and observed one saved expense. Both accounts independently read the same $12.00 friend-to-owner pairwise and simplified debt derived from the immutable ledger; no writable balance projection was involved.
- A third live production SDK run exercised the deployed `212fb1751a0ad38ae5e5f96dbbb6931c8bf03351` rules and client. The friend could read but not edit the owner's expense. The owner changed the total from $24.00 to $30.00, replayed the same edit without another revision, and both accounts independently read revision 2 and the same $15.00 debt. Delete/replay produced revision 3, removed the item from the live journal, reduced both balance plans to empty, and retained created/updated/deleted immutable history.
- A fourth live production SDK run exercised the deployed `ce4920e5035abe8f1e48c11ed22fa29338d3b900` comment path. The friend added and replayed a comment on the owner's live expense. The owner read the same comment and immutable group activity but was denied author-only deletion. The friend soft-deleted and replayed the comment; its tombstone plus both added/deleted activity events remained readable.
- A fifth live production run reproduced the login blocker through the real Firebase Auth service. Firestore correctly persisted `avatarUrl: null` for accounts without a photo, but the member decoder incorrectly required a non-empty string, causing authenticated session and member-list initialization to fail. Source `c76dde21e688bc4b7063b6487fc2ab3e6a7cb041` treats the schema-valid null as no avatar. The rerun created two accounts, signed out and back in, created a group, accepted its invitation as the second user, and decoded both members from a fresh owner repository session.
- A sixth live production run exercised the deployed `b08e05bae101944ab82f534661fe993229f595ad` client and rules. The two-account flow loaded the group, cached profile, two members, edited expense, and immutable activity in parallel below the 10-second hosted assertion. It then recorded and replayed a partial $5.00 manual settlement, voided and replayed the void, and read both immutable settlement activity events.
- A seventh live production run exercised the deployed `6a655eadaa5580b7b1a486ff74c975ab20b86885` client and rules. Four friend-authored expense and settlement events became owner notifications, while the friend received no self-notifications. The owner saw unread count four, replayed one individual read, replayed an inclusive read-all cursor, and then saw zero unread. The test completed in 20 seconds against Hosting and real Auth/Firestore.
- An eighth live production run exercised feature source `3ba53c1e6b716ba8b01265e540b044d4d1ac7b3f` against Hosting and real Auth/Firestore. Existing-profile bootstrap, session group reuse, lazy Activity, and the rules-validated current edited-expense projection all passed. The combined group/profile/two-member/edited-expense/activity read measured 127 ms; the complete two-account group, expense, settlement, and notification proof completed in 17.9 seconds.
- The raw 256-bit invitation token stays in the URL fragment and is stripped immediately. Only its SHA-256-derived document ID is stored; the share URL uses the fixed `/invite/join` path so the capability is not placed in request logs.
- The load/mobile verification removed the retained baseline fixture and both new hosted proof fixtures after screenshots were captured. Recursive group and user trees plus the three invitations were deleted; Firebase MCP then returned zero matching proof groups, invitations, or Auth users across all six temporary accounts.

## Accessibility and interaction evidence

- The production group detail, expanded More actions, and lazy Activity surfaces were inspected at 390 x 844 after the mobile fix. The route now has one valid Ionic page root; header/back/settings controls, the sticky Expenses/Activity switch, and the floating add-expense action remain usable. Four primary actions fit without clipping, secondary actions expand in a native tray, and expense rows preserve a readable description plus one compact financial column. The final hosted navigation produced zero console errors or warnings. Evidence is under [mobile-audit](../output/playwright/mobile-audit/).
- Group navigation reuses the document already loaded by the overview, coalesces duplicate same-group reads, reveals the group shell before journal completion, and does not request Activity until that segment is selected. Existing-account profile bootstrap avoids a transaction, while edited expense heads serve a rules-validated projection without a second revision read.
- Native Dynamic Type was exercised at the maximum simulator setting. Content reflows and remains scrollable; the persistent add button can overlay content while scrolling, consistent with a floating action control.
- Interactive controls added or reviewed in this task use at least 44-point targets. Text labels previously below `0.7rem` were raised.
- Dark, high-contrast theme tokens, visible focus rings, and `prefers-reduced-motion` fallbacks are present. The reduced-motion rules remove custom transitions and transforms.
- Camera and photo-library purpose strings and an iOS privacy manifest are in the native bundle.
- Native haptics use `@capacitor/haptics`; browser vibration is only the web fallback.

## Evidence boundaries

The iPad screenshot proves the home shell only; the group detail now deliberately uses a single routed Ionic page on every viewport, so a separate group master/detail presentation is not claimed. VoiceOver traversal, Full Keyboard Access, Switch Control, physical-device haptics/camera, landscape tablet behavior, keyboard-driven sheets, and same-viewport reference-image comparison still require an interactive device session. They are not claimed as passed.

Hosting, Firestore, and Auth configuration are live as recorded in [firebase-deployment.md](firebase-deployment.md). Real Firebase account creation, sign-in, profile persistence with and without an avatar, group creation, invitation acceptance, two-user visibility, sign-out/in persistence, expense add/edit/delete replay, immutable revision history, shared comment add/delete replay, group/account activity aggregation, shared derived balances, audited manual settlement record/replay/void/replay, cross-account in-app notifications, and individual/read-all notification replay are production-proven for the currently hosted source. The settlement repository validates the current derived debt basis before writing; Firestore rules validate the participants, amount, replay identity, atomic activity, and authorized void but do not independently aggregate the entire ledger. The Spark recurrence path is implemented and emulator-proven in the local release candidate, but it is not production-proven because Task 5 did not deploy or run the live proof. Cloud Functions and Storage could not be provisioned on the project's current no-billing tier, so provider-confirmed transfers, receipt attachment/OCR, server-maintained account projections, email/push delivery, and truly unattended recurring scheduling remain unavailable. Interactive Google OAuth, hosted install UI, cold-offline navigation, and Cache Storage inspection remain unobserved.
