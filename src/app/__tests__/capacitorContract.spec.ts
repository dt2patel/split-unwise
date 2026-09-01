// @vitest-environment node
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import capacitorConfig from '../../../capacitor.config'

describe('Capacitor release contract', () => {
  it('uses one stable native identity and local production web bundle', () => {
    expect(capacitorConfig).toMatchObject({ appId: 'app.splitunwise.mobile', appName: 'Split Unwise', webDir: 'dist' })
    expect(capacitorConfig.server).toBeUndefined()
  })

  it('pins matching Capacitor major versions and includes the real iOS platform', () => {
    const packageJson = JSON.parse(readFileSync(resolve(process.cwd(), 'package.json'), 'utf8')) as { dependencies: Record<string, string>; devDependencies: Record<string, string> }
    const versions = [packageJson.dependencies['@capacitor/core'], packageJson.dependencies['@capacitor/ios'], packageJson.devDependencies['@capacitor/cli']]
    expect(versions.every((version) => /^8\./.test(version))).toBe(true)
    expect(readFileSync(resolve(process.cwd(), 'ios/App/App/capacitor.config.json'), 'utf8')).toContain('app.splitunwise.mobile')
  })

  it('declares camera/photo purpose strings and an app privacy manifest', () => {
    const info = readFileSync(resolve(process.cwd(), 'ios/App/App/Info.plist'), 'utf8')
    expect(info).toContain('NSCameraUsageDescription')
    expect(info).toContain('NSPhotoLibraryUsageDescription')
    const privacy = readFileSync(resolve(process.cwd(), 'ios/App/App/PrivacyInfo.xcprivacy'), 'utf8')
    expect(privacy).toContain('NSPrivacyTracking')
  })
})
