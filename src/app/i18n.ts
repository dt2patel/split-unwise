import { computed, ref, type ComputedRef, type Ref } from 'vue'

export const LOCALE_STORAGE_KEY = 'split-unwise.locale'
export const SUPPORTED_LOCALES = ['en', 'es', 'de', 'nl', 'fr', 'it', 'pt-BR', 'pt-PT'] as const

export type SupportedLocale = typeof SUPPORTED_LOCALES[number]
export type LocalePreference = 'system' | SupportedLocale

const englishMessages = {
  'nav.primary': 'Primary navigation',
  'nav.home': 'Home',
  'nav.groups': 'Groups',
  'nav.activity': 'Activity',
  'nav.account': 'Account',
  'auth.heading.signUp': 'Create your account',
  'auth.heading.reset': 'Reset your password',
  'auth.heading.signIn': 'Welcome back',
  'auth.subtitle.signUp': 'Start splitting without the premium gate.',
  'auth.subtitle.reset': 'We’ll send a secure reset link.',
  'auth.subtitle.signIn': 'Bills, balances, and the truth—settled.',
  'auth.openingAccount': 'Opening your account…',
  'auth.needsAttention': 'Split Unwise needs attention',
  'auth.noDemo': 'No demo data was opened.',
  'auth.loadingGroups': 'Loading {name}’s groups…',
  'auth.name': 'Name',
  'auth.namePlaceholder': 'Your name',
  'auth.email': 'Email',
  'auth.password': 'Password',
  'auth.passwordPlaceholder': 'At least 8 characters',
  'auth.pleaseWait': 'Please wait…',
  'auth.createAccount': 'Create account',
  'auth.sendReset': 'Send reset link',
  'auth.signIn': 'Sign in',
  'auth.or': 'or',
  'auth.continueGoogle': 'Continue with Google',
  'auth.appleUnavailable': 'Apple sign-in isn’t configured yet.',
  'auth.accountHelp': 'Account help',
  'auth.backToSignIn': 'Back to sign in',
  'auth.forgotPassword': 'Forgot password?',
  'auth.dataIsolation': 'Your financial data is isolated to the signed-in account.',
  'language.title': 'Language',
  'language.heading': 'App language',
  'language.description': 'Choose the language used on this device. Shared expense data is never translated or changed.',
  'language.system': 'System default',
  'language.systemDetail': 'Follow this device’s preferred language',
  'language.accountDetail': 'System default or 8 supported languages',
} as const

export type MessageKey = keyof typeof englishMessages
type MessageCatalog = Readonly<Record<MessageKey, string>>

