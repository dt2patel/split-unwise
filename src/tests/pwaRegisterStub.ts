/** vite-plugin-pwa serves virtual:pwa-register in real builds; tests import this inert stand-in instead. */
export function registerSW(): (reloadPage?: boolean) => Promise<void> {
  return async () => undefined
}
