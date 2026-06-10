# homelab

Homelab platform repo for k3s deployment artifacts, OpenSpec changes, and operational runbooks.

## FinOps Workspace

FinOps work in this repo is tracked through OpenSpec. The archived
`add-lightweight-finops-app` change defines the app baseline, and the active
`deploy-finops-workspace-to-vps-k3s` change tracks the VPS/k3s rollout:

- ezBookkeeping for bookkeeping and spending charts.
- A thin TypeScript FinOps assistant for Telegram ingestion and reports.
- Wealthfolio for portfolio charts.
- Scheduled market research jobs for Taiwan and US watchlists.

Key files:

- `docs/finops/stack-and-baseline.md`
- `docs/finops/operations-runbook.md`
- `apps/finops-assistant/`
- `jobs/market-research/`
- `deploy/finops/docker-compose.yaml`
- `charts/finops-workspace/`
