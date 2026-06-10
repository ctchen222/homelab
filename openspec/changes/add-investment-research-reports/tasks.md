## 1. Scope and Data Contracts

- [ ] 1.1 Document dependency on `add-investment-intelligence-broker-sync` normalized snapshots.
- [ ] 1.2 Add an implementation gate that keeps personal portfolio report sections disabled until normalized snapshots are available and owner-reviewed.
- [ ] 1.3 Define market universe, official filing evidence, news evidence, narrative evidence, signal, recommendation, report artifact, and source freshness schemas.
- [ ] 1.4 Define approved-source rules for market data, official filings, licensed news APIs, RSS feeds, and owner-approved narrative sources.
- [ ] 1.5 Define LLM-derived evidence fields for source references, prompt/model metadata, extraction confidence, mapped symbols, theme tags, event type, and risk or contradiction notes.
- [ ] 1.6 Define source freshness rules for market data, filings, news, FX, portfolio snapshots, generated signals, and generated recommendations.
- [ ] 1.7 Define the `PortfolioSnapshotReader` contract with schema version, source type, as-of timestamp, freshness status, field-level coverage, account identity hash, and consumer capabilities.
- [ ] 1.8 Define a research runtime boundary that rejects broker credential keys, raw broker export mounts, broker web-login state, Wealthfolio scraping, and any direct broker payload access.
- [ ] 1.9 Define the end-to-end report production state machine: source capture, approval, deduplication, freshness, field coverage, LLM-derived evidence, deterministic signals, recommendation scoring, report assembly, pre-delivery verification, artifact handoff, Telegram delivery, audit, and postmortem.
- [ ] 1.10 Implement an approved source registry with source ID, provider, source class, approval status, license or permission basis, rate limit, retention rule, freshness policy, expected fields, sensitivity label, and failure behavior.

## 2. Market-Universe Ingestion

- [ ] 2.1 Add Taiwan market-universe ingestion for listed symbols using TWSE official or owner-approved data.
- [ ] 2.2 Add Taiwan OTC market-universe ingestion using TPEx official or owner-approved data.
- [ ] 2.3 Evaluate Fugle or another Taiwan provider for richer snapshot, intraday, or technical indicator data.
- [ ] 2.4 Add US market-universe ingestion using a production-approved provider such as Nasdaq Data Link or another licensed EOD/delayed source.
- [ ] 2.5 Add SEC EDGAR metadata or filings ingestion for US fundamentals/events when useful for research context.
- [ ] 2.6 Keep yfinance-compatible data limited to local development or fallback fixtures and label it non-production in reports.
- [ ] 2.7 Add tests for successful ingestion, provider unavailable, stale source, partial universe, missing symbols, unsupported asset types, delayed/EOD labeling, and non-production source labeling.
- [ ] 2.8 Add source-contract tests proving market data connectors record source IDs, fetched timestamps, freshness status, expected field coverage, licensing/permission labels, and rate-limit metadata.

## 3. News and Narrative Ingestion

- [ ] 3.1 Add US official filing ingestion using SEC EDGAR submissions, company facts, and filing metadata.
- [ ] 3.2 Add Taiwan official disclosure ingestion using MOPS, TWSE, TPEx, or owner-approved official disclosure sources where accessible.
- [ ] 3.3 Add licensed news API, RSS feed, or owner-approved news source ingestion for Taiwan and US market headlines, sector news, company news, and macro events.
- [ ] 3.4 Add narrative evidence extraction for source provider, URL/document ID, published timestamp, fetched timestamp, language, market, mapped symbols, theme tags, event type, source freshness, and extraction confidence.
- [ ] 3.5 Add deduplication and duplicate cluster IDs so syndicated or repeated stories do not count as independent evidence.
- [ ] 3.6 Add ticker and sector mapping from news entities, suppliers, products, and themes into the market universe with confidence and unmapped states.
- [ ] 3.7 Add LLM summarization, translation, classification, theme clustering, and risk/contradiction extraction only after source documents are stored.
- [ ] 3.8 Add tests for approved-source enforcement, unapproved-source exclusion, duplicate clustering, uncertain ticker mapping, stale narrative suppression, source-linked LLM output, and unsupported direct-advice output.
- [ ] 3.9 Add prompt-injection and external-text safety tests for news, filings, theme tags, display names, and LLM-derived text, including formula-like prefixes and instruction-injection strings.
- [ ] 3.10 Add tests proving arbitrary browser search, free-form web scraping, and LLM-autonomous internet research are excluded from production reports unless implemented as approved source connectors.