const catalogs: Readonly<Record<SupportedLocale, MessageCatalog>> = {
  en: englishMessages,
  es: {
    'nav.primary': 'Navegación principal', 'nav.home': 'Inicio', 'nav.groups': 'Grupos', 'nav.activity': 'Actividad', 'nav.account': 'Cuenta',
    'auth.heading.signUp': 'Crea tu cuenta', 'auth.heading.reset': 'Restablece tu contraseña', 'auth.heading.signIn': 'Te damos la bienvenida',
    'auth.subtitle.signUp': 'Empieza a dividir gastos sin límites premium.', 'auth.subtitle.reset': 'Te enviaremos un enlace seguro.', 'auth.subtitle.signIn': 'Facturas, saldos y la verdad, todo resuelto.',
    'auth.openingAccount': 'Abriendo tu cuenta…', 'auth.needsAttention': 'Split Unwise necesita atención', 'auth.noDemo': 'No se abrieron datos de demostración.',
    'auth.loadingGroups': 'Cargando los grupos de {name}…', 'auth.name': 'Nombre', 'auth.namePlaceholder': 'Tu nombre', 'auth.email': 'Correo electrónico', 'auth.password': 'Contraseña',
    'auth.passwordPlaceholder': 'Al menos 8 caracteres', 'auth.pleaseWait': 'Espera un momento…', 'auth.createAccount': 'Crear cuenta', 'auth.sendReset': 'Enviar enlace', 'auth.signIn': 'Iniciar sesión',
    'auth.or': 'o', 'auth.continueGoogle': 'Continuar con Google', 'auth.appleUnavailable': 'El inicio de sesión con Apple aún no está configurado.', 'auth.accountHelp': 'Ayuda de la cuenta',
    'auth.backToSignIn': 'Volver a iniciar sesión', 'auth.forgotPassword': '¿Olvidaste tu contraseña?', 'auth.dataIsolation': 'Tus datos financieros están aislados en la cuenta activa.',
    'language.title': 'Idioma', 'language.heading': 'Idioma de la app', 'language.description': 'Elige el idioma usado en este dispositivo. Los datos de gastos compartidos nunca se traducen ni cambian.',
    'language.system': 'Predeterminado del sistema', 'language.systemDetail': 'Usar el idioma preferido de este dispositivo', 'language.accountDetail': 'Predeterminado del sistema u 8 idiomas compatibles',
  },
  de: {
    'nav.primary': 'Hauptnavigation', 'nav.home': 'Start', 'nav.groups': 'Gruppen', 'nav.activity': 'Aktivität', 'nav.account': 'Konto',
    'auth.heading.signUp': 'Konto erstellen', 'auth.heading.reset': 'Passwort zurücksetzen', 'auth.heading.signIn': 'Willkommen zurück',
    'auth.subtitle.signUp': 'Teile Ausgaben ohne Premium-Schranke.', 'auth.subtitle.reset': 'Wir senden dir einen sicheren Link.', 'auth.subtitle.signIn': 'Rechnungen, Salden und Klarheit – erledigt.',
    'auth.openingAccount': 'Konto wird geöffnet…', 'auth.needsAttention': 'Split Unwise benötigt deine Aufmerksamkeit', 'auth.noDemo': 'Es wurden keine Demodaten geöffnet.',
    'auth.loadingGroups': 'Gruppen von {name} werden geladen…', 'auth.name': 'Name', 'auth.namePlaceholder': 'Dein Name', 'auth.email': 'E-Mail', 'auth.password': 'Passwort',
    'auth.passwordPlaceholder': 'Mindestens 8 Zeichen', 'auth.pleaseWait': 'Bitte warten…', 'auth.createAccount': 'Konto erstellen', 'auth.sendReset': 'Link senden', 'auth.signIn': 'Anmelden',
    'auth.or': 'oder', 'auth.continueGoogle': 'Mit Google fortfahren', 'auth.appleUnavailable': 'Apple-Anmeldung ist noch nicht eingerichtet.', 'auth.accountHelp': 'Kontohilfe',
    'auth.backToSignIn': 'Zurück zur Anmeldung', 'auth.forgotPassword': 'Passwort vergessen?', 'auth.dataIsolation': 'Deine Finanzdaten bleiben auf das angemeldete Konto beschränkt.',
    'language.title': 'Sprache', 'language.heading': 'App-Sprache', 'language.description': 'Wähle die Sprache für dieses Gerät. Gemeinsame Ausgabendaten werden nie übersetzt oder geändert.',
    'language.system': 'Systemstandard', 'language.systemDetail': 'Bevorzugte Sprache dieses Geräts verwenden', 'language.accountDetail': 'Systemstandard oder 8 unterstützte Sprachen',
  },
  nl: {
    'nav.primary': 'Hoofdnavigatie', 'nav.home': 'Home', 'nav.groups': 'Groepen', 'nav.activity': 'Activiteit', 'nav.account': 'Account',
    'auth.heading.signUp': 'Maak je account', 'auth.heading.reset': 'Stel je wachtwoord opnieuw in', 'auth.heading.signIn': 'Welkom terug',
    'auth.subtitle.signUp': 'Begin met splitsen zonder premiumdrempel.', 'auth.subtitle.reset': 'We sturen je een veilige link.', 'auth.subtitle.signIn': 'Rekeningen, saldi en de waarheid—vereffend.',
    'auth.openingAccount': 'Je account wordt geopend…', 'auth.needsAttention': 'Split Unwise heeft aandacht nodig', 'auth.noDemo': 'Er zijn geen demogegevens geopend.',
    'auth.loadingGroups': 'De groepen van {name} worden geladen…', 'auth.name': 'Naam', 'auth.namePlaceholder': 'Je naam', 'auth.email': 'E-mail', 'auth.password': 'Wachtwoord',
    'auth.passwordPlaceholder': 'Minimaal 8 tekens', 'auth.pleaseWait': 'Even geduld…', 'auth.createAccount': 'Account maken', 'auth.sendReset': 'Link sturen', 'auth.signIn': 'Inloggen',
    'auth.or': 'of', 'auth.continueGoogle': 'Doorgaan met Google', 'auth.appleUnavailable': 'Inloggen met Apple is nog niet ingesteld.', 'auth.accountHelp': 'Accounthulp',
    'auth.backToSignIn': 'Terug naar inloggen', 'auth.forgotPassword': 'Wachtwoord vergeten?', 'auth.dataIsolation': 'Je financiële gegevens zijn afgeschermd binnen het ingelogde account.',
    'language.title': 'Taal', 'language.heading': 'App-taal', 'language.description': 'Kies de taal voor dit apparaat. Gedeelde uitgaven worden nooit vertaald of gewijzigd.',
    'language.system': 'Systeemstandaard', 'language.systemDetail': 'Volg de voorkeurstaal van dit apparaat', 'language.accountDetail': 'Systeemstandaard of 8 ondersteunde talen',
  },
  fr: {
    'nav.primary': 'Navigation principale', 'nav.home': 'Accueil', 'nav.groups': 'Groupes', 'nav.activity': 'Activité', 'nav.account': 'Compte',
    'auth.heading.signUp': 'Créez votre compte', 'auth.heading.reset': 'Réinitialisez votre mot de passe', 'auth.heading.signIn': 'Bon retour',
    'auth.subtitle.signUp': 'Commencez à partager sans barrière premium.', 'auth.subtitle.reset': 'Nous vous enverrons un lien sécurisé.', 'auth.subtitle.signIn': 'Factures, soldes et vérité : tout est réglé.',
    'auth.openingAccount': 'Ouverture de votre compte…', 'auth.needsAttention': 'Split Unwise nécessite votre attention', 'auth.noDemo': 'Aucune donnée de démonstration n’a été ouverte.',
    'auth.loadingGroups': 'Chargement des groupes de {name}…', 'auth.name': 'Nom', 'auth.namePlaceholder': 'Votre nom', 'auth.email': 'E-mail', 'auth.password': 'Mot de passe',
    'auth.passwordPlaceholder': 'Au moins 8 caractères', 'auth.pleaseWait': 'Veuillez patienter…', 'auth.createAccount': 'Créer un compte', 'auth.sendReset': 'Envoyer le lien', 'auth.signIn': 'Se connecter',
    'auth.or': 'ou', 'auth.continueGoogle': 'Continuer avec Google', 'auth.appleUnavailable': 'La connexion Apple n’est pas encore configurée.', 'auth.accountHelp': 'Aide du compte',
    'auth.backToSignIn': 'Retour à la connexion', 'auth.forgotPassword': 'Mot de passe oublié ?', 'auth.dataIsolation': 'Vos données financières restent isolées dans le compte connecté.',
    'language.title': 'Langue', 'language.heading': 'Langue de l’app', 'language.description': 'Choisissez la langue utilisée sur cet appareil. Les données de dépenses partagées ne sont jamais traduites ni modifiées.',
    'language.system': 'Réglage du système', 'language.systemDetail': 'Suivre la langue préférée de cet appareil', 'language.accountDetail': 'Réglage du système ou 8 langues prises en charge',
  },
  it: {
    'nav.primary': 'Navigazione principale', 'nav.home': 'Home', 'nav.groups': 'Gruppi', 'nav.activity': 'Attività', 'nav.account': 'Account',
    'auth.heading.signUp': 'Crea il tuo account', 'auth.heading.reset': 'Reimposta la password', 'auth.heading.signIn': 'Bentornato',
    'auth.subtitle.signUp': 'Inizia a dividere senza limiti premium.', 'auth.subtitle.reset': 'Ti invieremo un link sicuro.', 'auth.subtitle.signIn': 'Conti, saldi e verità: tutto sistemato.',
    'auth.openingAccount': 'Apertura dell’account…', 'auth.needsAttention': 'Split Unwise richiede attenzione', 'auth.noDemo': 'Nessun dato demo è stato aperto.',
    'auth.loadingGroups': 'Caricamento dei gruppi di {name}…', 'auth.name': 'Nome', 'auth.namePlaceholder': 'Il tuo nome', 'auth.email': 'Email', 'auth.password': 'Password',
    'auth.passwordPlaceholder': 'Almeno 8 caratteri', 'auth.pleaseWait': 'Attendi…', 'auth.createAccount': 'Crea account', 'auth.sendReset': 'Invia link', 'auth.signIn': 'Accedi',
    'auth.or': 'oppure', 'auth.continueGoogle': 'Continua con Google', 'auth.appleUnavailable': 'L’accesso con Apple non è ancora configurato.', 'auth.accountHelp': 'Aiuto account',
    'auth.backToSignIn': 'Torna all’accesso', 'auth.forgotPassword': 'Password dimenticata?', 'auth.dataIsolation': 'I tuoi dati finanziari restano isolati nell’account attivo.',
    'language.title': 'Lingua', 'language.heading': 'Lingua dell’app', 'language.description': 'Scegli la lingua usata su questo dispositivo. I dati delle spese condivise non vengono mai tradotti o modificati.',
    'language.system': 'Predefinita di sistema', 'language.systemDetail': 'Segui la lingua preferita del dispositivo', 'language.accountDetail': 'Predefinita di sistema o 8 lingue supportate',
  },
  'pt-BR': {
    'nav.primary': 'Navegação principal', 'nav.home': 'Início', 'nav.groups': 'Grupos', 'nav.activity': 'Atividade', 'nav.account': 'Conta',
    'auth.heading.signUp': 'Crie sua conta', 'auth.heading.reset': 'Redefina sua senha', 'auth.heading.signIn': 'Boas-vindas de volta',
    'auth.subtitle.signUp': 'Comece a dividir sem barreira premium.', 'auth.subtitle.reset': 'Enviaremos um link seguro.', 'auth.subtitle.signIn': 'Contas, saldos e a verdade—resolvidos.',
    'auth.openingAccount': 'Abrindo sua conta…', 'auth.needsAttention': 'O Split Unwise precisa de atenção', 'auth.noDemo': 'Nenhum dado de demonstração foi aberto.',
    'auth.loadingGroups': 'Carregando os grupos de {name}…', 'auth.name': 'Nome', 'auth.namePlaceholder': 'Seu nome', 'auth.email': 'E-mail', 'auth.password': 'Senha',
    'auth.passwordPlaceholder': 'Pelo menos 8 caracteres', 'auth.pleaseWait': 'Aguarde…', 'auth.createAccount': 'Criar conta', 'auth.sendReset': 'Enviar link', 'auth.signIn': 'Entrar',
    'auth.or': 'ou', 'auth.continueGoogle': 'Continuar com o Google', 'auth.appleUnavailable': 'O login com a Apple ainda não foi configurado.', 'auth.accountHelp': 'Ajuda da conta',
    'auth.backToSignIn': 'Voltar para entrar', 'auth.forgotPassword': 'Esqueceu a senha?', 'auth.dataIsolation': 'Seus dados financeiros ficam isolados na conta conectada.',
    'language.title': 'Idioma', 'language.heading': 'Idioma do app', 'language.description': 'Escolha o idioma usado neste dispositivo. Os dados de despesas compartilhadas nunca são traduzidos nem alterados.',
    'language.system': 'Padrão do sistema', 'language.systemDetail': 'Usar o idioma preferido deste dispositivo', 'language.accountDetail': 'Padrão do sistema ou 8 idiomas compatíveis',
  },
  'pt-PT': {
    'nav.primary': 'Navegação principal', 'nav.home': 'Início', 'nav.groups': 'Grupos', 'nav.activity': 'Atividade', 'nav.account': 'Conta',
    'auth.heading.signUp': 'Crie a sua conta', 'auth.heading.reset': 'Reponha a palavra-passe', 'auth.heading.signIn': 'Bem-vindo de volta',
    'auth.subtitle.signUp': 'Comece a dividir sem barreira premium.', 'auth.subtitle.reset': 'Enviaremos uma ligação segura.', 'auth.subtitle.signIn': 'Contas, saldos e a verdade—resolvidos.',
    'auth.openingAccount': 'A abrir a sua conta…', 'auth.needsAttention': 'O Split Unwise precisa de atenção', 'auth.noDemo': 'Não foram abertos dados de demonstração.',
    'auth.loadingGroups': 'A carregar os grupos de {name}…', 'auth.name': 'Nome', 'auth.namePlaceholder': 'O seu nome', 'auth.email': 'E-mail', 'auth.password': 'Palavra-passe',
    'auth.passwordPlaceholder': 'Pelo menos 8 caracteres', 'auth.pleaseWait': 'Aguarde…', 'auth.createAccount': 'Criar conta', 'auth.sendReset': 'Enviar ligação', 'auth.signIn': 'Iniciar sessão',
    'auth.or': 'ou', 'auth.continueGoogle': 'Continuar com o Google', 'auth.appleUnavailable': 'O início de sessão com a Apple ainda não está configurado.', 'auth.accountHelp': 'Ajuda da conta',
    'auth.backToSignIn': 'Voltar ao início de sessão', 'auth.forgotPassword': 'Esqueceu-se da palavra-passe?', 'auth.dataIsolation': 'Os seus dados financeiros ficam isolados na conta ativa.',
    'language.title': 'Idioma', 'language.heading': 'Idioma da aplicação', 'language.description': 'Escolha o idioma usado neste dispositivo. Os dados de despesas partilhadas nunca são traduzidos nem alterados.',
    'language.system': 'Predefinição do sistema', 'language.systemDetail': 'Seguir o idioma preferido deste dispositivo', 'language.accountDetail': 'Predefinição do sistema ou 8 idiomas suportados',
  },
}

