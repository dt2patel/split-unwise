# WebMCP support

Split Unwise registers browser-local WebMCP tools after an authenticated app session mounts. Browsers without `document.modelContext` continue to use the app normally; no WebMCP polyfill or remote agent service is required.

## Available tools

- `list_groups`: list the signed-in user's authorized groups.
- `get_group_balances`: read pairwise or simplified debts for one authorized group.
- `search_expenses`: search fresh, non-deleted expenses with text, group, date, currency, and amount filters.
- `get_expense_details`: read one expense's split, participants, audit state, and optional notes.
- `open_expense_form`: navigate to the visible Add Expense form without saving anything.

Read tools use the existing authenticated repository boundary, so an agent cannot use these tools to bypass Split Unwise authorization. Descriptions, categories, notes, and other user-authored text are marked as untrusted content. Tool results are capped to keep agent context bounded.

There are intentionally no WebMCP tools for creating expenses, recording settlements, deleting data, or changing group settings. Those actions remain explicit user-controlled UI flows.

WebMCP is a progressive enhancement. It requires a compatible browser/client and is available only while the authenticated Split Unwise tab is open. It complements rather than replaces a server-side MCP integration.