## 4. Signal Engine

- [ ] 4.1 Implement deterministic market-wide signals for Taiwan and US market tone, breadth, relative strength, volume anomaly, drawdown, sector strength, and stale-data warnings.
- [ ] 4.2 Implement deterministic narrative signals for theme momentum, event risk, source consensus, source contradiction, attention spike, official filing impact, and portfolio exposure to a theme.
- [ ] 4.3 Implement deterministic portfolio-aware signals for concentration, allocation drift, cash drag, currency exposure, large unrealized gain/loss, and holding-relative strength.
- [ ] 4.4 Add evidence objects to each signal with source, metric, value, timestamp, freshness status, and linked source evidence IDs.
- [ ] 4.5 Suppress or mark unavailable any signal whose required evidence is missing, stale, or partial.
- [ ] 4.6 Add fixture tests for market signals, narrative signals, portfolio signals, stale-data suppression, missing-evidence behavior, duplicate evidence, and multi-currency holdings.

## 5. Recommendation Policy

- [ ] 5.1 Add recommendation policy configuration for time horizon, max single-position weight, ETF/stock preference, cash target, risk tolerance, currency exposure limit, excluded instruments, and source confidence thresholds.
- [ ] 5.2 Implement action categories: observe, add-to-watchlist, review-add, review-reduce, rebalance-check, and no-action.
- [ ] 5.3 Require every recommendation object to include action category, display label, signals, policy rules, evidence, risk codes, confidence inputs/result, source freshness, invalidation conditions, and rendering mode.
- [ ] 5.4 Implement deterministic confidence rules based on data quality, signal strength, policy fit, source consensus, and source freshness.
- [ ] 5.5 Implement portfolio data completeness gates for review-add, review-reduce, P/L language, cash-drag language, and add-size language.
- [ ] 5.6 Keep add-to-watchlist recommendations as review candidates only unless a separate explicit user confirmation updates repo-owned watchlist config.
- [ ] 5.7 Add recommendation language checks that avoid imperative buy/sell instructions, guaranteed-return language, and target-price commands.
- [ ] 5.8 Add tests for policy blocking, confidence calculation, completeness gates, source freshness, stale news, duplicate narratives, partial portfolio imports, and LLM-disabled paths.
- [ ] 5.9 Implement component scores for theme, catalyst, fundamental, valuation, price/volume, fund-flow, risk/reward, and portfolio fit, with provider-coverage labels when an input is unavailable.
- [ ] 5.10 Implement `review-add` hard gates requiring theme threshold, at least two independent approved sources after deduplication, a dated catalyst, non-blocking fundamental and valuation checks, price/volume or fund-flow confirmation, passing risk/reward and portfolio-fit gates, complete invalidation conditions, and fresh required data.
- [ ] 5.11 Add recommendation postmortem fields for expected horizon, expiry timestamp, benchmark, paper-tracking status, hit/miss/expired/invalidated outcome, benchmark-relative return, and failed or missing gates.

## 6. Reports and Telegram Delivery

