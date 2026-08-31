import { readRuntimeConfiguration } from './firebase'
import { getSplitUnwiseFirebaseApp } from './firebaseBootstrap'

const callables = new Map<string, Promise<(data: unknown) => Promise<{ readonly data: unknown }>>>()

/** Protected callable access routed through the single named Firebase bootstrap. */
export async function callSplitUnwiseFunction(name: string, data: unknown, options: { readonly replayProtected?: boolean } = {}): Promise<unknown> {
  const runtime = readRuntimeConfiguration()
  if (runtime.kind !== 'firebase' || !runtime.functionsRegion) throw new Error('Secure cloud functions are not configured for this build.')
  const key = `${runtime.firebase.projectId}:${runtime.functionsRegion}:${name}:${options.replayProtected === true}`
  let ready = callables.get(key)
  if (!ready) {
    ready = Promise.all([getSplitUnwiseFirebaseApp(runtime.firebase), import('firebase/functions')]).then(([app, functions]) => {
      const callable = functions.httpsCallable(functions.getFunctions(app, runtime.functionsRegion!), name, { limitedUseAppCheckTokens: options.replayProtected === true })
      return (payload: unknown) => callable(payload)
    })
    callables.set(key, ready)
  }
  return (await (await ready)(data)).data
}
