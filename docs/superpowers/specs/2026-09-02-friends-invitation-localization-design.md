# Friends and Invitation Localization Design

## Purpose

Finish the signed-in Friends and invitation journey so every application-owned message is safe, locale-reactive, and mobile-usable in the eight supported Split Unwise locales. Preserve the production invitation security and multi-user behavior that already pass hosted proof.

## Product behavior

Splitwise's current help material routes mobile group membership through the selected group's settings and supports either adding a person's account details or sharing an invite link. Opening the link lets an invited person sign into an existing account and join. Split Unwise keeps the same mental model:

- Friends is the account-wide place to inspect direct and shared balances and start a two-person friendship by name and verified email.
- Group settings remains the place to prepare a private invitation link for a specific group.
- An invite link may require sign-in or email verification, then resumes the same invitation and joins the existing account.
- Split Unwise prepares and shares the link but does not claim to send an email automatically.

## Constraints

- Keep the existing Firestore invitation schema, 256-bit fragment secret, single-use behavior, seven-day expiry, verified-email gate, and two-person friendship cap unchanged.
- Do not deploy or modify Cloud Functions, Firestore rules, Storage, Auth configuration, or provider secrets in this slice.
- Keep all shared names, emails, group names, expense labels, currency codes, and invitation URLs as user data; never translate or mutate them.
- Route every application-owned Friends, Invite, and invitation-landing string through the typed `MessageKey` catalog for `en`, `es`, `de`, `nl`, `fr`, `it`, `pt-BR`, and `pt-PT`.
- Store retained errors and status feedback as semantic state (`DisplayMessage`, `ApplicationMessage`, or a discriminated invitation state), never as a rendered translation. Changing locale must update already-visible feedback without repeating the operation.
- Never expose an arbitrary `Error.message`. Only `ApplicationError` is translated and only `SafeRemoteDisplayError` may be shown verbatim.
- Preserve the existing unverified-email recovery and exact invited email. Internal failure classification may recognize the existing Spark/callable contract, but raw service text must not become UI copy.
- Format invitation expiry with the selected app locale.
- At 390 x 844 and 320 x 844, every Friends and invitation surface must remain within its visible document and Ionic scroll hosts, with 44-point controls and no horizontal rail.
- Preserve `.artifacts/**`, `ios/DerivedDataFresh/**`, and `output/**`.
- Every release gate includes the hosted production app and native iOS gesture proof on the exact deployed SHA.

## English message contract

The English catalog is the canonical key set. Other catalogs carry idiomatic translations with the same placeholders.

### Friends

```text
friends.title = Friends
friends.add = Add friend
friends.eyebrow = FRIEND BALANCES
friends.intro = See what you owe each person across direct expenses and every shared group.
friends.name = Friend's name
friends.namePlaceholder = Jordan Lee
friends.emailPlaceholder = jordan@example.com
friends.adding = Adding…
friends.invitationReady = Invitation ready
friends.sendPrivateLink = Send this private seven-day link to {email}.
friends.shareLink = Share link
friends.loading = Loading friends…
friends.yourFriends = Your friends
friends.empty = No shared balances yet. Add a friend or join a group to get started.
friends.updating = Updating…
friends.unavailable = Unavailable
friends.context.one = Across {count} shared context
friends.context.other = Across {count} shared contexts
friends.contextUnavailable.one = Across {count} shared context · some unavailable
friends.contextUnavailable.other = Across {count} shared contexts · some unavailable
friends.directExpenses = Direct expenses
friends.sharedGroup = Shared group
friends.error.enterName = Enter your friend's name.
friends.error.enterEmail = Enter the email your friend uses for Split Unwise.
friends.error.firebaseNotReady = Sign in to add a friend.
friends.error.addFailed = Your friend could not be added.
friends.status.readyFor = Private invitation ready for {email}.
```

Friends reuses `auth.email`, `groups.currency`, `groups.cancel`, `home.invitationPending`, `home.updatingBalances`, `home.balanceUnavailable`, and `home.direction.*` where the meaning is identical.

### Invitation preparation

