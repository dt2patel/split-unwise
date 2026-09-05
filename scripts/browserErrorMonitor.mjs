const maximumDiagnostics = 25

export function createBrowserErrorMonitor(page, label) {
  let offlineWindowActive = false
  let offlineConsoleErrorCount = 0
  let offlineWindowStartCount = 0
  let pageErrorCount = 0
  let unexpectedConsoleErrorCount = 0
  const pageErrors = []
  const unexpectedConsoleErrors = []

  page.on('pageerror', (error) => {
    pageErrorCount += 1
    if (pageErrors.length < maximumDiagnostics) pageErrors.push(sanitizeBrowserDiagnostic(error?.message ?? error))
  })
  page.on('console', (message) => {
    if (message.type() !== 'error') return
    const diagnostic = sanitizeBrowserDiagnostic(message.text())
    if (offlineWindowActive && isExpectedOfflineConsoleDiagnostic(diagnostic)) {
      offlineConsoleErrorCount += 1
      return
    }
    unexpectedConsoleErrorCount += 1
    if (unexpectedConsoleErrors.length < maximumDiagnostics) unexpectedConsoleErrors.push(diagnostic)
  })

  return {
    beginExpectedOfflineWindow() {
      if (offlineWindowActive) throw new Error(`Hosted ${label} offline error window is already active.`)
      offlineWindowActive = true
      offlineWindowStartCount = offlineConsoleErrorCount
    },
    endExpectedOfflineWindow() {
      if (!offlineWindowActive) throw new Error(`Hosted ${label} offline error window is not active.`)
      offlineWindowActive = false
      return { consoleErrorCount: offlineConsoleErrorCount - offlineWindowStartCount }
    },
    assertClean() {
      if (offlineWindowActive) throw new Error(`Hosted ${label} offline error window is still active.`)
      if (pageErrorCount === 0 && unexpectedConsoleErrorCount === 0) return
      throw new Error(`Hosted ${label} emitted ${formatCount(pageErrorCount, 'page error')} and ${formatCount(unexpectedConsoleErrorCount, 'unexpected console error')}: ${JSON.stringify({ pageErrors, unexpectedConsoleErrors })}`)
    },
  }
}

export function isExpectedOfflineConsoleDiagnostic(diagnostic) {
  return diagnostic === 'Failed to load resource: net::ERR_INTERNET_DISCONNECTED'
    || /^\[[^\]\r\n]{1,64}\] @firebase\/firestore: Firestore \(\d+\.\d+\.\d+\): Could not reach Cloud Firestore backend\. Connection failed \d+ times?\. Most recent error: FirebaseError: \[code=unavailable\]:/.test(diagnostic)
}

export function sanitizeBrowserDiagnostic(value) {
  return String(value ?? '')
    .replace(/https?:\/\/[^\s"'<>]+/gi, '[url]')
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '[email]')
    .replace(/\b(?:AIza[A-Za-z0-9_-]{20,}|eyJ[A-Za-z0-9._-]{20,}|[A-Za-z0-9_-]{36,})\b/g, '[redacted]')
    .replace(/\s+/g, ' ')
    .slice(0, 300)
}

function formatCount(count, singular) {
  return `${count} ${singular}${count === 1 ? '' : 's'}`
}
