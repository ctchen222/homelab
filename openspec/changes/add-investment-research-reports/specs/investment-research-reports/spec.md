## ADDED Requirements

### Requirement: Research reports consume portfolio snapshots only
The investment research report capability SHALL consume normalized portfolio snapshots from `investment-portfolio-sync` without accessing broker credentials, raw broker payloads, or Wealthfolio UI state.

#### Scenario: Portfolio snapshot is available
- **WHEN** a fresh normalized portfolio snapshot exists
- **THEN** research reports may use holdings, cash, market value, cost basis, P/L, currency, source type, and freshness metadata where available
- **AND** the snapshot reader exposes schema version, source type, as-of timestamp, freshness status, field-level coverage, account identity hash, and consumer capabilities

#### Scenario: Portfolio snapshot is unavailable
- **WHEN** normalized portfolio snapshots are stale, unavailable, or partial
- **THEN** the report downgrades or suppresses personal portfolio sections and may still send general market commentary

#### Scenario: Broker credential is requested
- **WHEN** a research report job attempts to load broker credentials or raw broker files
- **THEN** the system refuses the operation because broker access belongs to `investment-portfolio-sync`

#### Scenario: Research runtime is configured
- **WHEN** investment research Helm values, rendered manifests, environment variables, or runtime config include broker credential keys, raw broker import mounts, broker web-login state, or Wealthfolio scraping configuration
- **THEN** validation fails or the research job refuses to start because the research runtime may only read normalized portfolio snapshots and approved research/reporting provider configuration

### Requirement: Approved source registry
The investment research report capability SHALL maintain an approved source registry for every production source used by market data, official disclosure, news/RSS, narrative, and portfolio-context ingestion.

#### Scenario: Source contract is registered
- **WHEN** a source is enabled for production ingestion
- **THEN** the source contract records source ID, provider, source class, approval status, license or permission basis, rate limit, retention rule, freshness policy, expected fields, sensitivity label, and failure behavior

#### Scenario: Official source is used
- **WHEN** TWSE, TPEx, MOPS, SEC EDGAR, or another official source is captured
- **THEN** the capture stores source ID, document ID or stable URL, published timestamp where available, fetched timestamp, source class, market, mapped symbols where applicable, and freshness status

#### Scenario: Licensed provider API is called
- **WHEN** a market data, news, RSS, or narrative provider API is called
- **THEN** the call is made by an ingestion job or source connector using configured provider credentials and records source metadata before any LLM processing

#### Scenario: Free-form web search is requested
- **WHEN** a report workflow attempts arbitrary browser search, free-form web scraping, or LLM-autonomous internet research
- **THEN** the source is excluded from production reports unless it is implemented as an approved source connector with a registered source contract, evidence IDs, freshness policy, retention rule, and prompt-injection controls

#### Scenario: LLM attempts data retrieval
- **WHEN** an LLM attempts to browse websites, choose provider endpoints, call external APIs, retrieve secrets, or fetch additional data
- **THEN** the system refuses the operation because LLMs may only transform stored source-linked evidence or render structured report objects

### Requirement: Taiwan and US market-universe ingestion
The investment research report capability SHALL ingest Taiwan and US market-universe data beyond the existing watchlist.

#### Scenario: Market universe row is stored
- **WHEN** a market-universe row is stored
- **THEN** it includes market, exchange, MIC when available, provider symbol, canonical symbol, ISIN/CUSIP/FIGI when available, asset type, currency, listing status, source provider, as-of timestamp, and coverage status

#### Scenario: Market universe coverage is incomplete
- **WHEN** a provider returns only partial market coverage, missing symbols, suspended symbols, stale rows, or unsupported asset types
- **THEN** the system records coverage status and includes missing or partial coverage in the source freshness section of reports

#### Scenario: Development fallback data is used
- **WHEN** yfinance-compatible or fixture data is used for local development
- **THEN** the system marks the data source as non-production and excludes it from production confidence claims

### Requirement: News and narrative evidence ingestion
The investment research report capability SHALL ingest official filings, approved news sources, and market narratives as structured evidence for Taiwan and US market research.