```text
invite.backGroup = Group
invite.title = Invite people
invite.heading = Invite to {group}
invite.intro = Create a private, seven-day link. Split Unwise never sends it automatically.
invite.targetEmail = Target email
invite.optional = Optional
invite.emailPlaceholder = friend@example.com
invite.preparing = Preparing…
invite.prepare = Prepare invitation
invite.managerOnly = Only a group manager can invite members.
invite.privateCapability = Links are private, single-use, and expire after seven days.
invite.demoCapability = Demo mode creates a local preview only.
invite.ready = Invitation ready
invite.expires = Expires {date}
invite.urlAria = Prepared invitation URL
invite.revoked = Invitation revoked
invite.share = Share invitation
invite.revoke = Revoke invitation
invite.status.privateReady = Private seven-day invitation ready.
invite.status.demoReady = Local preview ready. It is not a cross-device production invitation.
invite.status.shared = Share sheet completed.
invite.status.copied = Invitation copied.
invite.status.cancelled = Sharing cancelled.
invite.status.manual = Select and copy the invitation below.
invite.status.revoked = Invitation revoked.
invite.error.managerOnly = Only a group manager can create an invitation.
invite.error.firebaseNotReady = Firebase is not ready for invitations.
invite.error.invalidResponse = Invitation service returned an invalid response.
invite.error.prepareFailed = The invitation could not be prepared.
invite.error.revokeFailed = The invitation could not be revoked.
```

### Invitation landing

```text
inviteLanding.kicker = SPLIT UNWISE INVITATION
inviteLanding.title = Join a shared group
inviteLanding.checking = Checking invitation…
inviteLanding.missing = This invitation link is missing or has already been opened.
inviteLanding.signInPrompt = Sign in to inspect and accept this private invitation.
inviteLanding.accountNotReady = Your signed-in account is not ready.
inviteLanding.alreadyMember = You already belong to {group}.
inviteLanding.invited = You're invited to join {group}.
inviteLanding.demoPreview = Demo invitation preview. Acceptance stays on this device and is not a production membership change.
inviteLanding.consumed = This invitation has already been consumed.
inviteLanding.joined = You joined the group.
inviteLanding.acceptFailed = This invitation could not be accepted.
inviteLanding.verificationSent = Verification email sent. Open it, then return here and check again.
inviteLanding.verificationSendFailed = The verification email could not be sent.
inviteLanding.notVerified = That email is not verified yet. Open the verification email, then check again.
inviteLanding.verificationCheckFailed = Email verification could not be checked.
inviteLanding.verifyToAccept = Verify {email} to accept this invitation.
inviteLanding.accountEmail = your account email
inviteLanding.differentEmail = This invitation was sent to a different verified email. Sign in with the invited account and open the link again.
inviteLanding.invalid = This invitation link is invalid, expired, or no longer available.
inviteLanding.verificationRequired = Email verification required
inviteLanding.resendVerification = Resend verification email
inviteLanding.checkingShort = Checking…
inviteLanding.verifiedAction = I've verified my email
inviteLanding.privacy = The private token was removed from this browser's address.
inviteLanding.signIn = Sign in to continue
inviteLanding.joining = Joining…
inviteLanding.join = Join group
inviteLanding.openGroup = Open group
inviteLanding.openDemo = Open demo groups
inviteLanding.goHome = Go home
```

## Minor grammar correction

The generic Activity restore notice must not grammatically bind a gendered participle to the fallback label `Expense`:

- French: `Restauration terminée : {label}.` and `Restauration terminée pour tout le monde : {label}.`
- Italian: `Ripristino completato: {label}.` and `Ripristino completato per tutti: {label}.`
- pt-BR: `Restauração concluída: {label}.` and `Restauração concluída para todos: {label}.`
- pt-PT: `Restauro concluído: {label}.` and `Restauro concluído para todos: {label}.`

## Verification

- Component tests prove Spanish rendering, interpolation that preserves names/emails, and retained error/status copy that reacts to a later locale switch.
- Catalog tests prove all eight catalogs have the exact English key set and matching placeholders.
- The complete app suite, Firebase emulator suite, production build, Capacitor sync, and native iOS build pass.
- Hosted browser proof checks Spanish Friends at 390 and 320 px, localized invitation preparation, localized existing-account invitation acceptance, and no overflow in visible Ionic scroll hosts.
- The existing complete hosted multi-user, removed-member, unverified-email, account-deletion, and iOS swipe-back journeys remain unchanged and pass on the deployed SHA.
