## ADDED Requirements

### Requirement: Minimal existing-project-first deployment
The FinOps workspace SHALL prioritize existing self-hosted finance projects and keep custom code limited to integration, Telegram, reports, and glue logic.

#### Scenario: FinOps is planned for the current VPS
- **WHEN** the FinOps workspace is planned for the VPS at `178.156.151.78`
- **THEN** the plan accounts for existing FurFriend-Finder workloads already consuming cluster resources

#### Scenario: MVP components are selected
- **WHEN** the MVP deployment is defined
- **THEN** it uses ezBookkeeping as the default bookkeeping and spending-analysis application, a thin FinOps assistant for Telegram and reports, and OpenBB only as a scheduled or on-demand research job

#### Scenario: Portfolio app is selected
- **WHEN** stock and portfolio UI is deployed in the first implementation
- **THEN** Wealthfolio is the selected portfolio tracker before heavier alternatives such as Ghostfolio

#### Scenario: Custom app scope is evaluated
- **WHEN** a requirement can be satisfied by ezBookkeeping, Wealthfolio, OpenBB, Telegram Bot API, or homepage metadata
- **THEN** the implementation avoids building a custom replacement for that capability

### Requirement: Lightweight resource profile
The FinOps workspace SHALL run with explicit CPU, memory, storage, and component-count guardrails suitable for a crowded single-node homelab cluster.

#### Scenario: Always-on services are deployed
- **WHEN** the FinOps MVP is deployed
- **THEN** the always-on services are ezBookkeeping, the thin FinOps assistant, and Wealthfolio with explicit resource limits

#### Scenario: Heavy analysis runs
- **WHEN** market research, LLM summarization, or report generation runs
- **THEN** it runs as a scheduled or on-demand job instead of a permanently running worker

#### Scenario: Resource gate fails
- **WHEN** a candidate component exceeds the configured resource budget or destabilizes co-located workloads
- **THEN** the component remains disabled and the rest of the FinOps workspace continues operating

### Requirement: Bookkeeping source of truth
The FinOps workspace SHALL use ezBookkeeping as the default source of truth for expense, income, transfer, account, category, and spending chart data.

#### Scenario: User records an expense
- **WHEN** the user records an expense from the web UI, mobile PWA, or Telegram
- **THEN** the final accepted transaction is stored in ezBookkeeping

#### Scenario: User records income
- **WHEN** the user records salary, one-time income, refund, or transfer data
- **THEN** the final accepted entry is stored in ezBookkeeping with the correct transaction type

#### Scenario: User reviews spending
- **WHEN** the user opens the finance web experience
- **THEN** ezBookkeeping provides spending, income, account, category, trend, and custom chart views before any custom charting is built

#### Scenario: User adds a bookkeeping category
- **WHEN** the user wants to track a new spending category
- **THEN** the category is created in ezBookkeeping first, either through the ezBookkeeping UI or through an explicit Telegram category-add command
- **AND** the FinOps assistant persists one or more Telegram aliases to that ezBookkeeping category ID without requiring parser changes

#### Scenario: User discovers available bookkeeping categories
- **WHEN** an allowlisted Telegram user sends a category or account discovery command
- **THEN** the assistant lists available ezBookkeeping categories or accounts with currently configured Telegram aliases

#### Scenario: Telegram transaction uses an unknown category
- **WHEN** an allowlisted Telegram user sends a transaction with a category alias that does not map to an ezBookkeeping category
- **THEN** the assistant stores the transaction for review and replies with a category-add or category-confirm command instead of silently creating a new category

#### Scenario: Telegram category confirmation is accepted
- **WHEN** an allowlisted Telegram user confirms creation of a previously unknown category
- **THEN** the assistant creates the category through the ezBookkeeping API, persists the alias, and retries the pending transaction once

#### Scenario: ezBookkeeping API is unavailable
- **WHEN** the thin FinOps assistant cannot reach ezBookkeeping
- **THEN** Telegram write operations fail safely or queue for review without silently losing or duplicating finance data

#### Scenario: ezBookkeeping storage is configured
- **WHEN** ezBookkeeping is deployed for the MVP
- **THEN** it uses SQLite on a persistent volume rather than requiring a new PostgreSQL deployment

