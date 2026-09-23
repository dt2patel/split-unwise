import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { dismissLaunchScreen, resetLaunchScreenForTesting } from '../launchScreen'
import { markLaunch } from '../perfMarks'

const root = resolve(__dirname, '../../..')
const html = readFileSync(resolve(root, 'index.html'), 'utf8')
const launchScript = readFileSync(resolve(root, 'public/launch.js'), 'utf8')
const wait = (ms: number) => new Promise((done) => setTimeout(done, ms))

function mountLaunchScreen(pageClass = 'ion-page'): void {
  document.documentElement.classList.add('su-launching')
  document.body.innerHTML = `<div id="su-launch" class="su-launch"></div><div id="app"><div class="${pageClass}"></div></div>`
}

beforeEach(() => resetLaunchScreenForTesting())
afterEach(() => {
  document.documentElement.classList.remove('su-launching')
  document.documentElement.style.removeProperty('--su-launch-shift')
  document.body.innerHTML = ''
})

describe('home-screen launch screen', () => {
  it('ships in the page shell so its first frame paints before any app code runs', () => {
    const head = html.slice(0, html.indexOf('</head>'))
    expect(head).toContain('<style id="su-launch-style">')
    expect(head).toContain('<script src="/launch.js"></script>')
    expect(html.indexOf('<div id="su-launch"')).toBeLessThan(html.indexOf('<div id="app">'))
    expect(html).toContain('src="/icons/icon-512.png"')
  })

  it('fades into the app once the first page shows content, then removes itself', async () => {
    mountLaunchScreen()
    markLaunch('home-cached')
    const dismissing = dismissLaunchScreen()
    await dismissing
    const splash = document.getElementById('su-launch')
    expect(splash?.classList.contains('su-launch--leaving')).toBe(true)

    await wait(500)
    expect(document.getElementById('su-launch')).toBeNull()
    expect(document.documentElement.classList.contains('su-launching')).toBe(false)
  })

  it('waits for Ionic to reveal the first page instead of fading onto an empty shell', async () => {
    mountLaunchScreen('ion-page ion-page-invisible')
    const dismissing = dismissLaunchScreen()
    await wait(60)
    expect(document.getElementById('su-launch')?.classList.contains('su-launch--leaving')).toBe(false)

    document.querySelector('.ion-page')!.classList.remove('ion-page-invisible')
    await dismissing
    expect(document.getElementById('su-launch')?.classList.contains('su-launch--leaving')).toBe(true)
  })

  it('does nothing in a browser tab, where no launch screen was shown', async () => {
    document.body.innerHTML = '<div id="app"><div class="ion-page"></div></div>'
    await expect(dismissLaunchScreen()).resolves.toBeUndefined()
  })

  it('shows only for the home-screen app and lines its logo up with the iOS launch image', () => {
    const run = new Function(launchScript) as () => void
    Object.defineProperty(window, 'innerHeight', { configurable: true, value: 798 })
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 393 })
    Object.defineProperty(window.screen, 'height', { configurable: true, value: 852 })
    Object.defineProperty(window.screen, 'width', { configurable: true, value: 393 })

    run()
    expect(document.documentElement.classList.contains('su-launching')).toBe(false)

    Object.defineProperty(navigator, 'standalone', { configurable: true, value: true })
    try {
      run()
      expect(document.documentElement.classList.contains('su-launching')).toBe(true)
      // The page starts 54px below the top of the screen (status bar), so the logo moves up by half of that.
      expect(document.documentElement.style.getPropertyValue('--su-launch-shift')).toBe('27px')
    } finally {
      Object.defineProperty(navigator, 'standalone', { configurable: true, value: undefined })
    }
  })
})