#### Scenario: Official filing is ingested
- **WHEN** a US SEC filing, Taiwan official disclosure, TWSE/TPEx announcement, or owner-approved official document source is ingested
- **THEN** the system stores source provider, document ID or URL, published timestamp, fetched timestamp, market, mapped symbols, event type, source freshness, and sensitivity label

#### Scenario: News item is ingested
- **WHEN** a licensed news API, RSS feed, or owner-approved news source returns a market article
- **THEN** the system stores source provider, URL or stable source ID, title, published timestamp, fetched timestamp, language, market, mapped symbols, theme tags, event type, source freshness, and extraction confidence

#### Scenario: External text is rendered
- **WHEN** an external title, source field, theme tag, display name, mapped entity, or LLM-derived text is rendered to CSV, spreadsheet-like output, Markdown, HTML, Telegram, or a private artifact
- **THEN** formula-like prefixes such as `=`, `+`, `-`, `@`, and non-printing control characters are escaped or rejected before rendering

#### Scenario: News source is not approved
- **WHEN** a candidate news source lacks an approved source contract, RSS/API permission, or owner approval
- **THEN** the system excludes it from production ingestion and may use only fixture or manually provided samples for development

#### Scenario: Duplicate narrative is detected
- **WHEN** multiple articles or filings describe the same event or repeat syndicated content
- **THEN** the system assigns a duplicate cluster ID and avoids counting duplicate items as independent evidence

#### Scenario: Ticker mapping is uncertain
- **WHEN** a company, product, supplier, or theme cannot be confidently mapped to a Taiwan or US market-universe instrument
- **THEN** the evidence is marked unmapped or low-confidence and cannot create review-add or review-reduce recommendations

### Requirement: LLM-derived narrative evidence
The investment research report capability SHALL use LLMs only to transform source-linked text into derived evidence and report prose, not to bypass deterministic signals or recommendation policy.

#### Scenario: LLM summarizes news
- **WHEN** an LLM summarizes, translates, classifies, clusters, or extracts risks from a filing or news item
- **THEN** the derived evidence includes source references, prompt/model metadata, extraction confidence, mapped symbols, theme tags, event type, and risk or contradiction notes

#### Scenario: LLM output lacks source references
- **WHEN** an LLM-generated claim cannot be tied to approved source documents or stored evidence IDs
- **THEN** the claim is excluded from recommendation objects and may only appear as an internal diagnostic

#### Scenario: LLM attempts direct advice
- **WHEN** an LLM output contains imperative buy/sell instructions, target-price commands, guaranteed-return language, or unsupported causality
- **THEN** the renderer rejects or rewrites the output into allowed review-oriented language and records the policy violation

#### Scenario: Source text contains prompt injection
- **WHEN** a filing, news article, RSS item, or manually supplied narrative contains instructions such as ignoring prior instructions, exposing secrets, bypassing policy, or issuing direct trade commands
- **THEN** the text is treated only as untrusted source content and cannot alter prompts, policy gates, recommendation scores, delivery recipients, or runtime configuration

### Requirement: Source freshness matrix
The investment research report capability SHALL apply explicit freshness rules before generating signals or recommendations.

#### Scenario: Freshness policy is configured
- **WHEN** freshness rules are configured
- **THEN** each source type declares max age, market calendar, timezone, required/optional status, stale behavior, and report display text

#### Scenario: Source is stale
- **WHEN** a required source is older than its configured max age or outside its expected market calendar window
- **THEN** the system suppresses dependent recommendations or downgrades them to observe/no-action with a stale-data explanation

#### Scenario: Recommendation expires
- **WHEN** a recommendation is older than its configured recommendation TTL
- **THEN** the system does not resend it as current advice and marks any stored artifact as expired

### Requirement: Deterministic signal generation
The investment research report capability SHALL generate structured signals from market data, portfolio snapshots, filings, and news evidence before producing natural-language commentary.

