## Context

The FinOps assistant already accepts Telegram text messages, checks the Telegram user allowlist, stores processed update IDs, supports category/account discovery commands, can create ezBookkeeping categories through explicit text commands, and writes final transactions to ezBookkeeping.

The current UX still assumes users remember command syntax and aliases. The user wants a Phase 2 experience that uses Telegram-native buttons and quick sentence parsing before exploring a Phase 3 Telegram Mini App.

Current constraints:

- ezBookkeeping remains the bookkeeping source of truth.
- The assistant must not let an LLM mutate bookkeeping data.
- Telegram callbacks must use the same allowlist and webhook secret boundary as messages.
- Production has a known dependency on a valid ezBookkeeping API token and at least one usable account/payment method.
- Phase 2 must not introduce a web frontend or Telegram Mini App.

## Goals / Non-Goals

**Goals:**

- Let an allowlisted user start a bookkeeping draft from a quick sentence such as `lunch 120`.
- Default ambiguous quick sentence drafts to `expense` while allowing explicit income or transfer wording to override the type.
- Support basic daily bookkeeping dates for today and common backfill cases before confirmation.
- Use Telegram inline keyboards to select existing ezBookkeeping categories and accounts.
- Let the user create a new ezBookkeeping category from Telegram only after explicit confirmation.
- Require an explicit confirmation button before writing a transaction to ezBookkeeping.
- Make callback handling idempotent and safe under Telegram retries and repeated button taps.
- Preserve existing command-based flows for users who already know the syntax.
- Shape the draft model so a future Mini App can submit or complete the same kind of bookkeeping draft.

**Non-Goals:**

- Do not build a Telegram Mini App, Web App, or custom browser UI.
- Do not create new ezBookkeeping accounts/payment methods from Telegram.
- Do not add broad natural-language understanding or LLM classification to the write path.
- Do not implement charts, dashboards, portfolio workflows, broker sync, or investment recommendations.
- Do not treat production deployment as complete until ezBookkeeping token/account prerequisites are verified separately.

## Decisions

### Decision 1: Use inline keyboards, not reply keyboards, for draft steps

Each guided step sends or edits a Telegram message with an inline keyboard attached to the current draft. Inline keyboards are tied to the message and produce `callback_query` updates with `callback_data`, which makes them a better fit than persistent reply keyboards for selecting category, account, pagination, edit, cancel, and confirm actions.

Callback data remains short:

```text
finops:d:<draftId>:<action>:<value>
```

Examples:

```text
finops:d:abc123:cat:456
finops:d:abc123:acct:789
finops:d:abc123:page:cat:2
finops:d:abc123:newcat
finops:d:abc123:confirm
finops:d:abc123:cancel
```

The callback payload must not contain full transaction details, account names, category names, or secrets. The assistant resolves all real state from SQLite and ezBookkeeping APIs.

Alternative considered: reply keyboard. Reply keyboards are useful for global shortcuts, but they are less precise for one draft and do not naturally carry draft-specific state.

### Decision 2: Persist guided drafts in assistant SQLite

The assistant stores a bookkeeping draft before asking for missing data. The draft is the source of truth for the guided flow until it is confirmed, cancelled, expired, or failed.

Draft fields:

```text
draft_id
user_id
chat_id
source_update_id
type: expense | income | transfer
amount
currency
transaction_date
category_id
category_name
category_alias
account_id
account_name
account_alias
from_account_id
to_account_id
note
step
status: active | confirmed | cancelled | expired | failed
write_transaction_id
created_at
updated_at
expires_at
failure_reason
```

For Phase 2, `expense` and `income` are the primary guided flows. Transfer can use the same draft model, but implementation can keep transfer behind explicit tasks and tests because it needs two account choices.

The assistant should allow only one active draft per user/chat by default. If a new guided bookkeeping message arrives while another draft is active, the assistant should either resume the active draft or ask the user to cancel it first. This avoids ambiguous free-text replies.

While a draft is active, ordinary text replies are interpreted by the current draft step before the generic message parser runs. For example, text entered during amount entry updates the amount, text entered during new-category-name entry becomes the category name, and text entered during custom-date entry is parsed as the draft date. Explicit slash commands such as `/help`, `/cancel`, and `/status` may bypass the draft step.

Alternative considered: keep draft state only in Telegram messages. This is rejected because Telegram retries, old button taps, message edits, and future Mini App handoff all need durable state.

### Decision 3: Quick sentence parsing defaults to expense and only extracts low-risk fields

Quick sentence parsing is a helper, not a natural-language classifier. It should extract:

- positive amount
- default currency
- basic transaction date when the sentence contains today, yesterday, the day before yesterday, `YYYY-MM-DD`, or `MM/DD`
- note text
- optional explicit type when the user uses known type words or presses a start button

If no explicit type is found, the assistant creates an `expense` draft. A sentence such as `lunch 120` or `coffee 80` should not ask the user to choose expense/income/transfer before showing expense category options. Explicit income or transfer wording can override the default, such as `income salary 50000`, `收入 salary 50000`, `transfer 1000`, or `轉帳 1000`.

For example:

```text
lunch 120
coffee 80
昨天 lunch 120
2026-06-10 coffee 80
salary 50000
```

If no date is found, the assistant uses the bot's configured local date, expected to be `Asia/Taipei` in production. Future dates are rejected for Phase 2 daily bookkeeping instead of being accepted as scheduled transactions.

If category or account cannot be matched with high confidence, the assistant must ask with buttons instead of guessing.

Alternative considered: infer category from note text. This is deferred because misclassification writes bad finance data. Future versions can rank suggested categories, but confirmation remains required.

### Decision 4: Discover categories and accounts from ezBookkeeping at selection time

The category and account selection keyboards are built from ezBookkeeping APIs, not from hardcoded aliases alone. The assistant may use local aliases and recent usage to sort or label options, but ezBookkeeping IDs are the canonical values.

Keyboard behavior:

- Show a compact first page of common or recent options.
- Include `More`, `Back`, and `Cancel` controls when needed.
- Provide a `New category` action on category selection pages.
- Do not provide a `New account` action in this change.

This keeps the user from needing to remember what categories or payment methods exist.

### Decision 4a: Treat Telegram buttons as an explicit draft-step contract

The guided flow should centralize Telegram inline keyboard rendering in state-specific builders instead of constructing ad hoc buttons inside each handler. Each builder receives the current draft, the relevant option page, and any ezBookkeeping options needed for that step, then returns Telegram `reply_markup.inline_keyboard` rows.

Button rows by draft step:

```text
type selection:
  Expense | Income | Transfer
  Cancel

date selection:
  Today | Yesterday | Day before yesterday
  Custom date
  Back | Cancel

category selection:
  recent/common category buttons
  More/Prev/Next pagination when needed
  New category
  Edit type | Cancel

account selection:
  recent/common account buttons
  More/Prev/Next pagination when needed
  Edit category | Cancel

new category name:
  Back | Cancel

new category parent:
  parent category buttons
  More/Prev/Next pagination when needed
  Back | Cancel

new category confirmation:
  Create and use | Only create
  Back | Cancel

confirmation:
  Confirm
  Edit type | Edit date | Edit amount
  Edit category | Edit account | Add/Edit note
  Cancel
```

Callback payloads use a short grammar and never include user-visible names:

```text
finops:d:<draftId>:<action>[:<value>]
```

Supported Phase 2 actions:

```text
type:<expense|income|transfer>
date:<today|yesterday|day_before_yesterday>
date_custom
cat:<categoryId>
cat_page:<page>
cat_new
acct:<accountId>
acct_page:<page>
newcat_parent:<categoryId>
newcat_confirm:<create_use|create_only>
edit:<type|date|amount|category|account|note>
confirm
cancel
```

The implementation must keep `callback_data` below Telegram's 64-byte callback data limit. If draft IDs are long, the draft ID used in callbacks should be a compact opaque public ID that maps to the full SQLite draft row.

Button handling order:

1. Parse callback data and reject malformed payloads.
2. Apply the same Telegram allowlist check used for messages.
3. Load the draft by callback draft ID.
4. Verify the callback user and chat match the draft owner.
5. Reject callbacks for confirmed, cancelled, expired, or failed drafts.
6. Verify the action is valid for the draft's current step.
7. Mutate only the server-side draft state needed by the action.
8. Render the next prompt and keyboard from the new draft state.
9. Acknowledge the callback with `answerCallbackQuery` for both success and rejection.

The assistant should update the existing Telegram prompt when possible:

- Use `editMessageText` when the prompt text and keyboard both change.
- Use `editMessageReplyMarkup` when only pagination or button state changes.
- Send a new message only when there is no editable message ID or Telegram rejects the edit because the message is too old or unchanged.

Repeated button taps should be harmless. Selecting the already-selected category or account should re-render or acknowledge the current state without creating another draft. Repeated confirm callbacks are covered by the confirmed draft marker and must write at most one ezBookkeeping transaction.

### Decision 5: New categories require a guarded creation subflow

