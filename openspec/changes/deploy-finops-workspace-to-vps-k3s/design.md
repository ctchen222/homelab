## Context

`add-lightweight-finops-app` has been archived and accepted as `finops-app`. The code, tests, market-research dry-run, OpenSpec validation, Helm lint, and Helm template checks were validated repo-locally. The remaining work is production deployment and runtime evidence on the existing VPS k3s cluster.

Live VPS snapshot captured on 2026-06-04 through `furfriend-vps`:

| Area | Current state |
| --- | --- |
| Node | `178.156.151.78`, single control-plane node, k3s `v1.32.3+k3s1` |
| CPU | `162m`, about `4%` |
| Memory | `4100Mi`, about `61%`; host `free -m` reports `4866Mi` available |
| Disk | `/dev/sda1` `150G`, `11G` used, `133G` available |
| PVC claims | `28Gi` total visible through Kubernetes |
| FinOps namespace | missing |
| `finops-secrets` | missing |
| Traefik middleware | no `Middleware` resources found |
| Traefik public service ports | only `80` and `443`; no `8080` or `8081` UI ports yet |
| Helm releases | `traefik` and `cert-manager`; no FinOps release |
| Argo CD | `furfriend-finder` is `OutOfSync` but `Healthy`; observability and secrets are synced |
| Known pending pod | `default/ingress-controller-xrj6l`, pending because host ports `80/443` are already unavailable |

The live snapshot shows enough apparent headroom for the accepted FinOps budget, but the deployment must be staged because the cluster is single-node, already runs observability and FurFriend-Finder, has no swap, and stores local-path PVCs on the node disk.

## Goals / Non-Goals

**Goals:**

- Deploy the accepted FinOps workspace to VPS k3s without destabilizing current services.
- Use Argo CD as the production deployment mechanism from the first deployment.
- Keep the rollout observable, reversible, and evidence-driven.
- Verify real k3s runtime behavior for PVCs, ConfigMaps, Secrets, service DNS, Ingress, health probes, and CronJobs.
- Define how the Telegram webhook is exposed and how ezBookkeeping/Wealthfolio are accessed from the VPS IP.
- Preserve the existing FinOps app contract while adding deployment gates.

**Non-Goals:**

- Do not add investment intelligence, broker sync, or any broker credentials.
- Do not modify FurFriend-Finder PostgreSQL or fix its Argo CD OutOfSync state inside this change.
- Do not depend on the pending Zeabur ingress controller; FinOps uses Traefik.
- Do not expose finance services publicly without private access.
- Do not delete PVCs during rollback unless the owner explicitly requests data deletion.

## Decisions

### Decision 1: Use Argo CD as the production rollout path

The first FinOps deployment will be GitOps-first through Argo CD. The repository should add an Argo CD `Application` named `finops-workspace` in the `argocd` namespace. The Application source is `https://github.com/ctchen222/homelab.git`, target revision `main`, and Helm chart path `charts/finops-workspace`.

Staging still matters, but staging happens through desired-state commits instead of direct `helm install` commands. The production values must start with the smallest useful enabled set, then later commits enable the assistant, reports, market research, and Wealthfolio one stage at a time.

Rationale:

- The chart already renders the required Kubernetes resources.
- The user explicitly wants to deploy through Argo CD.
- The existing VPS already runs Argo CD and uses it for FurFriend-Finder and observability.
- GitOps gives a clear desired-state history for finance infrastructure and avoids local-only Helm drift.
- The current `furfriend-finder` Argo CD application is `OutOfSync` due an immutable PostgreSQL StatefulSet field patch. That should not block FinOps, but the FinOps Application must be verified independently and must not treat the existing OutOfSync state as FinOps health evidence.

### Decision 2: Gate every stage with live cluster evidence

Each stage must capture node usage, FinOps pod usage, health status, PVCs, Ingresses, CronJobs, and FurFriend-Finder health before enabling the next component.

Recommended gates:

- Minimal-operation rollback threshold: node memory at or above `75%` after a stage requires pausing and investigating; node memory at or above `80%`, disk free space under `40Gi`, node CPU sustained above `70%`, or any FurFriend-Finder health degradation requires disabling the newest FinOps component first.
- FurFriend-Finder pods and ingress must remain healthy.
- The newest FinOps component is the first rollback target when resource or health gates fail.
- Scheduled jobs are disabled or suspended until one-off runtime verification succeeds.

### Decision 3: Create namespace, secrets, and private access before exposing services

`private access` means the first gate in front of personal finance UI. It prevents ezBookkeeping, Wealthfolio, assistant admin endpoints, and report artifacts from being readable by anyone who can hit the VPS public IP.

For this VPS-IP-oriented deployment, the selected minimum UI access shape is Traefik-owned high ports on the VPS IP:

| Service | Recommended access | Reason |
| --- | --- | --- |
| ezBookkeeping | `http(s)://178.156.151.78:8080` | direct VPS IP access while Traefik still applies the UI gate before the app |
| Wealthfolio | `http(s)://178.156.151.78:8081` | direct VPS IP access on a separate Traefik entrypoint |
| FinOps assistant webhook | public HTTPS hostname, temporarily `https://finops-assistant.178-156-151-78.sslip.io/telegram/webhook` until an owner domain exists | Telegram requires a public HTTPS callback URL; this is separate from browser UI access |

Raw single-origin access such as `https://178.156.151.78/ezbookkeeping` is not the recommended production UI entrypoint because path prefixes are risky when upstream apps do not fully support being hosted under a subpath. Separate ports are simpler for a minimal deployment:

```text
Browser
  ├─ http(s)://178.156.151.78:8080 ─▶ Traefik entrypoint ezbookkeeping-ui ─▶ BasicAuth ─▶ ezBookkeeping
  └─ http(s)://178.156.151.78:8081 ─▶ Traefik entrypoint wealthfolio-ui    ─▶ BasicAuth ─▶ Wealthfolio
```

The owner has confirmed that the first release may use plain HTTP `IP:port` UI access because this is an owner-only tool and no domain is available yet. This is acceptable only as a minimal first release with explicit security guardrails because BasicAuth and app login credentials are transported without TLS. Future hardening should add HTTPS after a domain is available, or place UI access behind VPN/Tailscale/SSH tunnel.

The minimum private-access implementation is:

- Traefik static entrypoints and Service ports for `8080` and `8081`, not direct NodePort service exposure.
- IngressRoute, TCP/HTTP route, or equivalent Traefik routing from each dedicated entrypoint to the correct backend service.
- Traefik BasicAuth middleware for ezBookkeeping and Wealthfolio as the outer gate.
- The application login remains enabled inside the UI: ezBookkeeping owner login and Wealthfolio auth.
- Strong unique passwords are used for BasicAuth and app login credentials; no reused personal password is used for this plain HTTP phase.
- Firewall or source-IP restriction is used when practical; if the owner IP is unstable, the deployment record explicitly notes that the UI ports are public internet endpoints protected only by BasicAuth and app login.
- Assistant `/internal/*` report endpoints are not exposed publicly.

Rationale:

- Finance and portfolio data are sensitive.
- Current live cluster has no Traefik `Middleware` resources, while `values-prod.yaml` references `finops-private-access@kubernetescrd`.
- The user wants a VPS-IP-oriented access path and explicitly asked whether `IP:port` can be used. Separate Traefik-owned UI ports satisfy that mental model with fewer upstream app assumptions than bare-IP subpaths.
- The user does not currently have a domain and accepts HTTP for the owner-only first release, but the deployment must keep that risk visible and leave a clear HTTPS/domain hardening path.
- Telegram webhook mode requires public HTTPS reachability, so the webhook path must be handled differently from finance UI access.

### Decision 4: Roll out components in dependency order

Enable components in this order:

1. Commit and sync Argo CD Application with namespace, secrets references, private-access middleware, dedicated Traefik UI entrypoint, and ezBookkeeping only.
2. Commit and sync assistant with Telegram webhook host configured, but scheduled reports still disabled.
3. Commit and sync one-off daily/end-of-day report verification, then enable schedules.
4. Commit and sync market-research CronJob after one-off runtime verification.
5. Commit and sync Wealthfolio after resource and access gates pass.
6. Commit homepage metadata and production handoff evidence.

Rationale:

- ezBookkeeping is the source of truth and must be stable before Telegram writes.
- Report endpoints depend on the assistant and ezBookkeeping.
- Wealthfolio is useful but optional if it exceeds resource or backup gates.
- Market research is short-lived and should be proven as a k3s Job before schedule reliance.

### Decision 5: Treat image and secret readiness as hard preconditions

The custom images referenced by production values must be pullable before deployment. Production secrets are owner-operated and must not be committed.

Image publishing has two tracks:

- First release may use an owner-operated manual `docker buildx build --platform linux/amd64 --push` flow to publish the pinned `0.1.0` tags.
- Follow-on image publishing should be handled by GitHub Actions. The workflow builds `linux/amd64` images for `apps/finops-assistant` and `jobs/market-research`, pushes to `ghcr.io/ctchen222`, and uses manual `workflow_dispatch` tags for release pins or `main-<commit-sha>` tags for automatic main-branch builds.

The GitHub Actions workflow does not automatically mutate Helm production values. Production values remain explicitly pinned so Argo CD only deploys a tag after the owner chooses it.

Required secret keys remain those from the accepted runbook with one deployment-critical addition: `telegram-report-chat-id` or an equivalent Helm value must be wired into `TELEGRAM_REPORT_CHAT_ID`, otherwise generated daily reports may not be pushed to Telegram.

Required keys:

- `telegram-bot-token`
- `telegram-webhook-secret`
- `telegram-allowed-user-ids`
- `telegram-report-chat-id`
- `ezbookkeeping-api-token`
- `ezbookkeeping-secret-key`
- `assistant-internal-token`
- `wealthfolio-secret-key`
- `wealthfolio-auth-password-hash`
- BasicAuth credentials for the Traefik private UI middleware, stored as a Secret

