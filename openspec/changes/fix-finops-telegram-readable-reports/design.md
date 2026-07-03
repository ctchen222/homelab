## Context

The FinOps assistant sends both command replies and scheduled reports through Telegram. The readability update changes those messages from mostly plain Markdown-like text into zh-TW summaries with Telegram HTML formatting, while preserving existing bookkeeping, report, and partial-failure guarantees.

The risky boundary is Telegram HTML parsing: one unescaped `<...>` token can cause Telegram to reject the entire message. The report boundary is also user-visible: daily summaries should become concise without hiding watchlist state, pending review count, or unavailable optional sections.

## Goals / Non-Goals

**Goals:**

- Make Telegram report and command output readable in zh-TW on mobile.
- Use Telegram HTML parse mode only with escaped user/provider text.
- Preserve daily report visibility for bookkeeping status, watchlist state, pending reviews, large-expense warnings, and optional LLM commentary.
- Mark malformed watchlist data and LLM summary failures as partial reports.
- Keep webhook shortcut replies compatible with Telegram Bot API response bodies.

**Non-Goals:**

- Do not introduce the autonomous market recommendation agent.
- Do not add a Telegram Mini App.
- Do not change ezBookkeeping as the source of truth.
- Do not create broker execution, trading, or portfolio mutation behavior.
- Do not add a new market-research artifact ingestion path in this readability fix.

## Decisions

1. Use Telegram HTML parse mode for assistant messages that include formatting.

   Telegram supports a constrained HTML subset that is enough for headings and fixed-width ratio bars. The assistant escapes dynamic category, account, alias, note, error, and watchlist text before rendering it. This keeps the UX improvement local to the renderer instead of adding a new templating dependency.

2. Fallback to plain text only for Telegram entity-parse failures.

   Telegram returns HTTP 400 for multiple unrelated errors. The assistant only strips HTML and retries when the response body indicates Telegram could not parse entities. Other 400 errors remain visible as delivery failures so reply-markup, chat, or edit-state bugs are not hidden.

3. Keep the daily report concise but not lossy.

   The daily report now leads with yesterday spending and current-month totals because that is easier to read in Telegram. It still includes pending review count, large-expense warnings, and watchlist visibility. Missing or malformed data changes the report status to `partial` and is rendered in the message body.

4. Treat LLM output as optional commentary with explicit failure.

   If LLM summarization is enabled but misconfigured, unavailable, or returns empty content, the report becomes partial and includes a visible warning. The LLM receives plain report context only and cannot mutate bookkeeping or portfolio records.

## Risks / Trade-offs

- Telegram HTML supports only a limited tag set -> Keep formatting to `<b>` and `<code>` and escape all dynamic text.
- Plain-text fallback could hide real delivery bugs -> Retry only on entity-parse errors and log other failures.
- Condensed daily reports may omit detail that was previously visible in sectioned text -> Preserve core sections and rely on artifacts for the full generated text.
- Market-research highlights are still produced by a separate job path -> Do not invent new integration in this fix; leave broader market-report delivery to the dedicated market research changes.

## Migration Plan

1. Deploy the FinOps assistant image containing the renderer changes.
2. Trigger or wait for the daily and end-of-day report jobs.
3. Verify Telegram messages render with bold headings, no broken HTML entities, visible watchlist state, and visible partial warnings where applicable.
4. Roll back the assistant image if Telegram delivery fails repeatedly; no database migration is involved.

## Open Questions

None for this fix. Broader market-research delivery belongs to the existing investment research or autonomous recommendation-agent changes.
