## Context

`add-investment-intelligence-broker-sync` produces normalized portfolio snapshots and displays them in Wealthfolio. This change consumes those snapshots and adds the research layer: market data, news, official filings, deterministic signals, recommendation policy, LLM summarization, and Telegram reports.

The dependency is one-way:

```text
add-investment-intelligence-broker-sync
  -> normalized portfolio snapshots
  -> source freshness / partial-data labels

add-investment-research-reports
  -> reads snapshots
  -> combines with market data/news/signals/policy
  -> renders investment research reports
```

This change must not access broker credentials, raw broker exports, or broker-specific payloads.

The report production workflow is:

```text
scheduled job, internal API, or allowlisted Telegram command
  -> approved providers / normalized portfolio snapshots
  -> raw source capture with source ids and timestamps
  -> source approval, deduplication, freshness, and field-coverage checks
  -> LLM-derived evidence extraction as source-linked JSON only
  -> deterministic market, narrative, and portfolio signals
  -> recommendation policy and score calculation
  -> report object assembly
  -> pre-delivery verifier
  -> private detailed artifact + redacted audit event
  -> Telegram summary/redacted delivery
  -> shadow tracking and postmortem update
```

Any failed required gate downgrades the report, suppresses the affected recommendation, or blocks delivery.

## Goals / Non-Goals

**Goals:**

- Ingest Taiwan and US market-universe data beyond a small watchlist.
- Ingest official filings, approved news/RSS feeds, and market narratives.
- Maintain an approved source registry for market data, official disclosures, news/RSS, and narrative providers.
- Use LLMs to summarize, translate, extract entities, cluster themes, and extract risks/contradictions from source-linked text.
- Generate deterministic market-wide, narrative, and portfolio-aware signals before report writing.
- Apply explicit recommendation policy and data completeness gates.
- Apply explicit report credibility scoring, pre-delivery verification, and post-report outcome tracking so recommendations are auditable instead of prose-only.
- Deliver scheduled Telegram investment research reports with general market view, news/theme view, personal portfolio view, risk alerts, source freshness, and private detailed artifacts.

**Non-Goals:**

- Do not sync directly with brokers.
- Do not write holdings into Wealthfolio.
- Do not mutate portfolio snapshots.
- Do not place trades, edit orders, move cash, or mutate broker accounts.
- Do not let LLM output bypass deterministic evidence, freshness, and policy gates.
- Do not scrape arbitrary websites as production news sources without source approval.
- Do not allow an LLM to browse the internet, select sources, or call external provider APIs on its own.

## Decisions

### Decision 1: Consume normalized snapshots only

Research jobs read portfolio context from the normalized snapshot store produced by `add-investment-intelligence-broker-sync`. They do not use broker credentials, raw broker payloads, or Wealthfolio UI scraping.

Rationale:

- Research reports should be independently disableable.
- Broker security remains in the portfolio sync layer.
- Reports can degrade to general-market-only when portfolio data is stale or unavailable.

### Decision 2: Add a market-universe layer

Market-universe ingestion should build daily Taiwan and US symbol universes separately from user watchlists. Universe rows should include market, exchange, MIC where available, provider symbol, canonical symbol, ISIN/CUSIP/FIGI where available, asset type, currency, listing status, source provider, as-of timestamp, and coverage status.

Suggested source tiers:

- Taiwan listed market: TWSE official data.
- Taiwan OTC market: TPEx official data.
- Taiwan richer snapshot/technical data: Fugle or another licensed provider when needed.
- US EOD/snapshot: Nasdaq Data Link or another licensed/delayed provider.
- US fundamentals and filings: SEC EDGAR APIs where suitable.
- Development-only fallback: fixtures or yfinance-compatible data labeled non-production.

### Decision 3: Add news and narrative intelligence as evidence

News, official filings, and market narratives are evidence inputs, not direct recommendations.

Suggested source tiers:

