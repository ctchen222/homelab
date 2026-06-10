## Why

The accepted `finops-app` spec is locally complete, but production deployment still needs a separate VPS/k3s rollout plan that proves the current single-node cluster can safely host it without destabilizing FurFriend-Finder, observability, Argo CD, or existing ingress resources.

The live `furfriend-vps` cluster on 2026-06-04 has enough apparent CPU, memory, and disk headroom for a staged FinOps rollout, but the `finops` namespace, `finops-secrets`, Argo CD Application, UI access boundary, and Telegram webhook wiring do not exist yet, and two unrelated cluster issues must be tracked separately from FinOps health.

## What Changes

- Add a dedicated production deployment change for rolling out the accepted FinOps workspace to the existing VPS k3s cluster.
- Deploy through Argo CD from the first production rollout rather than doing an owner-operated Helm install first.
- Require a preflight gate that refreshes live CPU, memory, disk, PVC, ingress, Argo CD, and workload status before installation.
- Use staged GitOps commits and values rather than enabling ezBookkeeping, the assistant, Wealthfolio, and report CronJobs all at once.
- Require production images, `finops-secrets`, Argo CD Application manifests, and a verified Traefik access boundary before exposing finance UIs or report endpoints.
- Define VPS-IP-style UI access through Traefik-owned high ports on the VPS IP, such as `178.156.151.78:8080` for ezBookkeeping and `178.156.151.78:8081` for Wealthfolio, instead of relying on raw NodePort services or bare-IP subpath routing.
- Allow owner-only plain HTTP UI access for the no-domain first release, while recording strong credential, BasicAuth, source-IP/firewall, and future HTTPS/domain hardening requirements.
- Keep Telegram webhook exposure separate from UI access because Telegram needs a public HTTPS callback URL.
- Define Telegram webhook wiring through a public HTTPS assistant webhook path that validates `X-Telegram-Bot-Api-Secret-Token` and Telegram user allowlists.
- Verify ezBookkeeping first, then the FinOps assistant and report triggers, then market-research runtime, then Wealthfolio and homepage metadata.
- Add rollback, minimal resource-budget thresholds, backup/restore, and owner-approval gates for the VPS deployment.
- Keep investment intelligence and broker sync out of this deployment change; they remain a follow-on after FinOps production baseline is stable.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `finops-app`: add Argo CD production deployment readiness, staged GitOps rollout, VPS-IP-style access, Telegram webhook wiring, runtime verification, access-control, resource-gate, and rollback requirements for the accepted FinOps workspace.

## Impact

- Affected systems: VPS k3s cluster `furfriend-vps`, namespace `finops`, Argo CD, Traefik ingress, cert-manager, local-path PVC storage, GHCR custom images, Telegram Bot API, ezBookkeeping, Wealthfolio, and market-research CronJobs.
- Affected repo areas: Argo CD Application manifests, Helm production values, secret workflow documentation, FinOps runbooks, homepage metadata, OpenSpec tasks, and future deployment evidence capture.
- The change does not introduce broker credentials, broker sync, trading, or investment-intelligence jobs.
- The change assumes Argo CD direct deployment. The current `furfriend-finder` OutOfSync state must be tracked as a separate platform issue and must not be confused with FinOps health.
