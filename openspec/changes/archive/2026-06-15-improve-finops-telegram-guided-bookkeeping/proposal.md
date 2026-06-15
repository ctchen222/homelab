## Why

Telegram bookkeeping currently depends on users remembering command formats such as `expense <amount> [currency] <category> <account>`. This makes the fastest input path brittle because the user often does not know the available categories, accounts, or exact aliases at the moment of entry.

This change makes Telegram bookkeeping guided and button-driven while keeping ezBookkeeping as the source of truth and keeping LLMs out of the write path.

## What Changes

- Add a Telegram-native guided bookkeeping flow using inline keyboards and `callback_query` updates.
- Support quick sentence input such as `lunch 120` or `coffee 80`, defaulting ambiguous quick entries to expense, extracting obvious amount/date/note details, and using buttons to fill missing category and account fields.
- Store bookkeeping drafts in assistant SQLite state until the user explicitly confirms the final transaction.
- Support daily bookkeeping dates by defaulting to today and allowing basic backfill dates such as today, yesterday, the day before yesterday, `YYYY-MM-DD`, and `MM/DD`.
- Show ezBookkeeping categories and accounts as Telegram inline buttons, including pagination, common/recent options, and a path for more options.
- Define the Telegram button implementation contract for draft-step keyboards, compact callback payloads, message editing, callback validation, and button-specific tests.
- Treat ordinary text replies during an active draft as input for the current draft step instead of starting another draft.
- Allow creating a new ezBookkeeping category from Telegram only after an explicit confirmation flow; unknown categories must not be created automatically.
- Keep account/payment-method creation out of this change; Phase 2 only selects existing ezBookkeeping accounts.
- Add callback idempotency, draft expiry, cancellation, edit-before-confirm, and safe failure behavior for ezBookkeeping API errors.
- Require the production Telegram webhook registration to include `callback_query` in `allowed_updates`.
- Preserve existing text commands for status, help, overview, categories, accounts, category add/confirm, and fully specified transaction commands.
- Leave Telegram Mini App / Web App UI to a separate follow-on change.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `finops-app`: add guided Telegram bookkeeping requirements for quick sentence intake, daily bookkeeping dates, active draft text replies, inline keyboard option discovery, draft confirmation, guarded category creation, callback idempotency, and production webhook callback support.

## Impact

- Affected code:
  - `apps/finops-assistant/src/telegram.ts`
  - `apps/finops-assistant/src/parser.ts`
  - `apps/finops-assistant/src/storage.ts`
  - `apps/finops-assistant/src/types.ts`
  - `apps/finops-assistant/src/ezbookkeeping.ts`
  - `apps/finops-assistant/src/app.ts`
  - `apps/finops-assistant/test/*.test.cjs`
- Affected deployment/config:
  - Telegram webhook registration and documentation must include `callback_query`.
  - Helm values/runbook must call out the guided flow production verification steps.
- Affected systems:
  - Telegram Bot API inline keyboards, callback queries, and callback acknowledgements.
  - ezBookkeeping category/account discovery, category creation, and transaction write APIs.
  - Assistant SQLite state and backup ownership.
- Non-impact:
  - No Telegram Mini App frontend.
  - No new payment-method/account creation from Telegram.
  - No broker sync, investment research, trading, or LLM-driven write behavior.