- US official filings: SEC EDGAR submissions, company facts, and filing metadata.
- Taiwan official disclosures: MOPS/TWSE/TPEx material information and company announcements where accessible through official or owner-approved sources.
- Licensed or owner-approved news APIs/RSS feeds: broad market headlines, sector news, company news, and macro events.
- Development-only fallback: manually curated fixtures.

Narrative evidence should include source provider, URL or document ID, published timestamp, fetched timestamp, language, market, mapped symbols, theme tags, event type, sentiment or stance, novelty, duplicate cluster ID, source freshness, and extraction confidence.

The initial source registry should separate sources by trust and use:

| Source class | Initial providers | Production use |
| --- | --- | --- |
| Taiwan market universe and EOD data | TWSE official data, TPEx official data | Listed/OTC universe, price, volume, breadth, stale-data warnings |
| Taiwan richer market data | Fugle or another owner-approved/licensed provider | Intraday snapshots, technical inputs, richer quote fields where licensed |
| Taiwan official disclosures | MOPS, TWSE, TPEx announcements and material information | Company events, filings, catalysts, risk events |
| US market universe and EOD/snapshot data | Nasdaq Data Link or another owner-approved/licensed provider | US universe, delayed/EOD prices, index/sector-relative data |
| US official filings | SEC EDGAR submissions, company facts, filing metadata | Fundamentals, events, catalysts, official company disclosures |
| News and narrative sources | Licensed news API, approved RSS, owner-approved narrative source | Market headlines, sector news, company news, macro events, theme evidence |
| Portfolio context | Normalized snapshots from `investment-portfolio-sync` | Holdings, cash, P/L, currency exposure, portfolio fit |
| Development fallback | Fixtures, yfinance-compatible data, manually curated samples | Local tests only; not valid for production confidence claims |

Each source contract should declare `source_id`, provider, source class, approval status, license/permission, rate limit, retention rule, freshness policy, expected fields, sensitivity label, and failure behavior.

Arbitrary web search is not a production source. If search is ever needed, it must be implemented as an approved source connector with the same source contract, evidence IDs, retention, freshness, and prompt-injection controls as other providers.

### Decision 4: Use LLMs only for derived evidence and rendering

LLMs may summarize, translate, classify, cluster, map entities to candidate tickers, and extract risks or contradictions. LLM output must remain source-linked derived evidence and must pass deterministic gates before appearing in a report.

LLMs must not directly decide buy/sell actions, invent evidence, or issue imperative investment advice.

Provider API calls happen in ingestion jobs or source connectors before LLM processing. The LLM receives stored source text, metadata, and evidence IDs, then returns schema-validated derived evidence or final prose from structured report objects. It does not choose provider endpoints, browse websites, retrieve secrets, or fetch additional data.

### Decision 5: Generate deterministic signals before recommendations

Signals should be structured and testable:

- Market signals: tone, breadth, relative strength, volume anomaly, drawdown, sector strength, stale-data warnings.
- Narrative signals: theme momentum, event risk, source consensus, source contradiction, attention spike, official filing impact.
- Portfolio signals: concentration, allocation drift, cash drag, currency exposure, large unrealized gain/loss, holding-relative strength, portfolio exposure to a theme.

Each signal must link to source evidence and freshness metadata.

### Decision 6: Apply recommendation policy before LLM report writing

The recommendation engine should emit structured recommendation objects before any Telegram prose is generated. Action categories are observe, add-to-watchlist, review-add, review-reduce, rebalance-check, and no-action.

Every recommendation should include action category, display label, signals, policy rules, evidence, risk codes, confidence inputs/result, source freshness, invalidation conditions, and rendering mode.

The LLM renders the final report from recommendation objects. It does not decide the recommendation objects.

### Decision 7: Split report sections

Telegram investment reports should include:

- Today highlights.
- General Taiwan market view.
- General US market view.
- News and theme view.
- Personal portfolio review.
- Risk alerts.
- Source freshness and missing-data notes.
- Link or pointer to private detailed artifacts.

Personal portfolio content must be sent only to allowlisted recipients and support redacted, summary, and detailed modes.

