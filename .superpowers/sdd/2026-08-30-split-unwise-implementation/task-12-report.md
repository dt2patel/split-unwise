# Task 12 report: mobile release and deployment

Status: implementation, local/native verification, Firestore security deployment, and production Firebase Hosting complete. Secure cloud writes and Storage remain blocked by the dedicated project's no-billing tier.

## Delivered

- Production PWA manifest, generated Workbox service worker, safe update prompt, offline/status UI, cache boundaries, security headers, icons, and artifact verifier.
- Capacitor 8 iOS project with stable bundle ID `app.splitunwise.mobile`, local bundle loading, native haptics, launch assets, camera/photo purpose strings, and privacy manifest.
- Mobile accessibility refinements, iPad split-pane implementation, responsive image optimization, and route-level lazy loading with measured JavaScript transfer ceilings.
- Native iPhone light/dark/maximum-Dynamic-Type and iPad portrait evidence under `docs/verification-assets/`.
- Native-styled group currency conversion using verified, dated ECB reference rates through Frankfurter, exact ISO exponent arithmetic, abortable refreshes, clean reduced-motion-safe animation, and no ledger mutation.
- Persistent Simplify Debts settings with member-safe permissions, optimistic revision checks, replay-safe Firebase command semantics, deterministic activity, saved balance-plan selection, and clean reduced-motion-safe Ionic animation.
- Dedicated Firebase project `split-unwise-aditya`, reviewed Firestore rules/indexes, registered Web/iOS apps, a protected `nam5` database, preview validation, and production Hosting on both Firebase domains.

## Verification

- `pnpm test`: 675 passed, 25 skipped.
- `pnpm typecheck`: passed.
- `pnpm test:firebase`: 5 Firestore-rules and 16 Functions/service tests passed against Firebase emulators.
- `pnpm build`: passed; 100 production artifacts verified.
- `pnpm exec cap sync ios`: passed.
- `pnpm ios:build`: passed without code signing.
- `artifacts/Split-Unwise-Simulator.zip`: regenerated from the exact release commit; archive integrity passed; SHA-256 `273ed146d73b1b77ba52d8a2e002a2aebb0c4383a7e73fb0d22770b19092dabe`.
- Compiled app installed and rendered on iPhone 14 and iPad Air simulators.
- Production Hosting served commit `128506f6d1143e3e69bf7146fb89b9c3d3bdabd4` with successful root, deep-link, PWA, immutable-asset, build-metadata, CSP, and security-header checks on both Firebase domains.

## Truth boundary

The deployed release commit is `128506f6d1143e3e69bf7146fb89b9c3d3bdabd4`, live at `https://split-unwise-aditya.web.app`. No existing Firebase project was reused. The hosted app intentionally remains in demo mode: enabling its Firebase runtime without deployed callable Functions would expose a broken sign-in/write path. Functions and Storage were not bypassed or weakened when Firebase required billing. See `docs/verification.md` and `docs/firebase-deployment.md` for exact evidence and remaining device/live gates.
