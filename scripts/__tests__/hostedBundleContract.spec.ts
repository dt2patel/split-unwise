// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import {
  assertExpectedHostedCommit,
  collectHashedStartupAssets,
} from '../hostedBundleContract.mjs'

describe('hosted bundle proof contract', () => {
  it('requires one exact full Git commit for the deployed build assertion', () => {
    expect(assertExpectedHostedCommit('4090861e7f6b5f98c3ff321628e7197958d74bd4')).toBe('4090861e7f6b5f98c3ff321628e7197958d74bd4')
    expect(() => assertExpectedHostedCommit('4090861')).toThrow(/40-character/i)
    expect(() => assertExpectedHostedCommit('not-a-commit')).toThrow(/40-character/i)
    expect(() => assertExpectedHostedCommit(undefined)).toThrow(/EXPECTED_HOSTED_COMMIT/)
  })

  it('extracts every referenced hashed JavaScript and stylesheet startup asset', () => {
    const html = `
      <script type="module" crossorigin src="/assets/index-AbCdEf12.js"></script>
      <link rel="modulepreload" href="/assets/vendor-A1_b-234.js">
      <link rel="stylesheet" href="/assets/index-98zy_XWV.css">
      <script src="/startup.js"></script>
      <link rel="manifest" href="/manifest.webmanifest">
    `

    expect(collectHashedStartupAssets(html, 'https://split-unwise-aditya.web.app')).toEqual([
      'https://split-unwise-aditya.web.app/assets/index-AbCdEf12.js',
      'https://split-unwise-aditya.web.app/assets/vendor-A1_b-234.js',
      'https://split-unwise-aditya.web.app/assets/index-98zy_XWV.css',
    ])
  })

  it('rejects a shell without both a hashed module entry and a hashed stylesheet', () => {
    expect(() => collectHashedStartupAssets('<script src="/startup.js"></script>', 'https://split-unwise-aditya.web.app')).toThrow(/hashed module entry/i)
    expect(() => collectHashedStartupAssets('<script type="module" src="/assets/index-AbCdEf12.js"></script>', 'https://split-unwise-aditya.web.app')).toThrow(/hashed stylesheet/i)
  })

  it('rejects non-origin, non-hashed, and malformed startup asset references', () => {
    expect(() => collectHashedStartupAssets(`
      <script type="module" src="https://cdn.example.com/assets/index-AbCdEf12.js"></script>
      <link rel="stylesheet" href="/assets/index-98zy_XWV.css">
    `, 'https://split-unwise-aditya.web.app')).toThrow(/same hosted origin/i)
    expect(() => collectHashedStartupAssets(`
      <script type="module" src="/assets/index.js"></script>
      <link rel="stylesheet" href="/assets/index-98zy_XWV.css">
    `, 'https://split-unwise-aditya.web.app')).toThrow(/content hashed/i)
  })

  it('keeps exact-bundle and authenticated browser checks in the disposable hosted gate', () => {
    const runner = readFileSync(resolve(process.cwd(), 'scripts/runHostedProof.mjs'), 'utf8')
    const browser = readFileSync(resolve(process.cwd(), 'scripts/runHostedBrowserProof.mjs'), 'utf8')

    expect(runner).toContain('EXPECTED_HOSTED_COMMIT: expectedHostedCommit')
    expect(runner).toContain("['scripts/runHostedBrowserProof.mjs']")
    expect(browser).toContain("from 'playwright-core'")
    expect(browser).toContain("fetch(new URL('/build-info.json', hostedOrigin), noStore)")
    expect(browser).toContain('collectHashedStartupAssets(rootHtml, hostedOrigin)')
    expect(browser).toContain("page.locator('#auth-email').fill(ownerEmail)")
    expect(browser).toContain("getByRole('link', { name: 'Add expense', exact: true })")
    expect(browser).toContain("page.locator('#expense-category').selectOption({ label: 'Food' })")
    expect(browser).toContain("page.locator('.app-status').getByRole('button', { name: 'OK', exact: true })")
    expect(browser).toContain("page.locator('[data-action=\"save-expense\"]')")
    expect(browser).toContain('browserExpenseDescription')
    expect(browser).toContain('page.reload')
    expect(browser).toContain('.expense-row[data-sync-state="fresh"]')
    expect(browser).toContain("getByRole('link', { name: 'Recurring', exact: true })")
  })
})
