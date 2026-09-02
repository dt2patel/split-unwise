import { describe, expect, it } from 'vitest'
import {
  LOCALE_STORAGE_KEY,
  MESSAGE_CATALOGS,
  SUPPORTED_LOCALES,
  createLocaleController,
  readLocalePreference,
  resolveSupportedLocale,
} from '../i18n'

function placeholders(template: string): readonly string[] {
  return [...template.matchAll(/\{([A-Za-z][A-Za-z0-9]*)\}/g)].map((match) => match[1]!).sort()
}

describe('locale controller', () => {
  it('exposes the complete invitation message contract and binding Spanish anchors', () => {
    expect(MESSAGE_CATALOGS.en).toMatchObject({
      'invite.backGroup': 'Group',
      'invite.title': 'Invite people',
      'invite.heading': 'Invite to {group}',
      'invite.intro': 'Create a private, seven-day link. Split Unwise never sends it automatically.',
      'invite.targetEmail': 'Target email',
      'invite.optional': 'Optional',
      'invite.emailPlaceholder': 'friend@example.com',
      'invite.preparing': 'Preparing…',
      'invite.prepare': 'Prepare invitation',
      'invite.managerOnly': 'Only a group manager can invite members.',
      'invite.privateCapability': 'Links are private, single-use, and expire after seven days.',
      'invite.demoCapability': 'Demo mode creates a local preview only.',
      'invite.ready': 'Invitation ready',
      'invite.expires': 'Expires {date}',
      'invite.urlAria': 'Prepared invitation URL',
      'invite.revoked': 'Invitation revoked',
      'invite.share': 'Share invitation',
      'invite.revoke': 'Revoke invitation',
      'invite.status.privateReady': 'Private seven-day invitation ready.',
      'invite.status.demoReady': 'Local preview ready. It is not a cross-device production invitation.',
      'invite.status.revoked': 'Invitation revoked.',
      'invite.error.managerOnly': 'Only a group manager can create an invitation.',
      'invite.error.firebaseNotReady': 'Firebase is not ready for invitations.',
      'invite.error.invalidResponse': 'Invitation service returned an invalid response.',
      'invite.error.prepareFailed': 'The invitation could not be prepared.',
      'invite.error.revokeFailed': 'The invitation could not be revoked.',
      'inviteLanding.kicker': 'SPLIT UNWISE INVITATION',
      'inviteLanding.title': 'Join a shared group',
      'inviteLanding.checking': 'Checking invitation…',
      'inviteLanding.missing': 'This invitation link is missing or has already been opened.',
      'inviteLanding.signInPrompt': 'Sign in to inspect and accept this private invitation.',
      'inviteLanding.accountNotReady': 'Your signed-in account is not ready.',
      'inviteLanding.alreadyMember': 'You already belong to {group}.',
      'inviteLanding.invited': "You're invited to join {group}.",
      'inviteLanding.demoPreview': 'Demo invitation preview. Acceptance stays on this device and is not a production membership change.',
      'inviteLanding.consumed': 'This invitation has already been consumed.',
      'inviteLanding.joined': 'You joined the group.',
      'inviteLanding.acceptFailed': 'This invitation could not be accepted.',
      'inviteLanding.verificationSent': 'Verification email sent. Open it, then return here and check again.',
      'inviteLanding.verificationSendFailed': 'The verification email could not be sent.',
      'inviteLanding.notVerified': 'That email is not verified yet. Open the verification email, then check again.',
      'inviteLanding.verificationCheckFailed': 'Email verification could not be checked.',
      'inviteLanding.verifyToAccept': 'Verify {email} to accept this invitation.',
      'inviteLanding.accountEmail': 'your account email',
      'inviteLanding.differentEmail': 'This invitation was sent to a different verified email. Sign in with the invited account and open the link again.',
      'inviteLanding.invalid': 'This invitation link is invalid, expired, or no longer available.',
      'inviteLanding.verificationRequired': 'Email verification required',
      'inviteLanding.resendVerification': 'Resend verification email',
      'inviteLanding.checkingShort': 'Checking…',
      'inviteLanding.verifiedAction': "I've verified my email",
      'inviteLanding.privacy': "The private token was removed from this browser's address.",
      'inviteLanding.signIn': 'Sign in to continue',
      'inviteLanding.joining': 'Joining…',
      'inviteLanding.join': 'Join group',
      'inviteLanding.openGroup': 'Open group',
      'inviteLanding.openDemo': 'Open demo groups',
      'inviteLanding.goHome': 'Go home',
    })
    expect(MESSAGE_CATALOGS.es).toMatchObject({
      'invite.title': 'Invitar personas',
      'invite.heading': 'Invitar a {group}',
      'invite.prepare': 'Preparar invitación',
      'invite.urlAria': 'URL de invitación preparada',
      'inviteLanding.invited': 'Te invitaron a unirte a {group}.',
      'inviteLanding.join': 'Unirse al grupo',
    })
  })

  it('matches an exact regional locale before falling back to a supported base language', () => {
    expect(resolveSupportedLocale(['pt-BR', 'fr-FR'])).toBe('pt-BR')
    expect(resolveSupportedLocale(['fr-CA', 'es-MX'])).toBe('fr')
    expect(resolveSupportedLocale(['ja-JP'])).toBe('en')
  })

  it('falls back to the system preference when persisted storage is invalid or inaccessible', () => {
    expect(readLocalePreference({ getItem: () => 'klingon' })).toBe('system')
    expect(readLocalePreference({ getItem: () => { throw new Error('denied') } })).toBe('system')
  })

  it('persists an explicit preference, updates the document language, and translates interpolation', () => {
    const stored = new Map([[LOCALE_STORAGE_KEY, 'es']])
    const root = document.implementation.createHTMLDocument('Split Unwise')
    const controller = createLocaleController({
      document: root,
      languages: ['de-DE'],
      storage: {
        getItem: (key) => stored.get(key) ?? null,
        setItem: (key, value) => stored.set(key, value),
      },
    })

    expect(controller.locale.value).toBe('es')
    expect(controller.t('auth.loadingGroups', { name: 'Maya' })).toBe('Cargando los grupos de Maya…')
    expect(root.documentElement.lang).toBe('es')

    controller.setPreference('pt-PT')

    expect(controller.preference.value).toBe('pt-PT')
    expect(controller.locale.value).toBe('pt-PT')
    expect(stored.get(LOCALE_STORAGE_KEY)).toBe('pt-PT')
    expect(root.documentElement.lang).toBe('pt-PT')
  })

  it('exposes the official initial Splitwise locale set and follows the device when set to system', () => {
    const stored = new Map([[LOCALE_STORAGE_KEY, 'nl']])
    const controller = createLocaleController({
      document,
      languages: ['it-IT'],
      storage: {
        getItem: (key) => stored.get(key) ?? null,
        setItem: (key, value) => stored.set(key, value),
      },
    })

    expect(SUPPORTED_LOCALES).toEqual(['en', 'es', 'de', 'nl', 'fr', 'it', 'pt-BR', 'pt-PT'])
    controller.setPreference('system')
    expect(controller.locale.value).toBe('it')
    expect(stored.get(LOCALE_STORAGE_KEY)).toBe('system')
  })

  it('keeps every locale on the exact English key set and placeholder multiset', () => {
    const englishKeys = Object.keys(MESSAGE_CATALOGS.en).sort()

    for (const locale of SUPPORTED_LOCALES) {
      expect(Object.keys(MESSAGE_CATALOGS[locale]).sort(), `${locale} message keys`).toEqual(englishKeys)
      for (const key of englishKeys) {
        expect(
          placeholders(MESSAGE_CATALOGS[locale][key as keyof typeof MESSAGE_CATALOGS.en]),
          `${locale} placeholders for ${key}`,
        ).toEqual(placeholders(MESSAGE_CATALOGS.en[key as keyof typeof MESSAGE_CATALOGS.en]))
      }
    }
  })

  it.each([
    ['fr', 'Restauration terminée : Dépense.', 'Restauration terminée pour tout le monde : Dépense.'],
    ['it', 'Ripristino completato: Spesa.', 'Ripristino completato per tutti: Spesa.'],
    ['pt-BR', 'Restauração concluída: Despesa.', 'Restauração concluída para todos: Despesa.'],
    ['pt-PT', 'Restauro concluído: Despesa.', 'Restauro concluído para todos: Despesa.'],
  ] as const)('keeps the fallback expense restore notice gender-neutral in %s', (locale, restored, restoredForEveryone) => {
    const controller = createLocaleController({
      document: document.implementation.createHTMLDocument('Split Unwise'),
      languages: ['en-US'],
      storage: { getItem: () => locale, setItem: () => undefined },
    })
    const label = controller.t('activity.defaultExpense')

    expect(controller.t('activity.restored', { label })).toBe(restored)
    expect(controller.t('activity.restoredForEveryone', { label })).toBe(restoredForEveryone)
  })
})