- [ ] 6.1 Add detailed private report artifact rendering and Telegram summary rendering with the most important items first.
- [ ] 6.2 Split daily Telegram investment reports into general Taiwan market view, general US market view, news and theme view, personal portfolio review, risk alerts, and source freshness.
- [ ] 6.3 Add popular-theme report rendering with source freshness, deduplicated evidence count, mapped tickers or sectors, risk/contradiction notes, and current-portfolio exposure.
- [ ] 6.4 Add configurable schedules for Taiwan-focused and US-focused report windows.
- [ ] 6.5 Add allowlisted Telegram recipients and redacted, summary, or detailed rendering modes for personal portfolio content.
- [ ] 6.6 Add status output for latest market ingestion, news ingestion, portfolio snapshot freshness, report schedule, and next recovery action.
- [ ] 6.7 Add tests for report rendering, missing broker data, missing market data, missing news data, stale data, separate market schedules, privacy modes, and LLM summary rejection.
- [ ] 6.8 Implement the structured report credibility envelope with run ID, report mode, market windows, source freshness, evidence coverage, policy profile/version, verifier status, blocked/downgraded reasons, artifact metadata, delivery mode, and audit event ID.
- [ ] 6.9 Implement a pre-delivery verifier that blocks or downgrades reports when source approval, freshness, evidence IDs, LLM schema validity, recommendation language, privacy mode, external-text escaping, artifact TTL, audit, or Telegram truncation checks fail.
- [ ] 6.10 Add deterministic golden report tests for normal, stale, missing broker, missing market, missing news, duplicate hype, contradiction, prompt injection, LLM disabled, LLM direct-advice rejection, and privacy-mode scenarios.
- [ ] 6.11 Add durable artifact handoff so research jobs write to assistant-owned report storage, a private artifact store, or an internal report endpoint before exit; reject production reliance on a standalone CronJob `emptyDir`.
- [ ] 6.12 Add `/internal/reports/investment-intelligence` or equivalent private trigger with internal-token validation and tests proving public ingress does not expose `/internal` paths.
- [ ] 6.13 Add shadow-mode report generation that writes private artifacts, credibility metadata, paper-tracking records, and audit events without sending Telegram recommendations until owner-approved delivery is enabled.
- [ ] 6.14 Add postmortem processing for expired or invalidated recommendations and prevent confidence threshold increases unless postmortem evidence supports the policy change.
- [ ] 6.15 Add on-demand report API behavior for scheduled-equivalent execution, stale-source refresh or downgrade handling, partial-report responses, and redacted Telegram delivery.
- [ ] 6.16 Add allowlisted Telegram report commands such as `/research today`, `/research tw`, and `/research us`, with tests for unauthorized users, rendering-mode limits, internal trigger invocation, and portfolio-content suppression.

## 7. Deployment and Operations

- [ ] 7.1 Add Docker Compose or local script support for fixture-backed research reports without real broker credentials.
- [ ] 7.2 Add Helm values and templates for disabled-by-default market ingestion, news ingestion, signal generation, and Telegram investment report jobs.
- [ ] 7.3 Add Kubernetes secret key documentation for market data tokens, news provider tokens, Telegram allowlist, and Telegram report delivery.
- [ ] 7.4 Add operations runbook steps for enabling market providers, enabling news sources, rotating/revoking provider tokens, restoring report artifacts, purging sensitive artifacts, and disabling personal report sections.
- [ ] 7.5 Verify local fixture runs, OpenSpec validation, unit tests, Helm lint, and Helm template rendering.
- [ ] 7.6 Verify k3d deployment of jobs, PVCs, secrets, ConfigMaps, resource limits, and failure states before VPS enablement.
- [ ] 7.7 Add Helm/render tests proving investment research jobs do not mount broker secrets, raw import PVCs, broker web-login state, or Wealthfolio scraping configuration.
- [ ] 7.8 Add Helm/render tests proving public ingress excludes `/internal` report routes while private or cluster-only investment report triggers remain reachable from scheduled jobs.
- [ ] 7.9 Add operations runbook steps for artifact sensitivity labels, TTL, purge, redacted audit review, shadow-mode enablement, Telegram delivery enablement, and postmortem review.
- [ ] 7.10 Add operations runbook steps for adding, approving, disabling, and auditing source providers, including official sources, licensed providers, approved RSS/news sources, and explicitly rejected free-form web search.

## 8. User Validation Gates

- [ ] 8.1 Confirm production-approved Taiwan and US market data providers plus pricing, license, and rate-limit constraints.
- [ ] 8.2 Confirm production-approved news, filing, RSS, and market narrative sources plus retention and rate-limit constraints.
- [ ] 8.3 Confirm initial recommendation policy values for max single holding weight, cash target, ETF/stock preference, risk tolerance, currency exposure, excluded instruments, and source confidence thresholds.
- [ ] 8.4 Review the first general-market-only report before enabling personal portfolio sections.
- [ ] 8.5 Review the first personal portfolio report with real or sanitized account data before marking reports production-ready.
- [ ] 8.6 Review the first shadow-mode recommendation postmortems before enabling scheduled Telegram investment recommendations.
- [ ] 8.7 Confirm the initial report credibility thresholds, component-score thresholds, benchmark set, recommendation TTLs, and postmortem cadence.
- [ ] 8.8 Confirm the initial approved source registry, including TWSE, TPEx, MOPS, SEC EDGAR, US market data provider, Taiwan richer data provider if used, and licensed news/RSS provider choices.