#### Scenario: Market-wide signals are generated
- **WHEN** fresh market-universe data is available
- **THEN** the signal engine produces structured Taiwan and US signals such as market tone, breadth, relative strength, volume anomaly, drawdown, sector strength, and stale-data warnings

#### Scenario: Narrative signals are generated
- **WHEN** fresh and source-linked news, filing, or theme evidence is available
- **THEN** the signal engine produces structured narrative signals such as theme momentum, event risk, source consensus, source contradiction, attention spike, official filing impact, and portfolio exposure to a theme

#### Scenario: Portfolio-aware signals are generated
- **WHEN** fresh portfolio snapshots are available
- **THEN** the signal engine produces structured portfolio signals such as concentration, allocation drift, cash drag, currency exposure, large unrealized gain/loss, and holding-relative strength

#### Scenario: Required evidence is missing
- **WHEN** a signal cannot be supported by required source data
- **THEN** the signal is omitted or marked unavailable instead of being inferred by the LLM

### Requirement: Recommendation policy
The investment research report capability SHALL apply an explicit recommendation policy before sending Telegram investment research reports.

#### Scenario: Recommendation object is created
- **WHEN** the recommendation engine emits a recommendation
- **THEN** the object includes action category, display label, signals, policy rules, evidence, risk codes, confidence inputs, confidence result, source freshness, invalidation conditions, rendering mode, expected horizon, expiry timestamp, benchmark, and postmortem status
- **AND** confidence inputs include theme, catalyst, fundamental, valuation, price/volume, fund-flow, risk/reward, and portfolio-fit component scores where provider coverage supports them

#### Scenario: Confidence is calculated
- **WHEN** confidence is assigned to a recommendation
- **THEN** it is derived from explicit data quality, signal strength, policy fit, source consensus, source freshness, component scores, and portfolio completeness inputs or an equivalent documented deterministic rule
- **AND** LLM output cannot create, raise, or override the deterministic confidence result

#### Scenario: Evidence is insufficient
- **WHEN** a candidate recommendation lacks the minimum required evidence for its action category
- **THEN** the system downgrades it to observe/no-action or suppresses it

#### Scenario: Review-add recommendation is evaluated
- **WHEN** the recommendation engine considers `review-add`
- **THEN** the action is allowed only when the theme threshold passes, at least two independent approved sources remain after deduplication, at least one dated catalyst is present, fundamental and valuation gates do not show blocking negative evidence, price/volume or fund-flow confirmation is present, risk/reward and portfolio-fit gates pass, invalidation conditions are complete, and required data freshness has not expired
- **AND** failure of any required gate downgrades the recommendation to `observe`, `add-to-watchlist`, or `no-action`

#### Scenario: Recommendation language is generated
- **WHEN** recommendation text is rendered
- **THEN** it avoids imperative buy/sell instructions, guaranteed-return language, and target-price commands and uses review-oriented language such as observe, review-add, review-reduce, or rebalance-check

### Requirement: Report credibility and production gates
The investment research report capability SHALL produce a structured report object with explicit credibility, verification, artifact, and audit metadata before Telegram text is rendered.

#### Scenario: Report object is assembled
- **WHEN** an investment research report is assembled
- **THEN** the structured report includes run ID, generated timestamp, report mode, market windows, source freshness, evidence coverage, policy profile ID, policy version, verifier status, blocked or downgraded reasons, artifact ID, artifact sensitivity, artifact TTL, delivery mode, and audit event ID

#### Scenario: Report credibility is calculated
- **WHEN** report credibility is calculated
- **THEN** the result is derived from source freshness, evidence coverage, deduplication quality, recommendation policy pass/fail state, privacy verifier state, and artifact integrity
- **AND** missing required data lowers credibility or blocks affected sections instead of being filled by LLM inference

#### Scenario: Pre-delivery verifier runs
- **WHEN** a report is ready for delivery
- **THEN** the verifier checks source approval, evidence IDs, freshness, duplicate narrative handling, LLM schema validity, recommendation language, privacy rendering mode, external-text escaping, artifact TTL, audit event creation, and Telegram size/truncation behavior
- **AND** delivery is blocked or downgraded when a required verifier check fails

