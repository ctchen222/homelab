# Plan: FinOps VPS k3s Deployment

> Source PRD: accepted `finops-app` spec plus archived `add-lightweight-finops-app` design/runbook, refreshed against the live `furfriend-vps` k3s cluster on 2026-06-04.

## Architectural decisions

Durable decisions that apply across all phases:

- **Deployment target**: single-node VPS k3s cluster at `178.156.151.78`, Kubernetes `v1.32.3+k3s1`, context `furfriend-vps` through the local SSH tunnel `127.0.0.1:16643 -> VPS 127.0.0.1:6443`.
- **Rollout method**: first production rollout uses Argo CD directly. Staging is done through GitOps commits and staged production values, not through a local `helm install`.
- **Namespace and storage**: namespace `finops`, storage class `local-path`, SQLite/PVC-backed state for ezBookkeeping, the assistant, and Wealthfolio.
- **Access model**: use Traefik-owned high ports on the VPS IP for browser UI access: `178.156.151.78:8080` for ezBookkeeping and `178.156.151.78:8081` for Wealthfolio. Because no domain is available yet, the first release may use owner-only plain HTTP with strong unique credentials, Traefik BasicAuth, app login, and recorded risk. Future hardening should add HTTPS/domain, VPN/Tailscale, or SSH tunnel. Telegram webhook path is separate: it needs a public HTTPS hostname and validates the Telegram secret header and allowlist.
- **Secrets**: production values reference `finops-secrets`; plaintext Telegram, ezBookkeeping, Wealthfolio, market data, LLM, private-access, or account secrets are never committed.
- **Routes and triggers**: assistant health uses `/healthz` and `/readyz`; internal reports use `/internal/reports/daily` and `/internal/reports/end-of-day-spending`; market research is a short-lived job, not an always-on service.
- **Resource gates**: keep always-on FinOps services near the accepted budget of less than `1Gi` memory limit and less than `1 CPU` limit. Pause at node memory `75%`; rollback the newest optional component at memory `80%`, sustained CPU over `70%`, disk free below `40Gi`, or any FurFriend-Finder health degradation.
- **Live baseline on 2026-06-04**: node CPU `162m` / `4%`, node memory `4100Mi` / `61%`, host disk `/` `11G` used and `133G` available, Kubernetes PVC claims `28Gi`. `finops` namespace and `finops-secrets` do not exist yet. No Traefik middleware exists yet. One Zeabur `ingress-controller` pod is pending due hostPort conflict; FinOps must not depend on it.
- **Production-input refresh on 2026-06-10**: Traefik now exposes `8080` and `8081`, and the stray `furfriend-test` wildcard Ingress has been removed; both ports return Traefik `404` until FinOps IngressRoutes are synced. UFW allows `8080/tcp` and `8081/tcp` from `Anywhere` and marks both rules as `restrict to owner IP later`, so the no-domain first release is public plain HTTP until source-IP, VPN, SSH tunnel, TLS, or equivalent hardening is added. GHCR owner is `ctchen222`, matching the authenticated GitHub account and existing production image namespace.

---

## Phase 1: VPS Preflight and Deployment Gates

**User stories**: deploy FinOps to the existing k3s VPS without destabilizing FurFriend-Finder; respect current memory, CPU, disk, ingress, and GitOps constraints.

### What to build

Create the production deployment gate that proves the operator can reach the cluster, captures current resource headroom, confirms the namespace/secrets/private-access preconditions, and records unrelated cluster risks before installing anything.

### Acceptance criteria

- [ ] The `furfriend-vps` access path is verified through the SSH tunnel and `kubectl` can read nodes, pods, PVCs, Ingresses, CronJobs, and Argo CD Applications.
- [ ] A fresh resource snapshot records node CPU, memory, host disk, PVC claims, and current top memory pods.
- [ ] The plan explicitly records that `finops` namespace, `finops-secrets`, Traefik UI ports, Telegram HTTPS webhook hostname, and the UI access gate are missing before deployment.
- [ ] Existing cluster issues are recorded separately from FinOps rollout health: `furfriend-finder` Argo CD OutOfSync and the pending Zeabur ingress controller.
- [ ] The rollout method is confirmed as Argo CD direct with staged GitOps values.

---

## Phase 2: Argo CD, Production Inputs, and Image Readiness

**User stories**: deploy only with real production inputs, no plaintext secrets, and pullable custom images.

### What to build

Prepare the production inputs needed before the first Argo CD sync: Argo Application manifest, pinned images, image publishing path, required secret keys, private UI boundary, Traefik `8080/8081` UI ports, public HTTPS webhook hostname, staged production values, and rollback controls that can disable each FinOps component independently.

### Acceptance criteria

- [ ] Argo CD Application `finops-workspace` points to `https://github.com/ctchen222/homelab.git`, revision `main`, chart path `charts/finops-workspace`, and namespace `finops`.
- [ ] The custom assistant and market-research images are built, pushed, and verified as pullable from the VPS container runtime or GHCR.
- [ ] GitHub Actions can publish `linux/amd64` FinOps assistant and market-research images to GHCR on manual dispatch or main-branch source changes, while production values remain pinned to owner-selected tags.
- [ ] `finops-secrets` exists in the `finops` namespace with the required keys, including `telegram-report-chat-id`, without committing plaintext values.
- [ ] Traefik BasicAuth or a stricter access gate is present before enabling finance UI or generated report ingress.
- [ ] Traefik exposes dedicated entrypoints and Service ports for ezBookkeeping on `8080` and Wealthfolio on `8081`.
- [ ] Direct `IP:port` UI access records the no-domain owner-only HTTP risk, source-IP restriction status, strong credential setup, and future HTTPS/domain hardening path.
- [ ] Staged values can render ezBookkeeping-only, assistant-only, reports-only, market-research, and Wealthfolio stages without enabling all components at once.
- [ ] Helm lint and template checks pass for every staged production values set.