### Decision 8: Enforce research runtime security boundaries

Investment research jobs must be unable to load broker secrets, raw broker import files, or Wealthfolio UI/DB state. They may read only approved market/news/filing provider secrets, Telegram delivery configuration, and the normalized snapshot reader contract exposed by `investment-portfolio-sync`.

Helm values, rendered manifests, and runtime config should refuse or fail validation when a research report job is configured with broker credential keys, raw broker export mounts, automated broker web login state, or Wealthfolio scraping settings.

Public ingress may expose Telegram webhook paths only. Investment report generation routes such as `/internal/reports/investment-intelligence` must remain cluster-only or behind an equivalent private access boundary and must require the internal token.

### Decision 9: Add report credibility and recommendation scoring

Every report should include a deterministic credibility envelope before any LLM prose is rendered. The envelope should include:

- `run_id`, `generated_at`, `report_mode`, `market_windows`, and `source_freshness`.
- `evidence_coverage` for market data, official filings, news/narratives, FX, and portfolio snapshots.
- `policy_profile_id`, `policy_version`, `verifier_status`, and `blocked_or_downgraded_reasons`.
- `artifact_id`, `artifact_sensitivity`, `artifact_ttl`, `delivery_mode`, and `audit_event_id`.

Every recommendation should include component scores instead of a single LLM-filled confidence value:

- `theme_score`: breadth, sector-relative strength, deduplicated evidence count, and source novelty.
- `catalyst_score`: dated catalysts such as earnings, guidance, filings, product cycles, policy events, orders, capex, or industry pricing.
- `fundamental_score`: revenue/EPS growth, margin trend, cash flow, and balance-sheet risk where available.
- `valuation_score`: absolute and peer-relative valuation inputs such as P/E, P/S, EV/EBITDA, FCF yield, or equivalent ETF valuation context.
- `price_volume_score`: index-relative return, sector-relative return, volume anomaly, drawdown, and breakout/breakdown conditions.
- `fund_flow_score`: Taiwan foreign/investment-trust/dealer flows, margin data, ETF flow, short interest, or institutional ownership where provider coverage supports it.
- `risk_reward_score`: upside/downside setup, risk codes, concentration, liquidity, event risk, and invalidation clarity.
- `portfolio_fit_score`: existing exposure, max single-position weight, same-theme exposure, cash target, TWD/USD exposure, and replacement/overlap with current holdings.

The deterministic confidence result is calculated from these inputs and source freshness. LLM output may describe the score, but it must not create or raise the score.

`review-add` is allowed only when all required gates pass:

```text
theme_score >= configured threshold
AND at least two independent approved sources remain after deduplication
AND at least one dated catalyst is present
AND fundamental and valuation gates do not show blocking negative evidence
AND price/volume or fund-flow confirmation is present
AND risk/reward and portfolio-fit gates pass
AND invalidation conditions are complete
AND required data freshness has not expired
```

If any required gate fails, the recommendation is downgraded to `observe`, `add-to-watchlist`, or `no-action`.

### Decision 10: Add a pre-delivery verifier and artifact handoff

The report renderer should produce a structured report object before Telegram text. A pre-delivery verifier checks that:

- Required sources are approved, fresh, and linked by evidence IDs.
- Duplicate narratives are not counted as independent evidence.
- LLM-derived claims are schema-valid and source-linked.
- No direct buy/sell command, guaranteed return, unsupported target-price command, or unsupported causality appears in user-facing text.
- Personal portfolio fields respect redacted, summary, and detailed rendering modes.
- External text fields are escaped or rejected before CSV, spreadsheet, Markdown, HTML, or Telegram rendering when they begin with formula/control characters such as `=`, `+`, `-`, `@`, or non-printing controls.
- Detailed artifacts have sensitivity labels, TTL, purge policy, private access, and redacted audit events.
- Telegram summaries fit delivery limits and point to the private detailed artifact when detailed content is enabled.

