## 1. Telegram Rendering

- [x] 1.1 Send formatted Telegram assistant messages with `parse_mode: HTML`.
- [x] 1.2 Escape dynamic report, category, account, alias, error, note, watchlist, and LLM text before rendering HTML.
- [x] 1.3 Preserve `parse_mode` in webhook shortcut sendMessage responses.
- [x] 1.4 Retry as plain text only when Telegram rejects HTML because it cannot parse entities.

## 2. Daily Report Contract

- [x] 2.1 Generate a concise zh-TW daily report with yesterday spending and current-month totals.
- [x] 2.2 Include pending review count, large-expense warnings, and watchlist summary in daily reports.
- [x] 2.3 Mark malformed or missing watchlist data as partial instead of silently omitting it.
- [x] 2.4 Write plain-text report artifacts and record report history with status and artifact path.

## 3. LLM Commentary

- [x] 3.1 Send only plain report context plus risk framing to the optional LLM summary endpoint.
- [x] 3.2 Append escaped LLM commentary when available.
- [x] 3.3 Mark enabled-but-missing, failed, or empty LLM commentary as partial.

## 4. Verification

- [x] 4.1 Add regression tests for HTML entity fallback and non-HTML Telegram 400 behavior.
- [x] 4.2 Add regression tests for escaped category-confirm placeholder text.
- [x] 4.3 Add regression tests for malformed watchlist and LLM partial report behavior.
- [x] 4.4 Run `npm test` for `apps/finops-assistant`.
- [x] 4.5 Run `openspec validate --all --strict`.
