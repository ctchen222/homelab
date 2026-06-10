## Context

The current VPS at `178.156.151.78` already runs k3s and multiple FurFriend-Finder services. The FinOps app must therefore be small, useful, and composed from existing projects wherever possible.

The desired product is a personal finance assistant that can:

- show expenses, income, cashflow, accounts, and categories with clear charts
- show stock, ETF, crypto, watchlist, and portfolio status
- accept bookkeeping input through Telegram
- send Telegram finance notifications and daily reports
- generate daily market research and trading-suggestion commentary
- remain private and recoverable on a constrained homelab VPS

This design replaces the earlier "custom orchestrator owns the core data model" approach with an existing-project-first stack:

- ezBookkeeping for bookkeeping, spending/income data, API access, PWA, and charts
- a thin FinOps assistant for Telegram ingestion, notifications, report scheduling, and glue logic
- Wealthfolio in the first implementation for dedicated investment charts and portfolio views
- OpenBB as a scheduled/on-demand research job, not an always-on service
- optional LLM summarization for reports, outside the write path

## Goals / Non-Goals

**Goals:**

- Minimize always-on resource usage on the existing k3s VPS.
- Use mature existing GitHub projects for finance UI and portfolio UI before writing custom screens.
- Make ezBookkeeping the default source of truth for spending, income, accounts, categories, and bookkeeping charts.
- Use Telegram for low-friction transaction capture and daily notifications.
- Keep ezBookkeeping as the category source of truth while allowing the Telegram assistant to list categories, create new categories through ezBookkeeping's API after explicit user intent, and persist short aliases in assistant state.
- Provide daily finance and market reports with clear risk framing.
- Keep stock "trading suggestions" as research commentary, not automated broker execution.
- Keep deployment, access, backup, and homepage metadata compatible with the homelab platform repo.

**Non-Goals:**

- Do not build a custom replacement for ezBookkeeping or Wealthfolio in the MVP.
- Do not deploy Firefly III, Actual Budget, Maybe, Ghostfolio, OpenBB server, and a custom app all at once.
- Do not execute trades, connect broker order APIs, or modify brokerage accounts.
- Do not expose finance, portfolio, Telegram webhook, or report endpoints publicly without private access protection.
- Do not require a shared PostgreSQL database for the MVP; ezBookkeeping and Wealthfolio should use SQLite/PVC-backed storage unless a later migration is justified.
- Do not implement homepage rendering inside FinOps.

## Decisions

### Decision 1: Use ezBookkeeping as the bookkeeping core

The MVP will deploy ezBookkeeping as the primary finance application for expenses, income, transfers, accounts, categories, import/export, PWA access, and built-in charts.

Rationale:

- It is explicitly lightweight and self-hosted.
- It supports Docker, Kubernetes, SQLite/MySQL/PostgreSQL, HTTP APIs, API tokens, mobile/desktop UI, PWA, charts, imports, exports, multi-currency, and Traditional Chinese.
- It avoids the need to build custom spending dashboards in the first release.

Alternatives considered:

- Firefly III: more mature and very feature-rich, but heavier and more operationally complex for a crowded VPS.
- Actual Budget: good budgeting app, but less direct for API-driven Telegram transaction capture and stock/report integration.
- Custom bookkeeping schema: gives control, but duplicates the part ezBookkeeping already solves.

### Decision 2: Keep custom code to a thin FinOps assistant

The only custom service in the MVP should be a small assistant that handles Telegram, report orchestration, idempotency, optional pending review state, and integration glue.

Rationale:

- Telegram capture and cross-tool reporting need workflow glue.
- This keeps custom code narrow and testable.
- The assistant can be stateless where possible and store only allowlists, idempotency keys, pending review items, watchlist config, and report history.

Alternatives considered:

- n8n or a workflow automation stack: flexible, but too much always-on overhead for the MVP.
- Full custom dashboard/API: unnecessary because ezBookkeeping and Wealthfolio already provide core UI.

### Decision 2.1: Keep category changes in ezBookkeeping and persist assistant aliases

New spending categories should be created in ezBookkeeping, either through the ezBookkeeping UI or by an explicit Telegram command that calls ezBookkeeping's category API. The assistant should persist compact aliases such as `food`, `transport`, or `medical` in its SQLite state and continue accepting repo/config-provided aliases from `EZBOOKKEEPING_CATEGORY_IDS`.

Rationale:

- ezBookkeeping remains the bookkeeping source of truth.
- The assistant only owns user-friendly alias translation and does not own the category catalog.
- Telegram category creation removes the manual "copy ID into env var and restart" loop for normal single-user use.
- Unknown category text should not silently create a category, because typos would pollute the bookkeeping catalog. The assistant should ask for explicit confirmation or a category-add command before writing the transaction.
- Repo/config aliases remain useful for bootstrap and recovery, while assistant SQLite aliases make day-to-day category additions survive assistant restarts.

### Decision 3: Use Telegram first

Telegram is the first chat channel. LINE remains out of scope unless Telegram does not fit actual usage.

Rationale:

- Telegram Bot API provides straightforward HTTP webhook or long-polling integration.
- Webhook secret validation and user allowlists are enough for a single-owner MVP.
- Telegram is suitable for quick transaction capture and daily report delivery.

### Decision 4: Build the assistant as a small TypeScript service

The FinOps assistant should use TypeScript, Fastify or an equivalent low-overhead HTTP framework, direct Telegram Bot API calls, and a small SQLite-backed state store for idempotency, pending review items, watchlist settings, and report history.

Rationale:

- The assistant is glue code, not a workflow platform.
- Fastify is enough for webhook, health check, and internal report endpoints.
- Direct Telegram API usage avoids locking the project to a large bot framework before the command surface is known.
- SQLite keeps the assistant state consistent with the MVP storage strategy.

### Decision 5: Include Wealthfolio in the first implementation

The first implementation will include Wealthfolio for dedicated stock and portfolio charts, while still applying resource limits and rollback gates.

Rationale:

- Wealthfolio is local-first, self-hostable, and the web edition packages the app into a single Docker image.
- It uses SQLite storage, has dedicated investment, net-worth, performance, goals, and market-data concepts.
- It is lighter operationally than Ghostfolio, which requires PostgreSQL and Redis.

Alternatives considered:

- Ghostfolio: strong wealth management app, but heavier due to PostgreSQL and Redis dependencies.
- Rotki: useful for crypto-heavy accounting, but not the default for stock/ETF-focused personal finance.
- Maybe: not selected because its repository states it is no longer actively maintained.

### Decision 6: Use OpenBB only for scheduled Taiwan and US market research jobs

OpenBB will be used as a Python package or short-lived job for US market context and report inputs. Taiwan market data will use TWSE OpenAPI-style official end-of-day data where available, with yfinance/OpenBB provider support as a fallback for watchlist symbols. The research job will not run as a permanent service in the MVP.

Rationale:

- The user wants daily stock commentary and trading-suggestion style reports.
- OpenBB is useful for investment research data access, but an always-on service would spend resources even when idle.
- A scheduled job can fetch data, generate report inputs, then exit.
- Taiwan equities need explicit data-source handling because US-oriented providers do not always cover TWSE/TPEx consistently.

### Decision 7: Treat "trading advice" as research commentary

The app can generate trading suggestions, but they must be framed as research commentary with signals, risks, and uncertainty. The app must not execute trades or present guaranteed outcomes.

Rationale:

- Personal investment decisions are high risk.
- The app can help summarize data and surface ideas, but the user remains the decision maker.
- This avoids broker automation and keeps the system in a private research-assistant role.

### Decision 8: Use SQLite/PVC-backed app storage for MVP

The MVP will not require deploying a new PostgreSQL release. ezBookkeeping and Wealthfolio will use SQLite-backed storage on persistent volumes.

Rationale:

- The VPS already has multiple workloads.
- SQLite plus PVC is operationally smaller for single-user apps.
- Backup/restore is simpler if each component has one data directory.

### Decision 9: Send stock reports before US market open in Taiwan time

The daily stock report will be sent before the US regular market opens, using Asia/Taipei scheduling and America/New_York market calendar conversion. The report should handle US daylight saving time, so the Taiwan send time shifts with the US market open.

Rationale:

- The user invests in both Taiwan and US stocks and wants the US pre-open report.
- Taiwan market data can be included from the latest available TWSE/TPEx close or official daily data.
- If a separate Taiwan pre-open report becomes useful, it can be added later without changing the US pre-open report contract.

### Decision 9.1: Send end-of-day spending summaries through Telegram

The assistant should send a short Telegram summary near the end of the local day. It should read today's expense transactions from ezBookkeeping, group spending by category and account, include pending review count, and store the generated artifact for later review.

Rationale:

- The user wants a daily closing view of personal spending without opening the UI.
- ezBookkeeping already owns transaction data, so the assistant should read from the API instead of maintaining its own ledger.
- A separate end-of-day spending summary keeps personal spending notifications distinct from market-research or daily stock commentary.

### Decision 10: Publish metadata to the homelab homepage

FinOps components publish health and metadata for the separate `add-homelab-homepage` change. Homepage rendering remains outside FinOps.

Rationale:

- Homepage is a platform entry surface.
- FinOps is a finance assistant.
- Splitting the boundary avoids future scope drift.

## Proposed Runtime Shape

```text
User
  |-- Private browser
  |     |-- ezBookkeeping UI/PWA        (expenses, income, charts)
  |     |-- Wealthfolio UI              (portfolio charts)
  |     |-- generated report artifacts  (optional)
  |
  |-- Telegram
        |-- record expense / income / transfer
        |-- receive daily finance report
        |-- receive end-of-day spending summary
        |-- receive watchlist and market research alerts

finops namespace
  |-- ezbookkeeping                 always-on, source of truth for bookkeeping
  |-- finops-assistant              small webhook/notification/report service
  |-- wealthfolio                   first-pass portfolio UI with rollback gate
  |-- market-research CronJob       TWSE/TW market data + OpenBB/yfinance, exits after report
  |-- backups                       PVC/data export jobs
```

