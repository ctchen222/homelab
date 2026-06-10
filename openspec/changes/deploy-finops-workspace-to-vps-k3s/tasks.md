## 1. Archive and Baseline

- [x] 1.1 Archive `add-lightweight-finops-app` and promote `finops-app` into accepted specs.
- [x] 1.2 Validate all OpenSpec changes and accepted specs after archive.
- [x] 1.3 Refresh live VPS access through the `furfriend-vps` context and record current CPU, memory, disk, PVC, workload, Ingress, and Argo CD status.
- [x] 1.4 Record deployment risks that are not FinOps failures: `furfriend-finder` Argo CD OutOfSync and pending Zeabur ingress controller hostPort conflict.
- [x] 1.5 Confirm first production rollout should use Argo CD GitOps directly, not owner-operated Helm first.
- [x] 1.6 Confirm VPS-IP-style UI access should use direct VPS IP ports, with ezBookkeeping on `178.156.151.78:8080` and Wealthfolio on `178.156.151.78:8081`, rather than IP-derived hostnames for browser UI.
- [x] 1.7 Confirm the minimum UI access gate is Traefik BasicAuth plus app login.
- [x] 1.8 Define minimal rollback thresholds: pause at node memory `75%`, rollback newest optional component at memory `80%`, sustained CPU above `70%`, disk free below `40Gi`, or FurFriend-Finder health degradation.
- [x] 1.9 Confirm direct `IP:port` UI access may use owner-only plain HTTP for the no-domain first release, with strong credentials and a future HTTPS/domain hardening path.

## 2. Production Inputs

- [x] 2.1 Add an Argo CD Application manifest for `finops-workspace` pointing at `https://github.com/ctchen222/homelab.git`, revision `main`, chart path `charts/finops-workspace`, and destination namespace `finops`.
- [x] 2.2 Add staged production values so the first Argo CD sync does not enable every FinOps component at once.
- [ ] 2.3 Verify `ghcr.io/ctchen222/finops-assistant:0.1.0` is published and pullable from the VPS.
- [ ] 2.4 Verify `ghcr.io/ctchen222/finops-market-research:0.1.0` is published and pullable from the VPS.
- [x] 2.5 Create or document SOPS/owner-operated creation of the `finops` namespace and `finops-secrets` with all required keys, including `telegram-report-chat-id`.
- [x] 2.6 Add Helm wiring for `TELEGRAM_REPORT_CHAT_ID` so scheduled reports can push to Telegram.
- [x] 2.7 Add or document the Traefik BasicAuth middleware, Secret, or stricter equivalent before enabling finance UI ingress.
- [x] 2.8 Add or document Traefik static entrypoints, Service ports, and routes for ezBookkeeping on `8080` and Wealthfolio on `8081`.
- [x] 2.9 Add a public HTTPS hostname for the assistant Telegram webhook.
- [x] 2.10 Verify VPS firewall/security-group exposure for UI ports and document the no-domain owner-only HTTP risk, source-IP restriction status, and future HTTPS/domain hardening path.
- [x] 2.11 Run Helm lint and template checks for each staged production values set.
- [x] 2.12 Add a GitHub Actions workflow that publishes `linux/amd64` FinOps assistant and market-research images to GHCR.
- [ ] 2.13 Verify the GitHub Actions image workflow publishes a selected release tag and the VPS can pull both resulting images.

## 3. ezBookkeeping Stage

- [x] 3.1 Sync the FinOps Argo CD Application with ezBookkeeping only into the `finops` namespace with local-path PVCs and private access on the dedicated VPS UI port.
- [x] 3.2 Verify Argo CD sync/health plus ezBookkeeping pod, service, ingress, probes, PVC binding, and resource usage.
- [ ] 3.3 Create owner account, TWD/USD currencies, accounts, categories, import/export settings, and API token.
- [ ] 3.4 Verify expense, income, transfer, account, category, chart, and PWA workflows.
- [ ] 3.5 Verify ezBookkeeping backup and restore ownership before enabling Telegram writes.

## 4. Assistant and Finance Reports Stage

- [ ] 4.1 Enable the FinOps assistant through a GitOps commit with ezBookkeeping API token, Telegram allowlist, `TELEGRAM_REPORT_CHAT_ID`, SQLite PVC, and watchlist ConfigMap.
- [ ] 4.2 Verify `/healthz`, `/readyz`, service DNS, probes, PVC, ConfigMap, and resource usage.
- [ ] 4.3 Configure Telegram webhook with `setWebhook` using the public HTTPS assistant URL, `secret_token`, required `allowed_updates`, and `drop_pending_updates=true` for the first production cutover.
- [ ] 4.4 Verify Telegram webhook with `getWebhookInfo`, secret-token validation, allowlist rejection, idempotency, unknown-category review, and one non-production ezBookkeeping write.
- [ ] 4.5 Confirm `/telegram/webhook` is reachable by Telegram while `/internal/reports/*` remains private or cluster-only.
- [ ] 4.6 Trigger `/internal/reports/daily` once from inside k3s and verify report status, artifact behavior, and Telegram delivery.
- [ ] 4.7 Trigger `/internal/reports/end-of-day-spending` once from inside k3s and verify summary status, artifact behavior, and Telegram delivery.
- [ ] 4.8 Enable daily and end-of-day schedules only after one-off report triggers pass.

## 5. Market Research Stage

- [ ] 5.1 Enable or render the market-research CronJob through a GitOps commit with strict resource limits and production image tag.
- [ ] 5.2 Create a one-off Job from the CronJob template and verify it can read the watchlist ConfigMap and write the report output.
- [ ] 5.3 Verify successful, partial, and provider-unavailable runtime behavior without treating partial data as a total deployment failure.
- [ ] 5.4 Enable the scheduled market report only after the one-off k3s runtime check passes.
- [ ] 5.5 Capture resource usage during or immediately after the market-research job.

## 6. Wealthfolio and Homepage Stage

- [ ] 6.1 Enable Wealthfolio through a GitOps commit behind private access with SQLite PVC and authentication.
- [ ] 6.2 Verify Wealthfolio portfolio, performance, net-worth, market-data refresh, authentication, and backup/restore workflows.
- [ ] 6.3 Verify Wealthfolio can be disabled without breaking ezBookkeeping, the assistant, or report schedules.
- [ ] 6.4 Publish or verify homepage metadata for enabled FinOps components with accurate enabled, disabled, or unknown status.
- [ ] 6.5 Capture resource usage after Wealthfolio and disable it if it exceeds the accepted budget.

## 7. Production Handoff

- [ ] 7.1 Capture final pods, services, PVCs, ingresses, CronJobs, report artifacts, private-access checks, and resource snapshots.
- [x] 7.2 Verify FurFriend-Finder remains healthy after each FinOps stage and after the final rollout.
- [ ] 7.3 Document rollback commands that disable schedules, assistant, Wealthfolio, and ezBookkeeping without deleting PVCs.
- [ ] 7.4 Document backup and restore ownership for ezBookkeeping, assistant state/reports, and Wealthfolio.
- [x] 7.5 Confirm the FinOps Argo CD Application is synced and healthy independently of the existing `furfriend-finder` OutOfSync issue.
- [ ] 7.6 Mark this deployment change complete only after live VPS evidence is captured, not from repo-local tests alone.
