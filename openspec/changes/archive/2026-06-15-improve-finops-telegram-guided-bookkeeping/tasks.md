## 1. Baseline and Data Model

- [x] 1.1 Reproduce the current Telegram text-command behavior with the existing `apps/finops-assistant` tests before changing guided flow code.
- [x] 1.2 Add guided bookkeeping draft types for draft status, draft step, transaction type, transaction date, compact callback actions, and category creation substeps.
- [x] 1.3 Add assistant SQLite schema for `bookkeeping_drafts` with safe `CREATE TABLE IF NOT EXISTS` migration behavior.
- [x] 1.4 Add store methods to create, read, update, cancel, expire, fail, and confirm drafts without changing existing pending-review storage.
- [x] 1.5 Add tests proving draft persistence, transaction date persistence, one-active-draft-per-user-chat behavior, cancellation, expiry, and no transaction write during draft creation.

## 2. Telegram Callback Intake

- [x] 2.1 Extend Telegram update extraction to support `callback_query` updates while preserving existing `message` and `edited_message` support.
- [x] 2.2 Add compact callback data parser and formatter for `finops:d:<draftId>:<action>:<value>` payloads.
- [x] 2.3 Add Telegram `answerCallbackQuery` helper and ensure every supported or rejected callback path acknowledges the callback.
- [x] 2.4 Apply the same Telegram allowlist checks to callback queries as message updates.
- [x] 2.5 Add tests for callback extraction, malformed callback data, unauthorized callback rejection, callback acknowledgement, and unsupported callback safety.

## 3. Quick Sentence Draft Start

- [x] 3.1 Add quick sentence parsing that extracts low-risk amount, default currency, basic daily transaction date, note text, and optional explicit transaction type without guessing category or account.
- [x] 3.2 Route incomplete quick sentence results into an expense bookkeeping draft by default instead of immediately storing them as pending review.
- [x] 3.3 Add guided start buttons and edit controls for explicit expense, income, and transfer selection when the user intentionally changes transaction type.
- [x] 3.4 Preserve existing fully specified text commands so they can still write directly or use the existing pending-review behavior.
- [x] 3.5 Add parser and Telegram tests for `lunch 120`, `coffee 80`, `昨天 lunch 120`, `2026-06-10 coffee 80`, explicit expense/income/transfer starts, missing amount, invalid/future dates, and fully specified command compatibility.

## 4. Inline Keyboard Rendering

- [x] 4.1 Add Telegram send/edit message helpers that can include `inline_keyboard` reply_markup without breaking current text-only replies.
- [x] 4.2 Add category keyboard builder backed by ezBookkeeping category APIs and filtered by expense, income, or transfer category type.
- [x] 4.3 Add account keyboard builder backed by ezBookkeeping account APIs and filtered to visible existing accounts.
- [x] 4.4 Add pagination controls for category and account keyboards when options exceed the configured page size.
- [x] 4.5 Add common/recent option ordering hooks using existing aliases or draft history where available, while keeping ezBookkeeping IDs canonical.
- [x] 4.6 Add tests that inspect outgoing Telegram payloads for category buttons, account buttons, pagination buttons, compact callback data, and no sensitive data in callback payloads.
- [x] 4.7 Add state-specific inline keyboard builders for type selection, date selection, category selection, account selection, new-category name, new-category parent, new-category confirmation, and final transaction confirmation.
- [x] 4.8 Add a Telegram prompt update strategy that uses `editMessageText` when prompt content changes, `editMessageReplyMarkup` when only buttons change, and a new message only when editing is unavailable.
- [x] 4.9 Add tests proving each draft step renders only the valid buttons for that step and keeps every `callback_data` payload within Telegram's 64-byte limit.

## 5. Guided Draft State Machine

