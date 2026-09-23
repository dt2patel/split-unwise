import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const root = resolve(__dirname, '../../..')
const html = readFileSync(resolve(root, 'index.html'), 'utf8')
const links = [...html.matchAll(/<link rel="apple-touch-startup-image" media="([^"]+)" href="([^"]+)" \/>/g)].map(([, media, href]) => ({ media, href }))

describe('iOS launch images', () => {
  it('covers every iPhone in portrait and every iPad in both orientations, in light and dark', () => {
    expect(links).toHaveLength(62)
    const devices = new Set(links.map(({ media }) => media.replace(/ and \(prefers-color-scheme: (?:light|dark)\)/, '')))
    for (const device of devices) {
      expect(links.filter(({ media }) => media.startsWith(device))).toHaveLength(2)
      expect(links.some(({ media }) => media === `${device} and (prefers-color-scheme: dark)`)).toBe(true)
    }
    expect([...devices].filter((device) => device.includes('orientation: landscape'))).toHaveLength(9)
  })

  it('ships each image at exactly the pixel size its media query selects', () => {
    for (const { media, href } of links) {
      const file = resolve(root, 'public', href.replace(/^\//, ''))
      expect(existsSync(file), href).toBe(true)
      const width = Number(/device-width: (\d+)px/.exec(media)![1])
      const height = Number(/device-height: (\d+)px/.exec(media)![1])
      const ratio = Number(/device-pixel-ratio: (\d+)/.exec(media)![1])
      const landscape = media.includes('orientation: landscape')
      expect(jpegSize(readFileSync(file)), href).toEqual(landscape ? [height * ratio, width * ratio] : [width * ratio, height * ratio])
    }
  })
})

function jpegSize(bytes: Buffer): [number, number] {
  for (let offset = 2; offset + 9 < bytes.length;) {
    if (bytes[offset] !== 0xff) { offset += 1; continue }
    const marker = bytes[offset + 1]
    if (marker >= 0xc0 && marker <= 0xc3) return [bytes.readUInt16BE(offset + 7), bytes.readUInt16BE(offset + 5)]
    offset += 2 + bytes.readUInt16BE(offset + 2)
  }
  throw new Error('no JPEG frame header')
}
