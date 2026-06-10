## ADDED Requirements

### Requirement: VPS k3s deployment preflight
The FinOps workspace SHALL complete a live VPS/k3s preflight before any production installation or upgrade.

#### Scenario: Cluster access is verified
- **WHEN** the operator prepares to deploy FinOps to the VPS
- **THEN** `kubectl` access to the `furfriend-vps` context works through the approved local access path and can read nodes, pods, PVCs, ingresses, CronJobs, and Argo CD applications

#### Scenario: Resource baseline is refreshed
- **WHEN** deployment preflight runs
- **THEN** it records current node CPU, node memory, host disk, PVC claims, top memory pods, and existing namespace/workload status before installing FinOps

#### Scenario: Existing cluster issues are present
- **WHEN** unrelated cluster issues such as Argo CD OutOfSync applications or pending non-FinOps ingress controllers exist
- **THEN** the deployment record distinguishes those issues from FinOps health and does not treat them as FinOps success or failure unless they block the selected FinOps rollout path

#### Scenario: FinOps prerequisites are missing
- **WHEN** the `finops` namespace, `finops-secrets`, custom images, Argo CD Application, Traefik UI ports, Telegram HTTPS webhook hostname, or UI access middleware are missing
- **THEN** production deployment remains blocked or limited to non-exposed staged verification until the missing prerequisite is created or explicitly deferred

### Requirement: Argo CD staged VPS rollout
The FinOps workspace SHALL be deployed to the VPS k3s cluster through Argo CD in dependency order with verification after each stage.

#### Scenario: First production rollout starts
- **WHEN** the FinOps workspace is first deployed to the VPS
- **THEN** it creates an Argo CD Application for the homelab FinOps Helm chart and uses staged GitOps values instead of enabling ezBookkeeping, the assistant, Wealthfolio, and all scheduled reports at once

#### Scenario: Argo CD desired state is configured
- **WHEN** the FinOps Argo CD Application is configured
- **THEN** it points to the `ctchen222/homelab` repository, target revision `main`, chart path `charts/finops-workspace`, destination namespace `finops`, and sync options that create the namespace when needed

#### Scenario: Staging is performed
- **WHEN** a new FinOps component is enabled
- **THEN** the desired state changes through a repository commit or approved GitOps change and Argo CD sync status is captured before runtime verification continues

#### Scenario: ezBookkeeping stage completes
- **WHEN** ezBookkeeping is enabled
- **THEN** its pod, service, private access, SQLite PVCs, owner account, categories, accounts, currencies, API token, UI workflows, and backup path are verified before Telegram writes are enabled

#### Scenario: Assistant stage completes
- **WHEN** the FinOps assistant is enabled
- **THEN** health checks, readiness checks, SQLite PVC, watchlist configuration, Telegram allowlist behavior, idempotency, and ezBookkeeping API writes are verified before scheduled report delivery is enabled

#### Scenario: Report stage completes
- **WHEN** daily finance, end-of-day spending, or market research reporting is enabled
- **THEN** one-off in-cluster execution proves service DNS, internal token use, ConfigMap mounts, secret references, output artifacts, and partial-failure behavior before schedules are trusted

#### Scenario: Wealthfolio stage completes
- **WHEN** Wealthfolio is enabled
- **THEN** portfolio, performance, net-worth, market-data refresh, authentication, SQLite PVC, and backup workflows are verified before the component is treated as production-ready

#### Scenario: Stage verification fails
- **WHEN** a stage exceeds the resource budget, breaks private access, fails health checks, or destabilizes existing FurFriend-Finder workloads
- **THEN** the newest FinOps component is disabled or rolled back while preserving PVC data by default

### Requirement: Production secrets and private access
The FinOps workspace SHALL protect all production credentials, finance data, portfolio data, assistant endpoints, and report artifacts before exposing them on the VPS.

#### Scenario: Production secrets are configured
- **WHEN** production values reference credentials
- **THEN** they reference Kubernetes secrets or an equivalent private secret store and do not commit plaintext Telegram, ezBookkeeping, Wealthfolio, market data, LLM, BasicAuth, or private-access secrets

#### Scenario: Telegram report delivery is configured
- **WHEN** daily, end-of-day, or market reports should be delivered through Telegram
- **THEN** the assistant receives `TELEGRAM_REPORT_CHAT_ID` from a secret key or approved production value before report schedules are considered complete

