export interface HydratableFirebaseAuth {
  authStateReady(): Promise<void>
  readonly currentUser: { readonly uid: string } | null
}

/** The only boundary that decides whether Firebase has an authenticated user. */
export async function resolveFirebaseSession(auth: HydratableFirebaseAuth): Promise<{ readonly userId: string }> {
  await auth.authStateReady()
  if (!auth.currentUser) throw new Error('A signed-in Firebase user is required')
  return { userId: auth.currentUser.uid }
}
