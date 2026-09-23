# WebMCP support

Split Unwise registers browser-local WebMCP tools after an authenticated app session mounts. Browsers without `document.modelContext` continue to use the app normally; no WebMCP polyfill or remote agent service is required.

## Available tools

- `whoami`: the signed-in user. Balances in the other tools are from this user's point of view.
- `list_groups`: list the signed-in user's authorized groups, including one-to-one friend ledgers.
- `list_group_members`: list a group's members and their participant IDs, so an agent can turn a name into an ID.
- `get_group_balances`: read pairwise or simplified debts for one authorized group, each with a one-line summary.
- `get_friend_balances`: what each person owes the user, or is owed, across all groups, with a per-group breakdown and per-currency totals. Currencies are never combined.
- `search_expenses`: search fresh, non-deleted expenses with text, group, date, currency, and amount filters.
- `get_expense_details`: read one expense's split, participants, audit state, and optional notes.
- `list_recent_activity`: the newest expense, comment, payment, and membership changes across the user's groups.
- `add_expense`: open the Add Expense form prefilled with an agent's details (description, amount, currency, date, category, notes, payer, and who it is split equally between) for the user to review and save.
- `record_settlement`: open Settle Up prefilled to record that the user and one other member paid each other outside Split Unwise, for the user to confirm and record. It never moves money. It is marked `consequentialHint`.

Read tools use the existing authenticated repository boundary, so an agent cannot use these tools to bypass Split Unwise authorization. Group names, member names, descriptions, categories, notes, and other user-authored text are written by other members, so every tool that returns them is marked `untrustedContentHint`. Tool results are capped to keep agent context bounded.

Every amount is returned as `minorAmount` (integer minor units), `amount` (a decimal string), and `formatted` (a display string), because minor units alone are easy for a model to misread. Balances seen from the user's side use `direction: owes_you | you_owe | settled` with a non-negative amount instead of a signed number.

An agent task often reads the same data several times, so a read is reused for 30 seconds instead of re-reading every document; failed reads are never reused. The expense in `get_expense_details` is always read fresh.

## Changes need the user

The two write tools never save anything themselves. The tool validates what the agent sent (members, amounts, open balances) before anything opens, hands the details to the app as a one-time draft (`src/app/agentDrafts.ts`), and opens the real editor or Settle Up screen in the user's tab with them filled in. The draft is taken only by the same account and group it was offered for, and at most once.

The user then checks it and taps Save, or, for a payment, confirms it already happened and taps Record. The same queue, validation, and security rules apply as when they typed it themselves. The tool call waits for that decision and returns one of these results:

- `saved`, with the new expense or settlement ID;
- `queued`, when the save was accepted on the device but is waiting for the connection;
- `failed`, when the server rejected it; it stays in the queue for the user to retry or discard;
- `cancelled`, when the user left without saving, a newer request replaced it, the form never opened, the user signed out, or the agent stopped waiting. If the agent stops waiting, the prefilled form stays on screen for the user.

The confirmation lives in the app because the WebMCP spec doesn't require browsers or agents to confirm anything, and text written by other members can carry prompt injection. It stops an agent that only calls tools. It can't stop an agent that also drives the page itself and taps Save, which is why the prefilled form says an AI agent filled it in.

Deleting data and changing group settings stay UI-only.

WebMCP is a progressive enhancement. It requires a compatible browser/client and is available only while the authenticated Split Unwise tab is open. It complements rather than replaces a server-side MCP integration.

## Trying it

The site isn't enrolled in Chrome's WebMCP origin trial, so in Chrome the tools appear only after turning on `chrome://flags/#enable-webmcp-testing`. Chrome's Model Context Tool Inspector extension lists the registered tools and can call them by hand. Enrolling later means adding the trial's token as an `Origin-Trial` header in `firebase.json`.
