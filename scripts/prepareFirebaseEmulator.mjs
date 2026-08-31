import { mkdir, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const secretFile = fileURLToPath(new URL('../functions/.secret.local', import.meta.url))
const placeholder = [
  '# Local emulator-only placeholders. Never replace these with production credentials.',
  'INVITATION_HMAC_SECRET=split-unwise-emulator-secret-at-least-32-bytes',
  'OCR_PROVIDER_KEY=emulator-placeholder',
  '',
].join('\n')

await mkdir(dirname(secretFile), { recursive: true })
try {
  await writeFile(secretFile, placeholder, { encoding: 'utf8', flag: 'wx', mode: 0o600 })
} catch (error) {
  if (!error || typeof error !== 'object' || !('code' in error) || error.code !== 'EEXIST') throw error
}
