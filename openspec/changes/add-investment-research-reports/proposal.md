## Why

The portfolio sync foundation should establish trusted broker holdings and Wealthfolio display before any investment research report is generated. Daily research reports have a different risk profile: market data licensing, news/source attribution, LLM summarization, recommendation wording, source freshness, and Telegram privacy.

This change adds the research and reporting layer after `add-investment-intelligence-broker-sync`: Taiwan/US market data, official filings, news/theme intelligence, deterministic signals, recommendation policy, and LLM-rendered Telegram investment research reports.

## What Changes

- Consume normalized portfolio snapshots from `add-investment-intelligence-broker-sync` without reading broker credentials or raw broker payloads.
- Add Taiwan and US market-universe ingestion beyond the small FinOps watchlist.
- Add official filing, approved news/RSS, and market narrative ingestion for Taiwan and US markets.
- Add an approved source registry that records market data, official filings, news/RSS, narrative providers, source contracts, freshness rules, licensing, retention, and rate limits.
- Add LLM-derived narrative evidence for summarization, translation, entity extraction, theme clustering, risk extraction, and contradiction extraction.
- Add deterministic market, narrative, and portfolio-aware signal generation.
- Add recommendation policy gates that turn evidence into review-oriented categories such as observe, add-to-watchlist, review-add, review-reduce, rebalance-check, and no-action.
- Add a deterministic report production and credibility workflow so each report can explain its evidence coverage, freshness, recommendation score, verifier result, artifact provenance, and post-report outcome tracking.
- Add enforceable runtime security boundaries that prevent investment research jobs from loading broker credentials, raw broker import files, Wealthfolio UI state, or public `/internal` report routes.
- Add scheduled and on-demand Telegram investment research reports with source freshness, evidence, risk, confidence, invalidation conditions, and private detailed artifacts.
- Keep research reports as commentary and explicitly forbid broker execution, broker account mutation, or automatic trade execution.

## Out of Scope

- Broker credential setup and direct broker sync.
- Writing holdings into Wealthfolio.
- Mutating the normalized portfolio snapshot store.
- Automated order placement, order modification, cash movement, or account mutation.
- Treating LLM output as final investment authority.
- Free-form web scraping, arbitrary browser search, or LLM-autonomous internet research as a production source.

Those are intentionally separate from portfolio sync.

## Capabilities

### New Capabilities

- `investment-research-reports`: Research layer that consumes normalized portfolio snapshots, market data, official filings, approved news, deterministic signals, recommendation policy, and LLM summarization to deliver daily Taiwan/US investment research reports.

### Modified Capabilities

- None. This change consumes `investment-portfolio-sync` outputs but does not modify broker sync or Wealthfolio display behavior.

## Impact

- Adds a new OpenSpec capability under `investment-research-reports`.
- Future implementation may add market data jobs, news/filing ingestion jobs, narrative evidence storage, signal-generation modules, recommendation policy configuration, report rendering, Telegram delivery, and provider secrets/configuration.
- Requires production-approved market data and news/filing providers with licensing, retention, and rate-limit review.
- Requires an internal on-demand report trigger such as `/internal/reports/investment-intelligence` plus an allowlisted Telegram command that calls the internal trigger without exposing it publicly.
- Requires source attribution, freshness, deduplication, ticker mapping, confidence scoring, and LLM guardrails before reports are sent.
- Requires privacy controls for personal portfolio context in Telegram.
- Requires pre-delivery verification, private artifact handoff, redacted audit events, shadow-mode paper tracking, and recommendation postmortems before increasing recommendation confidence.
