## 1. Stack and Resource Baseline

- [x] 1.1 Document the selected existing-project-first stack: ezBookkeeping, thin FinOps assistant, Wealthfolio, and Taiwan/US market research scheduled jobs.
- [x] 1.2 Document the current VPS/k3s workload baseline, including existing FurFriend-Finder services and available CPU, memory, and storage.
- [x] 1.3 Use SQLite/PVC-backed storage for ezBookkeeping and Wealthfolio in the MVP.
- [x] 1.4 Define namespace, ingress, private access, backup, and resource-limit conventions for FinOps components.
- [x] 1.5 Document why Firefly III, Actual Budget, Maybe, Ghostfolio, and full custom dashboard work are not default MVP choices.

## 2. ezBookkeeping Core

- [x] 2.1 Add ezBookkeeping deployment configuration with conservative CPU and memory requests/limits.
- [x] 2.2 Configure persistent storage, secrets, timezone, currency, and private ingress for ezBookkeeping.
- [x] 2.3 Enable API token support for assistant integration.
- [x] 2.4 Configure initial accounts, categories, currencies, and import/export settings.
- [x] 2.5 Document and verify the workflow for adding new ezBookkeeping categories and exposing them through assistant account/category alias mappings.
- [x] 2.6 Verify expense, income, transfer, account, category, trend, and custom chart workflows in the ezBookkeeping UI/PWA.
- [x] 2.7 Add backup and restore documentation for ezBookkeeping data.
- [x] 2.8 Register ezBookkeeping health and metadata for the separate homelab homepage.

## 3. Telegram FinOps Assistant

- [x] 3.1 Create the thin FinOps assistant service skeleton for Telegram webhook or long-polling mode.
- [x] 3.2 Use TypeScript, Fastify or equivalent lightweight HTTP routing, direct Telegram Bot API calls, and SQLite-backed assistant state.
- [x] 3.3 Configure Telegram bot token, webhook secret or polling offset state, and allowlisted user IDs through Kubernetes secrets/config.
- [x] 3.4 Implement parsing for simple expense, income, transfer, correction, and status commands.
- [x] 3.5 Write accepted transactions to ezBookkeeping through its HTTP API.
- [x] 3.6 Implement review or clarification flow for ambiguous Telegram messages.
- [x] 3.7 Implement idempotency for Telegram update retries.
- [x] 3.8 Add tests for authorized user, unauthorized user, duplicate update, valid transaction, ambiguous transaction, and ezBookkeeping API failure paths.
- [x] 3.9 Implement Telegram category/account discovery commands, API-backed category creation, persisted category aliases, and unknown-category confirmation.
- [x] 3.10 Add tests for category/account discovery, category creation, persisted aliases, unknown-category review, and category-confirm retry.

## 4. Notifications and Daily Finance Reports

- [x] 4.1 Implement daily report generation from ezBookkeeping data for spending, income, cashflow, account summaries, anomalies, and pending reviews.
- [x] 4.2 Send daily report summaries through Telegram.
- [x] 4.3 Make report generation partial-failure tolerant when one data source is unavailable.
- [x] 4.4 Store or export generated report artifacts when useful for later review.
- [x] 4.5 Add tests for normal report generation, missing spending data, unavailable Telegram, and unavailable ezBookkeeping.
- [x] 4.6 Implement an end-of-day spending summary endpoint that reads today's ezBookkeeping expenses, groups them by category/account, includes pending review count, stores an artifact, and sends it through Telegram.
- [x] 4.7 Add Helm scheduling and local/test coverage for the end-of-day spending summary.
- [x] 4.8 Upgrade Telegram period overview for today, 7-day, and monthly views with income/expense totals, category/account percentages, and readable text bars.
- [x] 4.9 Add tests for the richer period overview output.

## 5. Portfolio and Stock Visibility

- [x] 5.1 Define the initial Taiwan and US stock/ETF/crypto watchlist configuration with market, ticker, display name, currency, and data source.
- [x] 5.2 Add lightweight watchlist summary generation for Telegram daily reports.
- [x] 5.3 Add Wealthfolio deployment configuration with SQLite/PVC storage, resource limits, authentication, ingress, backup, and homepage metadata.
- [x] 5.4 Verify Wealthfolio portfolio, performance, net-worth, market-data, and backup flows.
- [x] 5.5 Document rollback steps if Wealthfolio exceeds the resource budget.

## 6. Taiwan and US Market Research

- [x] 6.1 Define the first Taiwan and US market data sources, including TWSE/TPEx official daily data and OpenBB/yfinance-compatible US data.
- [x] 6.2 Add a scheduled or on-demand research job with strict CPU and memory limits.
- [x] 6.3 Generate daily market context for configured Taiwan and US watchlist symbols.
- [x] 6.4 Add trading-suggestion commentary with source context, risk notes, uncertainty, and no broker execution.
- [x] 6.5 Add optional LLM summarization only after raw source data and risk framing are available.
- [x] 6.6 Add tests or dry-run scripts for successful report, unavailable provider, stale data, and LLM-disabled paths.
- [x] 6.7 Schedule the Telegram stock report before the US regular market opens, converting America/New_York market time to Asia/Taipei and handling daylight saving time.

## 7. Security, Operations, and Homepage Integration

- [x] 7.1 Protect ezBookkeeping, assistant endpoints, Wealthfolio, and generated reports behind the selected private access boundary.
- [x] 7.2 Store Telegram, ezBookkeeping, market data, and LLM tokens in Kubernetes secrets or an equivalent private secret store.
- [x] 7.3 Add service health endpoints or probes for ezBookkeeping, FinOps assistant, Wealthfolio, and report jobs.
- [x] 7.4 Add homelab homepage metadata for enabled FinOps components.
- [x] 7.5 Verify resource usage after each enabled component and disable components that exceed budget.
- [x] 7.6 Document rollback steps for disabling assistant, reports, Wealthfolio, or the full FinOps namespace without deleting finance data.

## 8. Local Testing and Deployment Pipeline

- [x] 8.1 Add Docker Compose configuration for local functional testing of ezBookkeeping, Wealthfolio, FinOps assistant, and report dry-runs.
- [x] 8.2 Add fixture-based tests for Telegram updates, ezBookkeeping API writes, market data fetches, and report generation.
- [x] 8.3 Add k3d local cluster instructions for deployment parity with the VPS k3s target.
- [x] 8.4 Add Helm chart or manifests with `values-local.yaml` and `values-prod.yaml`.
- [x] 8.5 Verify Helm rendering with local values before installing into k3d.
- [x] 8.6 Verify k3d deployment of namespaces, secrets, PVCs, ingress, services, and CronJobs.
- [x] 8.7 Document the VPS deployment sequence: ezBookkeeping, assistant, Wealthfolio, market CronJob, homepage metadata.
