# FinOps Stack and Resource Baseline

This document captures the MVP stack, the current k3s workload baseline, and the resource guardrails for `add-lightweight-finops-app`.

## Selected Stack

The MVP is existing-project-first:

- ezBookkeeping is the bookkeeping source of truth for expenses, income, transfers, accounts, categories, import/export, PWA access, and spending charts.
- FinOps assistant is the only custom always-on service. It handles Telegram ingestion, allowlisting, idempotency, pending review state, report orchestration, and glue code.
- Wealthfolio is the first portfolio UI for holdings, performance, net worth, and investment charts.
- Market research runs as a scheduled or on-demand job. It is not a permanent OpenBB service.
- Optional LLM summarization is outside the write path and only summarizes already-collected report data.

The MVP intentionally avoids building a custom finance dashboard while ezBookkeeping and Wealthfolio can cover the primary web UI surfaces.

## Investment Intelligence Boundary

The investment work is split into three layers so bookkeeping, broker data, and recommendations can be verified independently.

| Layer | Owns | Produces | Must not do |
| --- | --- | --- | --- |
| FinOps MVP, from `finops-app` | ezBookkeeping, the Telegram assistant, daily finance summaries, Wealthfolio deployment, and small watchlist market commentary | Bookkeeping records, assistant state, daily finance reports, Wealthfolio availability, and watchlist-level market research artifacts | Require broker credentials, sync real broker accounts, store raw broker exports, or generate market-wide portfolio-aware recommendations |
| Portfolio sync, from `add-investment-intelligence-broker-sync` | Read-only SinoPac/Firstrade/future-broker connectors or CSV importers, normalized portfolio snapshots, source freshness, import safety, and Wealthfolio export/display integration | Versioned snapshot envelopes with account aliases, holdings, cash balances, activity rows, sync status, source type, as-of timestamps, errors, and freshness metadata | Place trades, edit orders, move cash, mutate broker accounts, scrape authenticated broker websites by default, ingest market-universe/news data, or render Telegram investment recommendations |
| Investment research reports, from `add-investment-research-reports` | Taiwan/US market-universe data, official filings, approved news/RSS, narrative evidence, deterministic signals, recommendation policy, LLM-assisted report prose, and Telegram investment report delivery | Source-linked signals, recommendation objects, source freshness notes, general market sections, personal portfolio review sections, and private detailed artifacts | Load broker credentials, read raw broker exports, scrape Wealthfolio UI, write portfolio snapshots, write Wealthfolio holdings, or bypass deterministic evidence and policy gates with LLM output |

Boundary contracts:

- The FinOps MVP can run without portfolio sync or investment research reports. Wealthfolio is available as the first portfolio UI, but it is not the source of truth for broker-synced snapshots.
- Portfolio sync depends on the private FinOps boundary and Wealthfolio availability for display/export, but its durable source of truth is the normalized snapshot store.
- The Helm chart exposes a `portfolioSync` gate that defaults to `enabled=false`, `mode=disabled`, and `baseline.wealthfolioReady=false`. Until that baseline flag is set, render-time validation allows only `disabled` or `fixture` mode.
- Normalized portfolio schema contracts live in `docs/finops/investment-portfolio-contracts.md`.
- Investment research reports consume only normalized portfolio snapshots and freshness metadata. If snapshots are stale, unavailable, or partial, reports must downgrade or suppress personal portfolio sections and may still send general market commentary.
- Existing watchlist market research remains watchlist-level commentary. Market-wide Taiwan/US intelligence, news/theme ingestion, signal generation, and recommendation policy belong to `add-investment-research-reports`.
- Broker account access is read-only by default. Any workflow that would place orders, modify orders, move cash, mutate account settings, or reuse authenticated broker website sessions is outside these layers unless a future security-reviewed OpenSpec change explicitly approves it.

## Live VPS Baseline

Captured from the `furfriend-vps` Kubernetes context on 2026-05-22.

Node:

- Node: `178.156.151.78`
- Kubernetes: `v1.32.3+k3s1`
- OS: Ubuntu 24.04.3 LTS
- CPU capacity: `4`
- CPU allocatable: `3500m`
- Memory capacity: `7937252Ki`
- Memory allocatable: `6872292Ki`
- Ephemeral storage allocatable: `157197504Ki`

Current usage from metrics-server:

- Node CPU: `126m`, about 3% of capacity.
- Node memory: `4252Mi`, about 63% of capacity.
- Estimated allocatable memory headroom at capture time: about `2459Mi`.
- Estimated allocatable CPU headroom at capture time: about `3374m`.

Existing namespaces and workloads:

- `furfriend-finder`: application deployment, PostgreSQL statefulset, schema job, and PostgreSQL backup CronJob.
- `observability`: Grafana, Loki, Prometheus, Tempo, and OpenTelemetry Collector.
- `argocd`: Argo CD controller, repo server, server, Redis, Dex, notifications, and ApplicationSet controller.
- `cert-manager`: cert-manager controller, webhook, and cainjector.
- `kube-system`: CoreDNS, Traefik, metrics-server, local-path provisioner, and k3s service load balancer.
- `default`: Zeabur support services, NATS, node-exporter, cAdvisor, fluent-bit, and vector aggregator.

Current PVC claims:

- `default/nats-data-nats-0`: `1Gi`
- `furfriend-finder/data-furfriend-finder-postgresql-0`: `10Gi`
- `observability/data-loki-0`: `5Gi`
- `observability/data-prometheus-0`: `5Gi`
- `observability/data-tempo-0`: `5Gi`
- `observability/grafana-data`: `2Gi`
- Total claimed PVC capacity visible through Kubernetes: `28Gi`

Storage caveat: Kubernetes reports about `150Gi` allocatable ephemeral storage, but local-path PVCs share node disk. Before production install, verify host free space with a node-level disk check or an equivalent owner-operated VPS check.

## MVP Resource Budget

The first always-on budget keeps FinOps under roughly `1Gi` memory limit and below `1 CPU` limit across all enabled always-on services:

| Component | Request CPU | Request Memory | Limit CPU | Limit Memory | Storage |
| --- | ---: | ---: | ---: | ---: | --- |
| ezBookkeeping | `50m` | `128Mi` | `250m` | `256Mi` | `2Gi` PVC for SQLite and object storage |
| FinOps assistant | `25m` | `64Mi` | `100m` | `128Mi` | `512Mi` PVC for SQLite state and reports |
| Wealthfolio | `100m` | `256Mi` | `500m` | `512Mi` | `2Gi` PVC for SQLite data |
| Market research CronJob | `100m` | `128Mi` | `500m` | `512Mi` | Writes reports to assistant/report storage or object storage |

Resource gates:

- Enable ezBookkeeping first and confirm FurFriend-Finder remains healthy.
- Enable the assistant second and confirm Telegram writes do not duplicate transactions.
- Enable Wealthfolio third; disable it if it pushes node memory pressure, storage growth, auth, backup, or ingress beyond the budget.
- Run market research as a short-lived CronJob. It must exit after generating a report.
- Keep LLM summarization disabled until raw source data, risk framing, and partial-failure behavior are verified.

## Storage Choice

The MVP uses SQLite on persistent volumes:

- ezBookkeeping uses its built-in SQLite database path under `/ezbookkeeping/data`.
- Wealthfolio uses `WF_DB_PATH=/data/wealthfolio.db`.
- FinOps assistant stores idempotency keys, pending review items, and report history in `/data/assistant.sqlite`.

This avoids adding another PostgreSQL or Redis instance to the VPS. A later migration to PostgreSQL should be justified by usage, concurrency, backup, or reporting needs.

## Platform Conventions

- Namespace: `finops`
- Ingress class: `traefik`
- Private access: require the selected private access boundary before exposing finance UI, assistant endpoints, generated reports, or portfolio UI.
- Secrets: Kubernetes Secret or an equivalent private secret store; no Telegram, ezBookkeeping, market data, LLM, Wealthfolio, or private access tokens in the repo.
- Backups: backup each SQLite/PVC-backed component separately and test restore before production reliance.
- Homepage integration: publish metadata for the separate homelab homepage; FinOps does not render homepage UI.

## Alternatives Not Selected by Default

- Firefly III: mature and feature-rich, but heavier and more operationally complex for this crowded VPS.
- Actual Budget: useful budgeting UI, but less direct for API-driven Telegram transaction capture and investment/report glue.
- Maybe: not selected for the MVP because the active plan prefers maintained, focused tools and avoids taking on a full finance platform replacement.
- Ghostfolio: capable portfolio product, but the MVP avoids its extra PostgreSQL and Redis footprint while Wealthfolio can start with SQLite.
- Full custom dashboard: deferred because ezBookkeeping and Wealthfolio already provide the initial charting surfaces.

## Upstream References

- ezBookkeeping official Docker docs confirm the `mayswind/ezbookkeeping` image, port `8080`, default SQLite data path, persistent volumes, UID/GID `1000`, and `EBK_{SECTION}_{OPTION}` environment override format.
- ezBookkeeping official API docs confirm Bearer-token API access under `/api/v1/{API_PATH}`, API token enablement through `security.enable_api_token`, and transaction add/list payload fields.
- Wealthfolio official GitHub docs confirm the `wealthfolio/wealthfolio:latest` image, port `8088`, `WF_LISTEN_ADDR=0.0.0.0:8088`, `WF_DB_PATH=/data/wealthfolio.db`, `WF_SECRET_KEY`, `/data` volume, and cookie-based web auth guidance.
- TWSE and TPEx OpenAPI specs are the first Taiwan market data source for listed and OTC symbols.
