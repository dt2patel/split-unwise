(() => {
  // Home-screen launch: iOS shows its launch image (public/launch/*) until this page paints. Keep the same picture on
  // screen until the app's first page is ready (src/app/launchScreen.ts), so the launch reads as one continuous moment.
  const root = document.documentElement
  const preview = new URLSearchParams(window.location.search).has('launch-preview')
  const standalone = navigator.standalone === true || window.matchMedia?.('(display-mode: standalone)').matches === true
  if (!standalone && !preview) return
  root.classList.add('su-launching')

  // iOS draws the launch image across the whole screen, but a home-screen page can start below the status bar.
  // Moving the logo up by half that gap keeps it exactly where the launch image had it.
  const portrait = window.innerHeight >= window.innerWidth
  const screenHeight = portrait ? Math.max(screen.width, screen.height) : Math.min(screen.width, screen.height)
  const gap = screenHeight - window.innerHeight
  if (gap > 0 && gap < 120) root.style.setProperty('--su-launch-shift', `${gap / 2}px`)

  // A slow start (first sign-in, poor network) gets a spinner instead of a logo that looks frozen.
  window.setTimeout(() => document.getElementById('su-launch')?.classList.add('su-launch--slow'), 900)
  // Last resort if the app never starts: startup.js shows its own error, and nothing may stay covered by the logo.
  window.setTimeout(() => {
    document.getElementById('su-launch')?.remove()
    root.classList.remove('su-launching')
  }, 12000)
})()