### Requirement: Telegram accounting assistant
The FinOps workspace SHALL provide a Telegram assistant for low-friction bookkeeping and finance notifications.

#### Scenario: Authorized user sends expense text
- **WHEN** an allowlisted Telegram user sends a supported message such as an expense, income, transfer, or correction
- **THEN** the FinOps assistant parses the message and either writes a final transaction to ezBookkeeping or stores a pending review item

#### Scenario: Telegram message is ambiguous
- **WHEN** a Telegram message is missing amount, currency, account, category, date, or transaction type
- **THEN** the assistant asks a clarification question or stores the item for later review instead of creating a final transaction

#### Scenario: Telegram delivery is retried
- **WHEN** Telegram retries a webhook or the assistant receives the same update more than once
- **THEN** the assistant uses Telegram update IDs or idempotency metadata to avoid duplicate bookkeeping records

#### Scenario: Unauthorized Telegram user sends message
- **WHEN** a Telegram user not on the allowlist sends a message to the assistant
- **THEN** the assistant rejects the request and does not reveal finance data

### Requirement: Finance notifications and daily summary
The FinOps workspace SHALL send useful finance notifications through Telegram without requiring the user to open every component daily.

#### Scenario: Daily finance notification runs
- **WHEN** the daily report schedule runs
- **THEN** the assistant sends a Telegram summary of spending, income, cashflow, unusual activity, pending review items, portfolio/watchlist changes, and market research highlights

#### Scenario: Spending anomaly is detected
- **WHEN** daily or period spending exceeds configured thresholds or unusual categories are detected
- **THEN** the assistant includes the anomaly in a notification or daily summary

#### Scenario: End-of-day spending summary runs
- **WHEN** the end-of-day spending summary schedule runs
- **THEN** the assistant reads today's expense transactions from ezBookkeeping and sends a Telegram summary with total spending, category breakdown, account breakdown, and pending review count

#### Scenario: User requests a period overview
- **WHEN** an allowlisted Telegram user sends `overview today`, `overview 7d`, or `overview month`
- **THEN** the assistant returns a readable Telegram summary with income total, expense total, net cashflow, transaction count, category breakdowns for both income and expenses, account movement, and percentage bars

#### Scenario: No spending is recorded today
- **WHEN** the end-of-day spending summary runs and ezBookkeeping returns no expenses for the local day
- **THEN** the assistant sends or stores a clear no-spending summary instead of failing the report

#### Scenario: Report generation partially fails
- **WHEN** spending data, portfolio data, market data, or LLM summarization is unavailable
- **THEN** the assistant sends a partial report and clearly marks the missing section instead of failing the whole report

### Requirement: Portfolio and stock visibility
The FinOps workspace SHALL deploy Wealthfolio in the first implementation for portfolio visibility and maintain a Taiwan and US stock watchlist for reports.

#### Scenario: Taiwan and US watchlist is configured
- **WHEN** the user configures stock, ETF, or crypto symbols of interest
- **THEN** the assistant stores the market, ticker, display name, currency, and data-source preference for Taiwan and US symbols

#### Scenario: Wealthfolio is deployed
- **WHEN** the first FinOps implementation is deployed
- **THEN** Wealthfolio provides dedicated portfolio charts, holdings, performance analytics, goals, and net-worth views behind private access

#### Scenario: Wealthfolio resource gate fails
- **WHEN** Wealthfolio exceeds CPU, memory, storage, backup, authentication, or ingress gates
- **THEN** Wealthfolio can be disabled while ezBookkeeping, Telegram reports, and watchlist summaries continue operating

#### Scenario: Ghostfolio is considered
- **WHEN** Ghostfolio is evaluated as an alternative portfolio backend
- **THEN** it remains optional and gated because it requires PostgreSQL and Redis in addition to the application

### Requirement: Market research and trading-suggestion reports
The FinOps workspace SHALL generate daily Taiwan and US market research and trading-suggestion reports as research commentary, not automated investment advice or broker execution.

#### Scenario: Daily market report runs
- **WHEN** the configured market report schedule runs
- **THEN** a scheduled job gathers market context for configured Taiwan and US symbols and stores or sends a report

#### Scenario: US pre-open report is scheduled
- **WHEN** the daily stock report schedule is configured
- **THEN** the report is sent before the US regular market opens, calculated from America/New_York market time into Asia/Taipei time with daylight-saving handling

