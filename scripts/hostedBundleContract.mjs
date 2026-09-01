const fullCommitPattern = /^[0-9a-f]{40}$/
const hashedAssetPattern = /^\/assets\/[A-Za-z0-9_.-]+-[A-Za-z0-9_-]{8,}\.(?:js|css)$/

export function assertExpectedHostedCommit(value) {
  if (typeof value !== 'string' || !fullCommitPattern.test(value)) {
    throw new Error('EXPECTED_HOSTED_COMMIT must be the exact 40-character lowercase Git commit deployed to Hosting.')
  }
  return value
}

export function collectHashedStartupAssets(html, hostedOrigin) {
  if (typeof html !== 'string') throw new Error('Hosted shell must be HTML text.')
  const origin = new URL(hostedOrigin).origin
  const candidates = []
  let hasModuleEntry = false
  let hasStylesheet = false

  for (const match of html.matchAll(/<script\b[^>]*>/gi)) {
    const tag = match[0]
    const src = attribute(tag, 'src')
    if (!src || attribute(tag, 'type')?.toLowerCase() !== 'module') continue
    hasModuleEntry = true
    candidates.push(src)
  }
  for (const match of html.matchAll(/<link\b[^>]*>/gi)) {
    const tag = match[0]
    const href = attribute(tag, 'href')
    const rel = attribute(tag, 'rel')?.toLowerCase().split(/\s+/) ?? []
    if (!href || (!rel.includes('modulepreload') && !rel.includes('stylesheet'))) continue
    if (rel.includes('stylesheet')) hasStylesheet = true
    candidates.push(href)
  }

  if (!hasModuleEntry) throw new Error('Hosted shell is missing a hashed module entry.')
  if (!hasStylesheet) throw new Error('Hosted shell is missing a hashed stylesheet.')

  return [...new Set(candidates.map((candidate) => {
    const url = new URL(candidate, origin)
    if (url.origin !== origin) throw new Error(`Startup asset must use the same hosted origin: ${candidate}`)
    if (url.search || url.hash || !hashedAssetPattern.test(url.pathname)) {
      throw new Error(`Startup asset must be content hashed under /assets: ${candidate}`)
    }
    return url.href
  }))]
}

function attribute(tag, name) {
  const escapedName = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const match = new RegExp(`\\s${escapedName}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i').exec(tag)
  return match?.[1] ?? match?.[2] ?? match?.[3]
}
