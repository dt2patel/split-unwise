# Split Unwise release verification

Verified release candidate: `b0cffeef6302bf81fa50e60bf7dffb04e5d0cc3a`

Date: 2026-08-31 (America/Chicago)

## Automated release gate

| Check | Result | Evidence |
| --- | --- | --- |
| Unit and component suite | Pass | `pnpm test`: 71 files passed, 5 skipped; 658 tests passed, 23 skipped |
| Type safety | Pass | `pnpm typecheck` |
| Firestore rules | Pass | `pnpm test:firebase`: 5 emulator-backed rules tests |
| Functions and service behavior | Pass | `pnpm test:firebase`: 14 emulator-backed tests |
| Production web bundle | Pass | `pnpm build`: 499 modules transformed; Workbox generated 95 precache entries |
| Artifact policy | Pass | 97 files checked for required icons/shell, source maps, private URLs, hashing, cache boundaries, and JavaScript transfer budgets |
| Capacitor synchronization | Pass | `pnpm exec cap sync ios`; local `dist` copied with no production `server.url` |
| Native compile | Pass | `pnpm ios:build`; unsigned Debug build for a generic iOS simulator |
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

## PWA, offline, and update behavior

- A real Workbox service worker precaches only the public shell and local build assets. It has no background-sync owner for financial commands.
- Service-worker registration is production-web-only and disabled inside Capacitor.
- A waiting update is explicit. Pending, failed, or conflicted commands and device-only receipt drafts block activation; choosing Later preserves the waiting worker.
- `/__/`, `/api/`, emulator URLs, the demo Firebase project identity, source maps, and the 1024-pixel source icon are excluded from the release artifact.
- Hosting policy makes only hashed `/assets/**` immutable. The HTML shell, manifest, service worker, Workbox loader, startup diagnostics, icons, and build metadata revalidate.
- Global offline, update-ready, offline-ready, and update-blocked status is rendered in an announced app-level surface.

## Accessibility and interaction evidence

- Native Dynamic Type was exercised at the maximum simulator setting. Content reflows and remains scrollable; the persistent add button can overlay content while scrolling, consistent with a floating action control.
- Interactive controls added or reviewed in this task use at least 44-point targets. Text labels previously below `0.7rem` were raised.
- Dark, high-contrast theme tokens, visible focus rings, and `prefers-reduced-motion` fallbacks are present. The reduced-motion rules remove custom transitions and transforms.
- Camera and photo-library purpose strings and an iOS privacy manifest are in the native bundle.
- Native haptics use `@capacitor/haptics`; browser vibration is only the web fallback.

## Evidence boundaries

The iPad split-pane/master-detail contract is component-tested, but the iPad screenshot proves the home shell only; no tap automation was authorized for this pass. VoiceOver traversal, Full Keyboard Access, Switch Control, physical-device haptics/camera, landscape tablet master/detail, keyboard-driven sheets, and same-viewport reference-image comparison still require an interactive device session. They are not claimed as passed.

Hosted install, cold-offline navigation, Cache Storage inspection, real Firebase sign-in, and durable add/edit/settle proof depend on the Firebase deployment recorded in [firebase-deployment.md](firebase-deployment.md). Until that deployment is complete, the locally launched build is verified native demo behavior, not live cloud persistence.