Optional keys:

- `market-data-api-token`
- `llm-api-key`

### Decision 6: Keep runtime evidence distinct from repo-local validation

Repo-local tests prove implementation logic and chart rendering. VPS deployment evidence must prove cluster runtime behavior: image pulls, probes, PVC binding, service DNS, ConfigMap mounts, secret references, Ingress/private access, CronJob execution, report artifacts, and resource usage.

### Decision 7: Split Telegram webhook exposure from finance UI access

Telegram webhook setup must use a public HTTPS URL because Telegram sends updates to the bot through outbound HTTPS POST requests. The assistant already exposes `POST /telegram/webhook` and validates `X-Telegram-Bot-Api-Secret-Token` when `TELEGRAM_WEBHOOK_SECRET` is configured.

The production webhook URL should be:

```text
https://finops-assistant.178-156-151-78.sslip.io/telegram/webhook
```

Webhook registration uses the Bot API `setWebhook` method with:

- `url`: the public HTTPS webhook URL
- `secret_token`: the same value as `TELEGRAM_WEBHOOK_SECRET`
- `allowed_updates`: at minimum `message` and `callback_query`
- `drop_pending_updates`: `true` for the first production cutover so stale local/dev updates are not replayed into production

The webhook Ingress must allow Telegram to reach `/telegram/webhook`. It must not expose `/internal/reports/*` publicly. If the same assistant host is used for both webhook and admin/report paths, the chart must support path-specific middleware or separate Ingress objects so the public webhook path is not blocked by BasicAuth while internal report paths remain private or cluster-only.

## Risks / Trade-offs

- [Risk] The cluster has no private-access middleware yet. -> Mitigation: add a Traefik BasicAuth middleware and Secret for UI entrypoints before enabling UI access.
- [Risk] Node memory is already around 61% by metrics-server. -> Mitigation: staged GitOps commits, strict resource limits, pause at 75%, rollback newest component at 80% or when FurFriend-Finder degrades.
- [Risk] `furfriend-finder` Argo CD is OutOfSync. -> Mitigation: treat it as a separate platform issue; do not use it as FinOps health evidence.
- [Risk] The Zeabur ingress controller pod is pending due hostPort conflict. -> Mitigation: FinOps uses Traefik and does not depend on that controller.
- [Risk] Production custom images may not exist or may be private. -> Mitigation: verify image pulls before enabling dependent components.
- [Risk] Automated image publishing overwrites a production tag unexpectedly. -> Mitigation: manual dispatch owns release tags such as `0.1.0`; automatic `main` builds publish commit-derived tags and production values stay explicitly pinned.
- [Risk] SQLite/PVC backup is skipped in a fast deploy. -> Mitigation: backup/restore is part of the acceptance gate, not a postscript.
- [Risk] Telegram webhook needs public reachability while finance UI must remain gated. -> Mitigation: expose only `/telegram/webhook` publicly with Telegram secret-token validation and user allowlist; keep `/internal/*` and UI behind BasicAuth/application auth.
- [Risk] Plain HTTP `IP:port` UI exposes BasicAuth and app login credentials in transit. -> Mitigation: owner accepts this only for the no-domain first release; use strong unique credentials, avoid credential reuse, prefer source-IP restriction when practical, and add HTTPS/domain or VPN/Tailscale/SSH-tunnel hardening later.
- [Risk] Bare-IP subpath access cannot route multiple web apps cleanly. -> Mitigation: use separate Traefik-owned ports for UI apps.

## Migration Plan

1. Archive the completed FinOps spec and validate accepted specs.
2. Refresh VPS access and resource baseline.
3. Add FinOps Argo CD Application and production values that start with ezBookkeeping only.
4. Add private UI access middleware and dedicated VPS IP UI ports.
5. Publish or verify FinOps assistant and market-research images through either the first-release manual GHCR push or the GitHub Actions image workflow.
6. Add SOPS or owner-operated Secret workflow for `finops-secrets`, including `telegram-report-chat-id`.
7. Sync ezBookkeeping through Argo CD and verify UI, storage, backup, and resource usage.
8. Sync the assistant and verify health, Telegram allowlist, idempotency, webhook registration, and ezBookkeeping writes.
9. Run daily and end-of-day report triggers once inside k3s, then enable schedules through a GitOps commit.
10. Run market research once from the CronJob template, then enable schedule through a GitOps commit.
11. Enable Wealthfolio through a GitOps commit and verify UI, auth, backup, and resource usage.
12. Publish homepage metadata and record production evidence.

Rollback strategy:

- Disable or suspend market research first.
- Disable daily and end-of-day report schedules next.
- Disable the assistant if Telegram or ezBookkeeping integration misbehaves.
- Disable Wealthfolio if it exceeds resource, auth, or backup gates.
- Preserve PVCs by default.

## Open Questions

- Are the production `ghcr.io/ctchen222/finops-assistant:0.1.0` and `ghcr.io/ctchen222/finops-market-research:0.1.0` images already published and pullable from the VPS?