Unknown categories or the `New category` button enter a guarded subflow:

```text
new category name -> parent category selection -> create confirmation -> create in ezBookkeeping -> use in current draft
```

The assistant must not create a category only because the user typed an unknown word. Category creation requires an explicit `Create and use` or equivalent confirmation action.

If category creation succeeds but the transaction write later fails, the created category remains in ezBookkeeping and the draft is preserved as failed or pending. The assistant must tell the user the category was created but the transaction was not confirmed.

### Decision 6: Confirmation is the only write point

The assistant writes to ezBookkeeping only after the draft reaches a confirmation screen and the user presses `Confirm`.

Confirmation message contents:

```text
type
transaction date
amount and currency
category
account or from/to accounts
note
```

Confirmation controls:

```text
Confirm
Edit type
Edit date
Edit amount
Edit category
Edit account
Add/Edit note
Cancel
```

Repeated confirm callbacks must not create duplicate transactions. A confirmed draft stores the result or write marker so the second callback returns an already-handled response.

### Decision 7: Callback handling must acknowledge every callback

Every callback query should call Telegram `answerCallbackQuery`, even when the action is rejected. This prevents the Telegram client from leaving the button spinner active.

For rejected callbacks, the visible message can remain unchanged while `answerCallbackQuery` explains the short reason, such as expired draft, unauthorized user, or already confirmed.

### Decision 8: Production webhook registration must include callback updates

The production bot registration must include `callback_query` in `allowed_updates`. Without it, the assistant can render buttons but never receive button taps.

The current deployment verifier should check `getWebhookInfo` and treat missing `callback_query` as a Phase 2 production blocker.

### Decision 9: Phase 3 Mini App should reuse the draft boundary

Phase 2 does not build a Mini App, but the draft model should be stable enough for a future Mini App to create, update, and confirm the same draft shape through authenticated backend endpoints.

This keeps Phase 3 from inventing a second transaction-write path.

## Risks / Trade-offs

- [Risk] Telegram callback data has a small size limit. -> Mitigation: store only short draft IDs and action IDs in callback data; keep state in SQLite.
- [Risk] Category/account lists may be too long for a single keyboard. -> Mitigation: add pagination and recent/common sorting.
- [Risk] ezBookkeeping API token is invalid or expired. -> Mitigation: category/account discovery and confirmation must fail visibly and preserve drafts; production verification must test the token before rollout.
- [Risk] Users may tap old buttons after a draft was completed. -> Mitigation: check draft status and expiry on every callback before mutating state.
- [Risk] Multiple active drafts can make text replies ambiguous. -> Mitigation: allow one active draft per user/chat by default and require cancel/resume behavior.
- [Risk] New category creation can pollute finance taxonomy. -> Mitigation: require explicit parent selection and confirmation; never auto-create from unknown text.
- [Risk] Account creation is useful but riskier than category creation. -> Mitigation: Phase 2 only selects existing accounts; account/payment-method creation is a follow-up.
- [Risk] A future Mini App could bypass the safe write path. -> Mitigation: document the draft model as the shared boundary for Phase 3.

## Migration Plan

1. Add draft storage schema to assistant SQLite with backward-compatible `CREATE TABLE IF NOT EXISTS` migrations.
2. Add Telegram update parsing for `callback_query` while keeping existing message parsing.
3. Add Telegram send/edit helpers that support inline keyboards and callback acknowledgements.
4. Add quick sentence parser output that can create an incomplete draft instead of pending review.
5. Add category/account keyboard builders backed by ezBookkeeping APIs.
6. Add draft state transitions for amount, date, category selection, account selection, category creation, confirmation, cancellation, expiry, and failure.
7. Add tests for message-to-draft, active draft text replies, each callback transition, idempotency, and safe failure cases.
8. Update Helm/runbook/webhook documentation to include `callback_query`.
9. Verify locally with mocked Telegram and ezBookkeeping APIs.
10. Verify on VPS only after ezBookkeeping API token and account setup are valid, then create and clean up one non-production transaction.

Rollback strategy:

- Keep existing text command behavior intact so guided flow can be disabled by config or reverted without losing core Telegram commands.
- If production callbacks fail, remove `callback_query` from the webhook registration and leave text commands operating.
- Do not delete assistant SQLite state during rollback unless explicitly requested.

## Open Questions

- What default draft timeout should be used for production, for example 10 or 15 minutes?
- Should the first guided release support transfer end to end, or ship expense/income first and add transfer immediately after?
- Should category sorting be purely recent/common first, or should it also group by ezBookkeeping parent category?
