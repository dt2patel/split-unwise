# Task 12 report: mobile release and deployment

Status: implementation and local/native verification complete; Firebase deployment blocked only on the user's outstanding normal OAuth authorization code.

## Delivered

- Production PWA manifest, generated Workbox service worker, safe update prompt, offline/status UI, cache boundaries, security headers, icons, and artifact verifier.
- Capacitor 8 iOS project with stable bundle ID `app.splitunwise.mobile`, local bundle loading, native haptics, launch assets, camera/photo purpose strings, and privacy manifest.
- Mobile accessibility refinements, iPad split-pane implementation, responsive image optimization, and route-level lazy loading with measured JavaScript transfer ceilings.
- Native iPhone light/dark/maximum-Dynamic-Type and iPad portrait evidence under `docs/verification-assets/`.

## Verification

- `pnpm test`: 658 passed, 23 skipped.
- `pnpm typecheck`: passed.
- `pnpm test:firebase`: 5 Firestore-rules and 14 Functions/service tests passed against Firebase emulators.
- `pnpm build`: passed; 97 production artifacts verified.
- `pnpm exec cap sync ios`: passed.
- `pnpm ios:build`: passed without code signing.
- Compiled app installed and rendered on iPhone 14 and iPad Air simulators.

## Truth boundary

The release commit is `b0cffeef6302bf81fa50e60bf7dffb04e5d0cc3a`. No production URL is recorded because creating/selecting a Firebase project requires completion of the already-started browser OAuth flow. No existing project was reused and no unauthenticated or token-based bypass was attempted. See `docs/verification.md` and `docs/firebase-deployment.md` for exact evidence and remaining device/live gates.
