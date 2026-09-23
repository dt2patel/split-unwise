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
- `open_expense_form`: navigate to the visible Add Expense form without saving anything.

Read tools use the existing authenticated repository boundary, so an agent cannot use these tools to bypass Split Unwise authorization. Group names, member names, descriptions, categories, notes, and other user-authored text are written by other members, so every tool that returns them is marked `untrustedContentHint`. Tool results are capped to keep agent context bounded.

Every amount is returned as `minorAmount` (integer minor units), `amount` (a decimal string), and `formatted` (a display string), because minor units alone are easy for a model to misread. Balances seen from the user's side use `direction: owes_you | you_owe | settled` with a non-negative amount instead of a signed number.

An agent task often reads the same data several times, so a read is reused for 30 seconds instead of re-reading every document; failed reads are never reused. The expense in `get_expense_details` is always read fresh.

There are intentionally no WebMCP tools for creating expenses, recording settlements, deleting data, or changing group settings. Those actions remain explicit user-controlled UI flows.

WebMCP is a progressive enhancement. It requires a compatible browser/client and is available only while the authenticated Split Unwise tab is open. It complements rather than replaces a server-side MCP integration.