Investment report artifacts must be handed off through a durable private artifact store, assistant-owned report storage, or a private object store. A short-lived CronJob `emptyDir` is not a valid production handoff unless the job sends the verified report to the assistant or another durable private store before exit.

### Decision 10.1: Support scheduled and on-demand report triggers

Reports should be generated by the same pipeline regardless of trigger source. Supported triggers are:

- Scheduled report jobs for Taiwan-focused, US-focused, or combined report windows.
- Internal API trigger, such as `POST /internal/reports/investment-intelligence`, protected by `X-Internal-Token` and private/cluster-only routing.
- Allowlisted Telegram command, such as `/research today`, `/research tw`, or `/research us`, which validates the user and calls the internal API.

On-demand triggers may reuse recent source captures when they are fresh. If required source captures are stale, the request should either refresh approved providers first, downgrade the report, or return a clear partial-report response. On-demand triggers must not bypass source approval, LLM guardrails, recommendation policy, privacy mode, or pre-delivery verification.

### Decision 11: Add shadow tracking and postmortems

Before scheduled production delivery, the system should run in shadow mode with real or sanitized data. Shadow mode writes private artifacts and audit events but does not send Telegram investment recommendations unless the owner enables delivery.

Each recommendation should store `expected_horizon`, `expiry_at`, `benchmark`, and `paper_tracking_status`. At the configured TTL or invalidation event, the system records a postmortem with hit/miss/expired status, realized paper return where measurable, benchmark-relative return, which gate was wrong or missing, and whether confidence thresholds should be tightened.

Confidence thresholds must not be raised because a report sounds persuasive. They can be raised only after postmortem evidence supports the policy change.

## Risks / Trade-offs

- [Risk] Market data and news sources may require paid licenses. -> Mitigation: explicit provider approval, source labeling, and fixture-only development fallback.
- [Risk] News ingestion can amplify hype or duplicated stories. -> Mitigation: deduplication, source freshness, source consensus/contradiction, and policy gates.
- [Risk] LLM summaries can hallucinate or overstate causality. -> Mitigation: source-linked derived evidence and deterministic recommendation gates.
- [Risk] Reports may sound like direct financial advice. -> Mitigation: review-oriented action categories, risk text, confidence, invalidation conditions, and language checks.
- [Risk] Portfolio data can be stale. -> Mitigation: suppress or downgrade portfolio-aware recommendations when snapshots are stale or partial.
- [Risk] Report artifacts can leak sensitive holdings or broker identity. -> Mitigation: sensitivity labels, private artifact handoff, redacted audit logs, TTL, purge policy, and Telegram rendering modes.
- [Risk] A report can look credible without being useful. -> Mitigation: deterministic credibility envelope, pre-delivery verifier, shadow tracking, benchmark comparison, and recommendation postmortems.

## Migration Plan

1. Finish `add-investment-intelligence-broker-sync` enough to provide fixture and real/sanitized normalized snapshots.
2. Define market-universe, news evidence, narrative evidence, signal, recommendation, and report artifact schemas.
3. Implement fixture-backed market and news ingestion.
4. Add production-approved Taiwan and US market data providers.
5. Add official filing/news/RSS ingestion.
6. Add LLM-derived evidence extraction with source references.
7. Add deterministic signal engine.
8. Add recommendation policy, component scoring, and language guardrails.
9. Add report object assembly, pre-delivery verification, durable private artifact handoff, and redacted audit events.
10. Enable shadow-mode general-market-only reports, review postmortems, then enable Telegram summaries.
11. Enable personal portfolio sections only after normalized snapshots, privacy rendering, owner review, and delivery-mode tests pass.

## Open Questions

- Which US market data provider should be production source of truth?
- Which Taiwan market data and official disclosure sources should be production-approved?
- Which licensed news/RSS providers should be used?
- What recommendation policy profile should be used first?
- What Telegram schedules should be enabled: Taiwan pre-open, Taiwan post-close, US pre-open, US post-close, or one daily combined report?
