# Split Unwise release verification

Verified P1 login and shared-group release source: `c76dde21e688bc4b7063b6487fc2ab3e6a7cb041`

Date: 2026-08-31 (America/Chicago)

## Automated release gate

| Check | Result | Evidence |
| --- | --- | --- |
| Unit and component suite | Pass | `pnpm test`: 76 files passed, 6 skipped; 698 tests passed, 33 skipped |
| Type safety | Pass | `pnpm typecheck` |
| Firestore rules | Pass | `pnpm test:firebase`: 11 emulator-backed rules tests, including audited expense mutations plus live-expense-coupled comment/activity add, author-only soft delete, and denied outsider, body edit, standalone activity, closed-expense comment, and physical delete writes |
| Auth/group/invite/expense flow | Pass | Two emulator flows plus a live production run through the real Auth service: two temporary Email/Password accounts, sign-out/in, group creation, private invitation acceptance, owner group reload, and a decoded two-member list |
| Functions and service behavior | Pass | `pnpm test:firebase`: 16 emulator-backed tests |
| Production web bundle | Pass | `pnpm build`: 508 modules transformed; Workbox generated 104 precache entries |
| Artifact policy | Pass | 106 files checked for required icons/shell, source maps, private URLs, hashing, cache boundaries, and JavaScript transfer budgets |
| Reference-rate provider | Pass | Live ECB-backed USD/EUR response matched the strict contract and allowed the Capacitor origin through CORS |
| Capacitor synchronization | Pass | `pnpm exec cap sync ios`; local `dist` copied with no production `server.url` |
| Native compile | Pass | `pnpm ios:build`; unsigned Debug build for a generic iOS simulator |
| Simulator package | Pass | `artifacts/Split-Unwise-c76dde2-Simulator.zip`; embedded source commit `c76dde21e688bc4b7063b6487fc2ab3e6a7cb041`; SHA-256 `5dbadcf2a281ba9c3b383e4425a9b381b6111462399984c23c761d4645dc8bf9` |
| Firebase Hosting | Pass | Both production domains serve the exact release; root, deep link, manifest, service worker, build metadata, security headers, and hashed-asset cache policy were checked live |
| Whitespace integrity | Pass | `git diff --check` and `git diff --cached --check` |

The largest natural framework chunk is 1,133,240 bytes raw and about 242 KB gzip, below the enforced 1.2 MB raw / 300 KB gzip ceilings. Manually partitioning Ionic/Vue vendor cycles caused runtime failures in JavaScriptCore, so the release keeps Vite's valid framework graph while retaining route-level lazy loading.

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
- The raw 256-bit invitation token stays in the URL fragment and is stripped immediately. Only its SHA-256-derived document ID is stored; the share URL uses the fixed `/invite/join` path so the capability is not placed in request logs.
- All temporary Auth accounts, profiles, group trees, projections, invitation documents, expense roots, and immutable versions were deleted after verification. Follow-up Firebase MCP queries returned zero matching Auth users, proof groups, and invitations.

## Accessibility and interaction evidence

- Native Dynamic Type was exercised at the maximum simulator setting. Content reflows and remains scrollable; the persistent add button can overlay content while scrolling, consistent with a floating action control.
- Interactive controls added or reviewed in this task use at least 44-point targets. Text labels previously below `0.7rem` were raised.
- Dark, high-contrast theme tokens, visible focus rings, and `prefers-reduced-motion` fallbacks are present. The reduced-motion rules remove custom transitions and transforms.
- Camera and photo-library purpose strings and an iOS privacy manifest are in the native bundle.
- Native haptics use `@capacitor/haptics`; browser vibration is only the web fallback.

## Evidence boundaries

The iPad split-pane/master-detail contract is component-tested, but the iPad screenshot proves the home shell only; no tap automation was authorized for this pass. VoiceOver traversal, Full Keyboard Access, Switch Control, physical-device haptics/camera, landscape tablet master/detail, keyboard-driven sheets, and same-viewport reference-image comparison still require an interactive device session. They are not claimed as passed.

Hosting, Firestore, and Auth configuration are live as recorded in [firebase-deployment.md](firebase-deployment.md). Real Firebase account creation, sign-in, profile persistence with and without an avatar, group creation, invitation acceptance, two-user visibility, sign-out/in persistence, expense add/edit/delete replay, immutable revision history, shared comment add/delete replay, immutable comment activity, and shared derived balances are production-proven. Cloud Functions and Storage could not be provisioned on the project's current no-billing tier, so settlement, receipt attachment/OCR, recurrence materialization, and account-level activity projection remain unavailable in production. Interactive Google OAuth, hosted install UI, cold-offline navigation, and Cache Storage inspection remain unobserved because browser interaction was not authorized for this pass.