---

## Phase 3: ezBookkeeping Production Slice

**User stories**: get bookkeeping source of truth running first with persistent storage, private access, backup, and UI validation.

### What to build

Sync only ezBookkeeping through Argo CD into the `finops` namespace, validate storage and private UI access, create the initial owner setup, and prove one backup/restore-safe workflow before enabling Telegram writes.

### Acceptance criteria

- [ ] Argo CD sync/health plus ezBookkeeping pod, service, ingress, and PVC are healthy in k3s.
- [ ] Owner account, TWD/USD currencies, initial accounts, categories, import/export, and API token are configured.
- [ ] Expense, income, transfer, account, category, chart, and PWA workflows are verified in the UI.
- [ ] Resource usage after enabling ezBookkeeping remains inside budget and FurFriend-Finder remains healthy.
- [ ] A minimal backup and restore drill is documented or executed for ezBookkeeping data paths.

---

## Phase 4: Assistant and Finance Reports Slice

**User stories**: enable Telegram bookkeeping and daily finance reports without duplicate writes or public finance exposure.

### What to build

Enable the FinOps assistant through a GitOps commit after ezBookkeeping is ready. Verify health/readiness, Telegram webhook registration, allowlist behavior, ezBookkeeping API writes, report chat delivery, and one-off internal report triggers before scheduling daily reports.

### Acceptance criteria

- [ ] The assistant pod, service, readiness, liveness, SQLite PVC, and watchlist ConfigMap mount are healthy.
- [ ] Telegram webhook is registered with `setWebhook`, public HTTPS URL, `secret_token`, required `allowed_updates`, `drop_pending_updates=true` for the first production cutover, and verified with `getWebhookInfo`.
- [ ] `/telegram/webhook` is reachable by Telegram while `/internal/reports/*` remains private or cluster-only.
- [ ] Telegram validation covers secret token, allowlist, duplicate update handling, and unknown-category review.
- [ ] A non-production transaction reaches ezBookkeeping and duplicate delivery does not create a duplicate record.
- [ ] `/internal/reports/daily` and `/internal/reports/end-of-day-spending` are triggered once from inside the cluster and produce expected partial or complete summaries.
- [ ] Resource usage after enabling the assistant and report triggers remains inside budget.

---

## Phase 5: Market Research Runtime Slice

**User stories**: verify the daily TW/US research report as a real k3s CronJob before relying on the schedule.

### What to build

Enable the market-research job through a GitOps commit, run it manually from the CronJob template, verify ConfigMap, environment, output path, provider failure handling, and resource behavior, then enable the schedule.

### Acceptance criteria

- [ ] The market-research image is pullable and the CronJob renders with strict CPU and memory limits.
- [ ] A one-off Job created from the CronJob completes successfully and writes the expected report artifact.
- [ ] Provider unavailable or partial data states are visible as partial report status rather than job-wide failure when appropriate.
- [ ] The schedule runs before US regular market open using America/New_York time rules and Asia/Taipei operator expectations.
- [ ] Resource usage during the job does not exceed the short-lived job budget or destabilize existing workloads.

---

## Phase 6: Wealthfolio and Homepage Slice

**User stories**: add portfolio visibility and service discovery only after core bookkeeping and reports are stable.

### What to build

Enable Wealthfolio behind private access, verify portfolio and backup workflows, then publish homepage metadata so the private homepage can link to enabled FinOps components with accurate status.

### Acceptance criteria

- [ ] Wealthfolio pod, service, ingress, auth, and SQLite PVC are healthy.
- [ ] Portfolio, performance, net-worth, market-data refresh, and backup/restore workflows are verified.
- [ ] Wealthfolio can be disabled without breaking ezBookkeeping, the assistant, or reports if it exceeds resource or operational budget.
- [ ] Homepage metadata reflects enabled, disabled, or unknown component states accurately.
- [ ] Resource usage after enabling Wealthfolio remains inside budget and FurFriend-Finder remains healthy.

---

## Phase 7: Production Handoff

**User stories**: make the deployment repeatable, observable, reversible, and ready for later investment-intelligence work.

### What to build

Finalize the production runbook with rollback, backups, resource thresholds, scheduled-job checks, access checks, and Argo CD sync/health evidence.

### Acceptance criteria

- [ ] Rollback commands can disable market research, daily reports, assistant, Wealthfolio, and ezBookkeeping without deleting PVCs.
- [ ] Backup and restore ownership is documented for every SQLite/PVC-backed component.
- [ ] Production health evidence includes pods, services, PVCs, ingresses, CronJobs, report artifacts, and resource snapshots.
- [ ] FinOps Argo CD Application is synced and healthy independently of the existing `furfriend-finder` OutOfSync issue.
- [ ] The deployment baseline is ready for `add-investment-intelligence-broker-sync` to consume the Telegram/reporting surface without changing the FinOps MVP contract.
