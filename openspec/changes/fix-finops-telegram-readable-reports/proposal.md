## Why

The FinOps Telegram assistant report and command responses are becoming more readable through zh-TW copy and Telegram HTML formatting, but that formatting changes user-visible report contracts and can introduce delivery failures if unsafe text is rendered as HTML. This change documents the intended readable-report behavior and keeps partial-failure reporting explicit instead of silently dropping failed sections.

## What Changes

- Render Telegram assistant messages and report summaries with safe Telegram HTML formatting where useful.
- Keep a plain-text fallback for malformed HTML entities, but only when Telegram rejects a message because it cannot parse entities.
- Change the daily report into a concise zh-TW summary that emphasizes yesterday spending, current-month income/expense/cashflow, large-expense warnings, pending reviews, and watchlist visibility.
- Preserve partial-report behavior when ezBookkeeping, watchlist parsing, or LLM summarization is unavailable.
- Keep LLM summary output as commentary only and make LLM unavailability visible in the report status and body.
- Do not change broker execution, investment recommendations, Mini App behavior, or the autonomous market recommendation agent.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `finops-app`: refine Telegram report/message rendering, daily report content shape, watchlist visibility, LLM partial-failure behavior, and HTML fallback safety.

## Impact

- Affected code:
  - `apps/finops-assistant/src/telegram.ts`
  - `apps/finops-assistant/src/report.ts`
  - `apps/finops-assistant/src/app.ts`
  - FinOps assistant report and Telegram tests
- Affected APIs/systems:
  - Telegram Bot API `sendMessage` and `editMessageText` payloads now include `parse_mode: HTML` where the assistant sends formatted text.
  - Telegram webhook shortcut replies preserve `parse_mode` when returning a Bot API-compatible response body.
  - The optional LLM summary endpoint receives a plain context string for commentary generation instead of internal report-section objects.
- Non-impact:
  - No changes to ezBookkeeping source-of-truth writes.
  - No changes to Wealthfolio, broker sync, trading, or market recommendation agent scope.