#### Scenario: Private ingress is configured
- **WHEN** ezBookkeeping, Wealthfolio, assistant admin paths, generated reports, or homepage links expose finance data
- **THEN** Traefik BasicAuth, VPN/Tailscale, IP allowlist, or an equivalent owner-approved boundary is verified before public or semi-public access is enabled

#### Scenario: VPS-IP-style UI access is configured
- **WHEN** the user accesses ezBookkeeping or Wealthfolio using the VPS IP concept
- **THEN** the system uses Traefik-owned high ports on the VPS IP, such as `178.156.151.78:8080` for ezBookkeeping and `178.156.151.78:8081` for Wealthfolio, instead of direct NodePort service exposure or raw bare-IP subpath routing

#### Scenario: Traefik UI ports are configured
- **WHEN** direct `IP:port` UI access is selected
- **THEN** Traefik exposes dedicated entrypoints and Service ports for the selected UI ports, routes each port to only its intended backend, and applies the owner-approved access middleware before the application receives the request

#### Scenario: UI transport is selected
- **WHEN** ezBookkeeping or Wealthfolio UI is exposed through `IP:port`
- **THEN** the deployment evidence records whether that access is temporary owner-only plain HTTP or production-ready access protected by TLS, VPN/Tailscale, SSH tunnel, or an equivalent secure transport boundary
- **AND** plain HTTP access requires strong unique credentials, BasicAuth, app login, no direct NodePort exposure, and a recorded future HTTPS/domain hardening path

#### Scenario: Telegram webhook is enabled
- **WHEN** Telegram webhook mode is used on the VPS
- **THEN** the assistant validates the Telegram webhook secret token and the Telegram user allowlist before parsing or revealing finance data

#### Scenario: Telegram webhook is registered
- **WHEN** the production Telegram webhook is registered with Telegram
- **THEN** it uses a public HTTPS URL for `POST /telegram/webhook`, sets `secret_token` to the same value as `TELEGRAM_WEBHOOK_SECRET`, limits `allowed_updates` to the required update types, sets `drop_pending_updates=true` on first production cutover, and verifies the result with `getWebhookInfo`

#### Scenario: Assistant endpoints are exposed
- **WHEN** the assistant Ingress is configured
- **THEN** `/telegram/webhook` may be publicly reachable for Telegram, while `/internal/reports/*` remains private or cluster-only and is not exposed as a public finance endpoint

#### Scenario: Production image is deployed
- **WHEN** a custom FinOps image is referenced by production values
- **THEN** the image tag is pinned and pullable from the VPS before the dependent Deployment or CronJob is enabled

#### Scenario: Production image publishing is automated
- **WHEN** FinOps assistant or market-research source changes are merged to `main` or the owner manually dispatches an image publish workflow
- **THEN** GitHub Actions builds `linux/amd64` images for `finops-assistant` and `finops-market-research`, pushes them to GHCR under the repository owner, and emits immutable or owner-selected tags that can be pinned by production values

### Requirement: Runtime resource and rollback evidence
The FinOps workspace SHALL collect production runtime evidence and retain rollback controls for every enabled component.

#### Scenario: Component is enabled
- **WHEN** a new FinOps component is enabled
- **THEN** the operator captures pods, services, PVCs, ingresses, CronJobs, node metrics, FinOps pod metrics, and existing FurFriend-Finder health before enabling the next stage

#### Scenario: Resource threshold is exceeded
- **WHEN** node memory, node CPU, disk pressure, PVC growth, or component limits exceed the owner-approved threshold
- **THEN** the deployment disables the newest optional component first and records the rollback reason

#### Scenario: Minimal resource threshold is used
- **WHEN** no stricter owner threshold is configured
- **THEN** deployment pauses for investigation at node memory `75%`, rolls back the newest optional component at node memory `80%`, rolls back on sustained node CPU above `70%`, rolls back when host disk free space is below `40Gi`, and rolls back whenever FurFriend-Finder health degrades after a FinOps stage

#### Scenario: Rollback runs
- **WHEN** a FinOps rollback is required
- **THEN** scheduled jobs are disabled first, then the assistant, then Wealthfolio, and ezBookkeeping is disabled only if the full namespace must be stopped; PVCs are preserved unless the owner explicitly requests deletion

#### Scenario: Production handoff is completed
- **WHEN** the FinOps workspace is considered deployed on VPS k3s
- **THEN** the deployment evidence includes successful health checks, private access verification, report runtime evidence, backup/restore ownership, resource snapshots, homepage metadata status, and rollback instructions