## Deployment and Local Testing Strategy

The production target is the existing VPS k3s cluster, but local testing should not start by deploying everything to the VPS. The development workflow should use three levels:

1. Docker Compose for fast local functional testing.
2. k3d for local k3s deployment parity.
3. VPS k3s for production deployment.

### Local functional testing

Use Docker Compose to run ezBookkeeping, Wealthfolio, the FinOps assistant, and report dry-runs with local volumes and mock secrets.

This level validates:

- ezBookkeeping and Wealthfolio basic startup
- assistant parsing and Telegram update handling with fixture payloads
- ezBookkeeping API integration
- market report dry-runs with recorded or limited API responses
- SQLite file backup/restore procedure in a controlled environment

### Local k3s deployment testing

Use k3d because production is k3s. This gives better parity than only using Docker Compose while still staying local and disposable.

This level validates:

- Helm chart rendering and installation
- namespaces, secrets, PVCs, services, ingress, and CronJobs
- local resource requests and limits
- SQLite/PVC mount behavior
- report CronJob execution
- Homepage metadata and private ingress wiring

### VPS k3s deployment

Use the same Helm chart with production values for the VPS. Production values should define private hostnames, resource limits, storage class, secrets references, backup schedules, and enabled components.

Deployment should be incremental:

1. ezBookkeeping only
2. FinOps assistant
3. Wealthfolio
4. market research CronJob
5. homepage metadata and status checks

If any component exceeds the resource budget, disable that component without deleting SQLite/PVC data.

## Suggested Phases

### Phase 1: Minimal finance tracker

- Deploy ezBookkeeping privately.
- Configure accounts, categories, currencies, import/export, and backups.
- Register ezBookkeeping in the homelab homepage.
- Validate resource usage beside FurFriend-Finder.

### Phase 2: Telegram accounting assistant

- Add thin FinOps assistant.
- Allowlist Telegram user IDs.
- Parse simple expense/income/transfer messages.
- Write accepted entries to ezBookkeeping via API.
- Send confirmation and error messages.
- List current ezBookkeeping categories/accounts through Telegram.
- Create new ezBookkeeping categories through explicit Telegram commands and persist aliases in assistant SQLite.
- Ask for confirmation when a transaction uses an unknown category instead of silently creating one.

### Phase 3: Daily report

- Generate daily spending, income, cashflow, anomaly, pending-review, and watchlist summaries.
- Send the report to Telegram.
- Send an end-of-day Telegram spending summary focused on today's expense total, top categories, top accounts, and pending reviews.
- Keep market data failures partial, not fatal.

### Phase 4: Portfolio UI

- Deploy Wealthfolio under resource limits.
- Keep rollback gates for CPU, memory, storage, authentication, and backup failures.
- Link it from homepage and daily reports.

### Phase 5: Taiwan and US market research and trading-suggestion commentary

- Add a scheduled research job for TWSE/TPEx and US watchlist symbols.
- Send the daily stock report before the US regular market open in Asia/Taipei time.
- Generate symbol-level market context and trading-suggestion commentary for Taiwan and US holdings/watchlists.
- Use LLM summarization only after source data and risk framing are in place.

## Risks / Trade-offs

- [Risk] ezBookkeeping may not cover every accounting workflow. -> Mitigation: use export/import and API integration before custom replacement work.
- [Risk] Telegram parsing can create wrong transactions. -> Mitigation: require confirmation or review for ambiguous messages and use idempotency keys.
- [Risk] Wealthfolio may still be too much for the VPS. -> Mitigation: deploy it with resource limits and a rollback gate.
- [Risk] OpenBB dependencies may make the research image large. -> Mitigation: run it as a scheduled job with resource limits and no always-on process.
- [Risk] Generated trading suggestions may sound too definitive. -> Mitigation: require signals, risks, uncertainty, and no broker execution.
- [Risk] SQLite/PVC backups can be mishandled. -> Mitigation: define stop/snapshot/export restore procedures per component.
- [Risk] Multiple existing tools fragment the experience. -> Mitigation: Telegram reports and homepage links provide the unified entry layer.

## Migration Plan

1. Replace the previous custom-first FinOps plan with the existing-project-first spec.
2. Deploy ezBookkeeping privately with PVC-backed storage and backups.
3. Add the FinOps assistant only for Telegram/report glue.
4. Add watchlist/report generation.
5. Deploy Wealthfolio with resource limits and backup coverage.
6. Add Taiwan and US market research as scheduled jobs.
7. Archive or defer heavier alternatives unless resource tests justify them.

Rollback strategy:

- Disable the FinOps assistant and scheduled jobs first.
- Keep ezBookkeeping data intact.
- Disable Wealthfolio separately if it exceeds the resource budget.
- Remove or mark FinOps homepage metadata unavailable until restored.

## Open Questions

- Which TWSE/TPEx data endpoints should be included first: daily close only, monthly revenue, institutional flows, margin trading, or fundamentals?
- How many minutes before US regular market open should the Telegram report be sent?
- Should a separate Taiwan-market pre-open report be added later, or should Taiwan stocks only appear inside the US pre-open daily report?
