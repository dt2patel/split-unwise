// Renders iOS home-screen launch images (apple-touch-startup-image) from the launch screen in index.html, so the image
// iOS shows before the page loads is pixel-for-pixel the page's own first frame. Rerun after changing that markup:
//   node scripts/generateLaunchImages.mjs
// Uses a local Chrome; set LAUNCH_IMAGE_BROWSER to another Chromium binary if needed.
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { chromium } from 'playwright-core'

const root = resolve(import.meta.dirname, '..')
const indexPath = resolve(root, 'index.html')
const outputDirectory = resolve(root, 'public/launch')
const browserPath = process.env.LAUNCH_IMAGE_BROWSER ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'

/** Portrait CSS size and pixel ratio of every iPhone and iPad that can run a home-screen web app today. */
export const LAUNCH_DEVICES = [
  { kind: 'iphone', width: 440, height: 956, ratio: 3 }, // 16 Pro Max, 17 Pro Max
  { kind: 'iphone', width: 430, height: 932, ratio: 3 }, // 14 Pro Max, 15 Plus/Pro Max, 16 Plus
  { kind: 'iphone', width: 428, height: 926, ratio: 3 }, // 12/13 Pro Max, 14 Plus
  { kind: 'iphone', width: 420, height: 912, ratio: 3 }, // Air
  { kind: 'iphone', width: 414, height: 896, ratio: 3 }, // XS Max, 11 Pro Max
  { kind: 'iphone', width: 414, height: 896, ratio: 2 }, // XR, 11
  { kind: 'iphone', width: 414, height: 736, ratio: 3 }, // 6/7/8 Plus
  { kind: 'iphone', width: 402, height: 874, ratio: 3 }, // 16 Pro, 17, 17 Pro
  { kind: 'iphone', width: 393, height: 852, ratio: 3 }, // 14 Pro, 15, 15 Pro, 16
  { kind: 'iphone', width: 390, height: 844, ratio: 3 }, // 12, 13, 14, 16e
  { kind: 'iphone', width: 375, height: 812, ratio: 3 }, // X, XS, 11 Pro, 12/13 mini
  { kind: 'iphone', width: 375, height: 667, ratio: 2 }, // 6/7/8, SE 2nd/3rd gen
  { kind: 'iphone', width: 320, height: 568, ratio: 2 }, // SE 1st gen
  { kind: 'ipad', width: 1032, height: 1376, ratio: 2 }, // Pro 13" (M4)
  { kind: 'ipad', width: 1024, height: 1366, ratio: 2 }, // Pro 12.9", Air 13"
  { kind: 'ipad', width: 834, height: 1210, ratio: 2 }, // Pro 11" (M4)
  { kind: 'ipad', width: 834, height: 1194, ratio: 2 }, // Pro 11"
  { kind: 'ipad', width: 834, height: 1112, ratio: 2 }, // Air 3rd gen, Pro 10.5"
  { kind: 'ipad', width: 820, height: 1180, ratio: 2 }, // Air 4th/5th gen, iPad 10th gen, Air 11"
  { kind: 'ipad', width: 810, height: 1080, ratio: 2 }, // iPad 7th-9th gen
  { kind: 'ipad', width: 768, height: 1024, ratio: 2 }, // mini 5th gen, 9.7"
  { kind: 'ipad', width: 744, height: 1133, ratio: 2 }, // mini 6th/7th gen
]
const SCHEMES = ['light', 'dark']

export function launchImageVariants() {
  return LAUNCH_DEVICES.flatMap((device) => (device.kind === 'ipad' ? ['portrait', 'landscape'] : ['portrait']).flatMap((orientation) => SCHEMES.map((scheme) => {
    const landscape = orientation === 'landscape'
    const name = `${device.kind}-${device.width}x${device.height}@${device.ratio}x${landscape ? '-landscape' : ''}-${scheme}.jpg`
    return {
      ...device, orientation, scheme, href: `/launch/${name}`, file: resolve(outputDirectory, name),
      viewport: landscape ? { width: device.height, height: device.width } : { width: device.width, height: device.height },
      // iOS matches device-width/height as the portrait size in both orientations.
      media: `screen and (device-width: ${device.width}px) and (device-height: ${device.height}px) and (-webkit-device-pixel-ratio: ${device.ratio}) and (orientation: ${orientation}) and (prefers-color-scheme: ${scheme})`,
    }
  })))
}

if (import.meta.url === `file://${process.argv[1]}`) await main()

async function main() {
  const html = await readFile(indexPath, 'utf8')
  const style = html.match(/<style id="su-launch-style">[\s\S]*?<\/style>/)?.[0]
  const markup = html.match(/<!-- launch-screen:start -->([\s\S]*?)<!-- launch-screen:end -->/)?.[1]
  if (!style || !markup) throw new Error('index.html is missing the launch screen style or markup markers')
  const icon = `data:image/png;base64,${(await readFile(resolve(root, 'public/icons/icon-512.png'))).toString('base64')}`
  if (!markup.includes('src="/icons/icon-512.png"')) throw new Error('the launch screen must show /icons/icon-512.png')
  const documentHtml = `<!doctype html><html class="su-launching"><head><meta charset="utf-8"><style>html,body{margin:0}</style>${style}</head><body>${markup.replace('src="/icons/icon-512.png"', `src="${icon}"`)}</body></html>`

  await rm(outputDirectory, { recursive: true, force: true })
  await mkdir(outputDirectory, { recursive: true })
  const browser = await chromium.launch({ executablePath: browserPath, headless: true })
  const variants = launchImageVariants()
  try {
    for (const variant of variants) {
      const context = await browser.newContext({ viewport: variant.viewport, deviceScaleFactor: variant.ratio, colorScheme: variant.scheme, reducedMotion: 'reduce' })
      const page = await context.newPage()
      await page.setContent(documentHtml, { waitUntil: 'load' })
      await page.evaluate(() => document.querySelector('.su-launch__icon').decode())
      // JPEG keeps the soft glow at a fraction of PNG's size (the pwa-asset-generator default for iOS launch images too).
      await page.screenshot({ path: variant.file, type: 'jpeg', quality: 90, animations: 'disabled' })
      await context.close()
    }
  } finally {
    await browser.close()
  }

  const links = variants.map((variant) => `    <link rel="apple-touch-startup-image" media="${variant.media}" href="${variant.href}" />`).join('\n')
  const updated = html.replace(/(<!-- launch-images:start[^>]*-->)[\s\S]*?(\s*<!-- launch-images:end -->)/, `$1\n${links}$2`)
  await writeFile(indexPath, updated)
  process.stdout.write(`Rendered ${variants.length} launch images into public/launch and linked them in index.html.\n`)
}
