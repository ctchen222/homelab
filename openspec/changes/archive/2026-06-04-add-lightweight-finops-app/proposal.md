## Why

The homelab needs a lightweight FinOps workspace that can run on the same 8 GB RAM / 8 CPU VPS as FurFriend-Finder without consuming most of the remaining capacity. The user wants a practical finance assistant for spending, income, portfolio visibility, Telegram bookkeeping, notifications, and daily market research, preferably by composing existing self-hosted projects instead of building a full custom finance platform.

## What Changes

- Add a lightweight FinOps workspace capability for personal bookkeeping, charts, Telegram accounting, notifications, portfolio visibility, and daily market research.
- Use ezBookkeeping as the default bookkeeping and spending-analysis application for the MVP.
- Add a thin FinOps assistant only for Telegram ingestion, notification delivery, daily reports, idempotency, and glue logic.
- Let the assistant list ezBookkeeping accounts/categories, create new ezBookkeeping categories through the API after user intent is explicit, and persist Telegram aliases without parser changes.
- Add an end-of-day Telegram spending summary that reports today's spending totals from ezBookkeeping.
- Include Wealthfolio in the first implementation for dedicated portfolio and stock visualizations, with resource limits and rollback gates.
- Use OpenBB only as a scheduled or on-demand research job for daily Taiwan and US market context, not as an always-on service.
- Frame trading suggestions as research commentary with signals, risks, and uncertainty; do not automate broker trades.
- Use SQLite/PVC-backed app storage for ezBookkeeping and Wealthfolio in the MVP to minimize footprint.
- Send the daily stock report before the US regular market opens, calculated in Asia/Taipei time with US daylight-saving handling.
- Define resource gates so the app can coexist with the existing FurFriend-Finder workloads on the same VPS.
- Publish health and service metadata for the separate homelab homepage to consume.
- Defer heavier alternatives such as Firefly III, Ghostfolio, and a custom finance dashboard until the MVP proves useful or resource tests justify them.

## Capabilities

### New Capabilities

- `finops-app`: Personal finance workspace covering one chat/web user experience, bookkeeping integration, chat-ready ingestion, portfolio visibility, market-research summaries, daily digest generation, and resource guardrails.

### Modified Capabilities

- None.

## Impact

- Adds OpenSpec requirements for a new FinOps workspace under the homelab platform.
- Future implementation will likely add ezBookkeeping deployment, a small FinOps assistant, optional Wealthfolio deployment, an OpenBB research CronJob, Kubernetes manifests or Helm chart, scheduled backup/report jobs, Telegram secrets, and service metadata consumed by the separate homelab homepage.
- Sensitive data handling, authentication, backups, and admin access must be designed before production exposure.