#### Scenario: Taiwan stock data is fetched
- **WHEN** a Taiwan-listed or Taipei Exchange symbol is included in the watchlist
- **THEN** the research job uses TWSE/TPEx official daily data where available, with OpenBB or yfinance-compatible fallback only when appropriate

#### Scenario: US stock data is fetched
- **WHEN** a US-listed symbol is included in the watchlist
- **THEN** the research job uses OpenBB provider data such as yfinance-compatible historical or quote data for report inputs

#### Scenario: Trading suggestion is generated
- **WHEN** the assistant produces a stock trading suggestion
- **THEN** it includes supporting signals, relevant risks, source context, and confidence framing, and it avoids guaranteed-return language

#### Scenario: User requests buy or sell automation
- **WHEN** a workflow would place broker orders, execute trades, or modify brokerage accounts
- **THEN** the system refuses the action because broker automation is out of scope

#### Scenario: LLM is used for report writing
- **WHEN** an LLM summarizes spending, portfolio, or market data
- **THEN** the LLM output is stored as commentary or draft analysis and does not directly mutate bookkeeping or portfolio records

### Requirement: Clear charting surfaces
The FinOps workspace SHALL expose clear chart views for spending, income, cashflow, accounts, and portfolio status by using existing project UIs first.

#### Scenario: User views spending charts
- **WHEN** the user wants spending, income, category, account, or trend charts
- **THEN** the system links to ezBookkeeping chart and analysis views

#### Scenario: User views portfolio charts
- **WHEN** Wealthfolio is enabled
- **THEN** the system links to Wealthfolio portfolio, net-worth, performance, and goal views

#### Scenario: Custom chart is requested
- **WHEN** a chart cannot be provided by ezBookkeeping, Wealthfolio, or a generated report
- **THEN** the custom chart is treated as a later enhancement rather than an MVP blocker

### Requirement: Data storage, backup, and export
The FinOps workspace SHALL back up all personal finance, Telegram assistant, report, and portfolio data required to recover the service.

#### Scenario: ezBookkeeping is deployed
- **WHEN** ezBookkeeping stores finance data
- **THEN** its data volume or database is included in the backup and restore plan

#### Scenario: Wealthfolio is deployed
- **WHEN** Wealthfolio stores portfolio data
- **THEN** its SQLite database, secrets, and configuration are included in the backup and restore plan

#### Scenario: Assistant state is stored
- **WHEN** the FinOps assistant stores Telegram allowlists, idempotency keys, pending review items, report history, or watchlist configuration
- **THEN** that state is backed up or regenerable from repo-owned configuration

#### Scenario: User exports finance data
- **WHEN** the user requests an export
- **THEN** the workspace provides machine-readable exports from the source systems rather than requiring database scraping

### Requirement: Private access boundary
The FinOps workspace SHALL protect finance data, portfolio data, Telegram webhooks, admin links, API tokens, and generated reports behind private access controls.

#### Scenario: User opens finance UI
- **WHEN** a request without valid private access attempts to open ezBookkeeping, Wealthfolio, generated reports, or assistant admin endpoints
- **THEN** the platform denies access before exposing personal finance data

#### Scenario: Telegram webhook is exposed
- **WHEN** Telegram webhook mode is used
- **THEN** the assistant validates Telegram secret token or equivalent webhook authenticity and restricts allowed users

#### Scenario: API token is configured
- **WHEN** the assistant calls ezBookkeeping or any market/LLM provider
- **THEN** API tokens are stored in Kubernetes secrets or an equivalent private secret store and are not committed to the repo

### Requirement: Homepage integration
The FinOps workspace SHALL publish service metadata and health signals for the separate homelab homepage without owning homepage rendering.

#### Scenario: FinOps services are registered
- **WHEN** ezBookkeeping, the FinOps assistant, Wealthfolio, or report endpoints are deployed
- **THEN** the homelab homepage can show their names, private URLs, health status, sensitivity labels, and documentation links

#### Scenario: FinOps component is disabled
- **WHEN** Wealthfolio, OpenBB reports, LLM summarization, or Telegram integration is disabled
- **THEN** the homepage metadata marks that component disabled or unknown without affecting bookkeeping access
