(() => {
  const prefix = '[Split Unwise startup]'

  function revealFallback(reason) {
    console.error(prefix, describe(reason))
    window.setTimeout(() => {
      const root = document.getElementById('app')
      if (!root || root.childElementCount > 0 || root.textContent.trim()) return

      const surface = document.createElement('main')
      surface.setAttribute('role', 'alert')
      surface.style.cssText = 'box-sizing:border-box;min-height:100vh;padding:max(72px,env(safe-area-inset-top)) 24px max(40px,env(safe-area-inset-bottom));background:#f8f7ff;color:#191725;font:17px/1.45 -apple-system,BlinkMacSystemFont,"SF Pro Text",sans-serif;'
      const title = document.createElement('h1')
      title.textContent = 'Split Unwise couldn’t open'
      title.style.cssText = 'margin:0 0 12px;font-size:28px;line-height:1.15;letter-spacing:-.02em;'
      const copy = document.createElement('p')
      copy.textContent = 'Close and reopen the app. Your local drafts have not been deleted.'
      copy.style.cssText = 'max-width:32rem;margin:0;color:#5f5a73;'
      surface.append(title, copy)
      root.append(surface)
    }, 0)
  }

  function describe(reason) {
    if (reason instanceof Error) return `${reason.name}: ${reason.message}\n${reason.stack || ''}`
    if (typeof reason === 'string') return reason
    try {
      return JSON.stringify(reason, Object.getOwnPropertyNames(reason || {}))
    } catch {
      return String(reason)
    }
  }

  window.addEventListener('error', (event) => revealFallback(`${event.message || 'Unknown startup error'} at ${event.filename || 'unknown'}:${event.lineno || 0}:${event.colno || 0}\n${describe(event.error)}`))
  window.addEventListener('unhandledrejection', (event) => revealFallback(`Unhandled startup rejection: ${describe(event.reason)}`))
  console.info(prefix, 'diagnostics active')
})()