- [x] 5.1 Implement transition from draft start to amount entry, date entry, category selection, account selection, type editing, and confirmation summary.
- [x] 5.2 Implement callback handling for selecting transaction type, transaction date shortcuts, category, account, pagination, edit type, edit date, edit amount, edit category, edit account, edit note, cancel, and confirm.
- [x] 5.3 Implement text reply handling within an active draft so amount, custom date, note, known category/account names, and new category name replies are interpreted by the current draft step rather than the generic parser.
- [x] 5.4 Render confirmation summaries with transaction date, transaction type, amount, currency, category, account, and note before any ezBookkeeping write.
- [x] 5.5 Add tests for the full quick sentence expense flow: message creates an expense draft, date defaults or parses correctly, category button updates draft, account button updates draft, confirmation renders, confirm writes exactly once.
- [x] 5.6 Add tests proving a new quick sentence during an active draft does not create a second draft and ordinary text is routed to the active draft step unless it is a supported slash command.
- [x] 5.7 Add tests for income flow and, if enabled in the implementation pass, transfer flow with from/to account selection.
- [x] 5.8 Add tests proving callbacks are rejected when the action is not valid for the draft's current step, including category buttons tapped during account selection and old confirmation buttons tapped after editing.

## 6. Guarded Category Creation

- [x] 6.1 Add guided `New category` action from category selection pages.
- [x] 6.2 Collect category name and parent category through draft substeps before calling ezBookkeeping.
- [x] 6.3 Render category creation confirmation with category name, type, parent category, and `Create and use`, `Only create`, and `Cancel` actions.
- [x] 6.4 Create the category through ezBookkeeping only after explicit confirmation and persist the alias mapping to the created category ID.
- [x] 6.5 Use the newly created category in the active draft when the user selects `Create and use`.
- [x] 6.6 Decline or defer account/payment-method creation requests and return the user to existing account selection.
- [x] 6.7 Add tests proving unknown text does not auto-create categories, category creation requires confirmation, created categories can be used in the active draft, and creation failures preserve the draft.

## 7. Idempotency and Safe Failure Behavior

- [x] 7.1 Ensure confirm callbacks are idempotent and store a confirmed marker or transaction result before returning success.
- [x] 7.2 Reject old callbacks for confirmed, cancelled, expired, or failed drafts without reopening the draft.
- [x] 7.3 Preserve drafts as failed or pending when ezBookkeeping category/account discovery, category creation, or transaction write returns 401, 5xx, or network errors.
- [x] 7.4 Ensure duplicate Telegram updates and duplicate callbacks cannot create duplicate ezBookkeeping transactions.
- [x] 7.5 Add tests for duplicate confirm, retry callback, expired draft callback, cancelled draft callback, ezBookkeeping token failure, category creation failure, and transaction write failure.

## 8. Deployment and Documentation

- [x] 8.1 Update Helm values, deployment notes, or runbook instructions so production `setWebhook` includes `callback_query` in `allowed_updates`.
- [x] 8.2 Add a production verification step using Telegram `getWebhookInfo` that fails the guided-flow gate when `callback_query` is missing.
- [x] 8.3 Document the guided user flows for quick sentence expense defaulting, daily date backfill, button start, category selection, account selection, guarded category creation, active draft text replies, confirmation, cancellation, and clean smoke testing.
- [x] 8.4 Document the Phase 3 Mini App handoff boundary: future UI must reuse the draft model and not create a second write path.

## 9. Verification

- [x] 9.1 Run `pnpm --filter finops-assistant test` or the repo-equivalent assistant test command and verify all existing and new tests pass, including date parsing, expense defaulting, and active draft text routing.
- [x] 9.2 Run TypeScript checks for `apps/finops-assistant` and verify the new draft/callback types compile.
- [x] 9.3 Run Helm template or chart checks needed to verify webhook/runbook changes do not break production rendering.
- [x] 9.4 Run `openspec validate improve-finops-telegram-guided-bookkeeping --strict`.
- [x] 9.5 Before production smoke testing, verify ezBookkeeping API token and at least one usable account exist.
- [x] 9.6 Smoke-test the guided flow on VPS with one clearly marked non-production transaction, verify it appears in ezBookkeeping, delete or revert it, and record that transaction count returns to the pre-test value.
- [x] 9.7 Verify production assistant logs do not expose callback payload secrets, account balances, raw finance payloads, or API tokens.