interface LocaleStorage {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
}

interface LocaleControllerOptions {
  readonly document: Document
  readonly languages: readonly string[]
  readonly storage: LocaleStorage
}

export interface LocaleController {
  readonly preference: Ref<LocalePreference>
  readonly locale: ComputedRef<SupportedLocale>
  readonly t: (key: MessageKey, values?: Readonly<Record<string, string | number>>) => string
  readonly setPreference: (preference: LocalePreference) => void
}

const supportedByLowercase = new Map<string, SupportedLocale>(SUPPORTED_LOCALES.map((locale) => [locale.toLowerCase(), locale]))

export function resolveSupportedLocale(languages: readonly string[]): SupportedLocale {
  for (const requested of languages) {
    const normalized = requested.trim().replace('_', '-').toLowerCase()
    const exact = supportedByLowercase.get(normalized)
    if (exact) return exact
    const base = normalized.split('-')[0]
    if (!base) continue
    const baseLocale = supportedByLowercase.get(base)
    if (baseLocale) return baseLocale
    const regional = SUPPORTED_LOCALES.find((locale) => locale.toLowerCase().startsWith(`${base}-`))
    if (regional) return regional
  }
  return 'en'
}

export function readLocalePreference(storage: Pick<LocaleStorage, 'getItem'>): LocalePreference {
  try {
    const stored = storage.getItem(LOCALE_STORAGE_KEY)
    return stored === 'system' || SUPPORTED_LOCALES.some((locale) => locale === stored) ? stored as LocalePreference : 'system'
  } catch {
    return 'system'
  }
}