#### Scenario: Report artifact handoff is configured
- **WHEN** an investment research job generates a report artifact
- **THEN** the artifact is written to assistant-owned report storage, a durable private artifact store, or delivered to an internal report endpoint before the job exits
- **AND** a short-lived CronJob `emptyDir` by itself is not considered a production artifact handoff

#### Scenario: Internal report endpoint is exposed
- **WHEN** an investment report generation route such as `/internal/reports/investment-intelligence` is configured
- **THEN** it is cluster-only or protected by an equivalent private access boundary and requires the internal token
- **AND** public ingress does not expose `/internal` report paths

#### Scenario: Redacted audit event is recorded
- **WHEN** report generation, verification, delivery, refusal, or purge occurs
- **THEN** the system records a redacted audit event with run ID, source IDs, freshness decision, policy rule IDs, LLM model and prompt version where applicable, delivery recipient hash, refusal reason, artifact ID, and purge status
- **AND** the audit event does not contain provider tokens, broker credentials, full broker account numbers, raw holdings payloads, full cash balances, or raw import rows

### Requirement: Daily investment research reports
The investment research report capability SHALL send scheduled daily investment research reports and separate general market commentary from personal portfolio commentary.

#### Scenario: Daily report is generated
- **WHEN** the daily investment research report runs
- **THEN** it includes separate sections for general Taiwan market view, general US market view, news and theme view, personal portfolio review, risk alerts, and source freshness

#### Scenario: On-demand report API is called
- **WHEN** an authorized internal caller sends `POST /internal/reports/investment-intelligence`
- **THEN** the system runs the same source capture, freshness, signal, recommendation, credibility, pre-delivery verifier, artifact, audit, and Telegram rendering pipeline used by scheduled reports
- **AND** the route requires the internal token and remains cluster-only or behind an equivalent private access boundary

#### Scenario: On-demand report uses stale captures
- **WHEN** an on-demand report request finds that required source captures are stale or missing
- **THEN** the system refreshes approved providers first, downgrades the affected sections, or returns a partial-report response with clear missing-data reasons

#### Scenario: Telegram command requests a report
- **WHEN** an allowlisted Telegram user requests an investment report such as `/research today`, `/research tw`, or `/research us`
- **THEN** the assistant validates the user and requested rendering mode, invokes the internal report trigger, and delivers only the allowed summary or redacted output
- **AND** unauthorized Telegram users cannot trigger report generation or receive portfolio-specific content

#### Scenario: Popular theme is reported
- **WHEN** a popular Taiwan or US market theme appears in the daily report
- **THEN** the report includes why the theme is popular, mapped tickers or sectors, source freshness, evidence count after deduplication, risk or contradiction notes, and whether it affects the user's current portfolio

#### Scenario: Personal portfolio report is configured
- **WHEN** a personal portfolio report contains holdings, cash, P/L, allocation, or account-specific recommendations
- **THEN** it is sent only to allowlisted Telegram recipients and uses the configured redacted, summary, or detailed rendering mode
- **AND** detailed artifacts are accessible only through private access or cluster-only paths and are not embedded in public Telegram messages

#### Scenario: First real report is generated
- **WHEN** the first investment report uses real or sanitized portfolio data
- **THEN** it requires owner review before scheduled production delivery is enabled

#### Scenario: Shadow mode is enabled
- **WHEN** shadow mode is configured
- **THEN** the system generates private artifacts, credibility metadata, recommendations, paper-tracking records, and audit events without sending Telegram investment recommendations unless owner-approved delivery is enabled

#### Scenario: Recommendation reaches expiry or invalidation
- **WHEN** a recommendation reaches its TTL, expected horizon, benchmark review date, or invalidation condition
- **THEN** the system records a postmortem with hit, miss, expired, or invalidated status; paper return where measurable; benchmark-relative return; failed or missing gates; and recommended policy threshold changes
- **AND** recommendation confidence thresholds are not increased unless postmortem evidence supports the change