export function createLocaleController(options: LocaleControllerOptions): LocaleController {
  const preference = ref<LocalePreference>(readLocalePreference(options.storage))
  const locale = computed<SupportedLocale>(() => preference.value === 'system' ? resolveSupportedLocale(options.languages) : preference.value)
  const applyDocumentLanguage = () => { options.document.documentElement.lang = locale.value }
  applyDocumentLanguage()
  return {
    preference,
    locale,
    t(key, values = {}) {
      const template = catalogs[locale.value][key] ?? englishMessages[key]
      return template.replace(/\{([A-Za-z][A-Za-z0-9]*)\}/g, (placeholder, name: string) => name in values ? String(values[name]) : placeholder)
    },
    setPreference(next) {
      preference.value = next
      applyDocumentLanguage()
      try { options.storage.setItem(LOCALE_STORAGE_KEY, next) } catch { /* keep the in-memory choice when storage is unavailable */ }
    },
  }
}

function browserStorage(): LocaleStorage {
  return typeof window !== 'undefined' && window.localStorage
    ? window.localStorage
    : { getItem: () => null, setItem: () => undefined }
}

export const localeController = createLocaleController({
  document,
  languages: typeof navigator === 'undefined' ? ['en'] : navigator.languages,
  storage: browserStorage(),
})

export function useI18n(): LocaleController {
  return localeController
}
