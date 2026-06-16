# FinOps Operations Runbook

This runbook defines the repo-owned operating conventions for the FinOps workspace. Owner-operated steps such as real secret creation, DNS, certificate ownership, and VPS disk checks remain outside committed source.

## Deployment Order

1. Install ezBookkeeping only.
2. Create the ezBookkeeping user, accounts, categories, currencies, import/export settings, and API token.
3. Enable the FinOps assistant with Telegram allowlist and ezBookkeeping token.
4. Enable daily finance reports.
5. Enable Wealthfolio behind the private access boundary.
6. Enable the market research CronJob.
7. Publish homepage metadata and verify health links.

## GitOps Release and Drift Policy

The FinOps workspace production state is owned by Git, not by ad hoc live patches.

Required release path:

1. Merge application changes to `main`.
2. GitHub Actions publishes immutable FinOps image tags such as `main-<sha>`.
3. GitHub Actions updates `charts/finops-workspace/values-prod.yaml` with the published image tag.
4. Argo CD reconciles `finops-workspace` from `targetRevision: main`.
5. Production deployment image matches the image tag declared in `values-prod.yaml`.

Required rollback path:

1. Revert or change the Git commit that declared the production image tag.
2. Let Argo CD reconcile the reverted desired state.
3. Verify the live deployment image and application sync status.

Do not use these as normal deployment or rollback mechanisms:

- Patching `finops-workspace.spec.source.targetRevision` to a commit SHA.
- Running `kubectl set image` against FinOps production deployments.
- Relying on mutable production tags such as `0.1.1` after immutable `main-<sha>` tags are available.

Before treating a FinOps deployment as healthy, verify that Argo CD is following `main` and the live assistant image matches the repo-owned values file:

```bash
bash deploy/finops/scripts/verify-gitops-drift.sh
```

Useful environment overrides:

- `KUBECTL_CONTEXT`: default `furfriend-vps`
- `ARGO_APPLICATION_NAME`: default `finops-workspace`
- `EXPECTED_TARGET_REVISION`: default `main`
- `FINOPS_ASSISTANT_DEPLOYMENT`: default `finops-workspace-finops-workspace-assistant`

## Namespace and Private Access

- Namespace: `finops`
- Ingress class: `traefik`
- Default exposure: private only
- Public unauthenticated access is not acceptable for:
  - ezBookkeeping UI and API
  - FinOps assistant webhook/admin/report endpoints
  - Wealthfolio UI
  - generated report artifacts
  - homepage links that reveal private finance data

Telegram webhook mode may require a publicly reachable endpoint, but it must validate the Telegram secret token and still enforce allowlisted Telegram user IDs before doing any work.

## Required Secrets

Create a Kubernetes Secret named by `global.existingSecretName` in the target namespace.

Required keys:

- `telegram-bot-token`
- `telegram-webhook-secret`, when webhook mode is enabled
- `telegram-allowed-user-ids`, comma-separated numeric Telegram user IDs
- `telegram-report-chat-id`, numeric Telegram chat ID that receives scheduled daily and end-of-day reports
- `ezbookkeeping-api-token`
- `ezbookkeeping-secret-key`
- `assistant-internal-token`
- `wealthfolio-secret-key`
- `wealthfolio-auth-password-hash`
- `portfolio-account-identity-salt`

Optional keys:

- `market-data-api-token`
- `llm-api-key`
- `private-access-token`
- `sinopac-api-key`
- `sinopac-secret-key`
- `sinopac-ca-path`
- `sinopac-ca-password`
- `sinopac-ca-pfx`
- `sinopac-person-id`
- `firstrade-plaid-client-id`
- `firstrade-plaid-secret`
- `firstrade-access-token`
- `wealthfolio-import-token`

Optional LLM report summarization also requires `assistant.llmEnabled=true` and `assistant.llmSummaryEndpoint` in Helm values. The assistant sends raw report sections and risk framing to that endpoint only after bookkeeping/watchlist/pending-review sections have been built. LLM output is stored as commentary and never mutates ezBookkeeping or Wealthfolio records.

Never commit real values. The local values file can create dev-only placeholders, but production values must point at owner-created secrets.

## Portfolio Sync and Wealthfolio Path

Current repo-owned path:

- Source of truth: normalized portfolio snapshots in the assistant-owned SQLite portfolio store.
- Private companion artifact: `/internal/portfolio/wealthfolio/export` writes a redacted-aware JSON export with account/source freshness metadata.
- Wealthfolio ingestion: `deploy/finops/scripts/wealthfolio-snapshot-sync.sh` projects the latest fresh or partial normalized broker snapshot into Wealthfolio Holdings Mode. It writes Wealthfolio `accounts`, `assets`, `quotes`, `holdings_snapshots`, and quote sync state from the normalized store.

This means Wealthfolio is the display/import target, not the durable source of portfolio state. Downstream report work must read normalized snapshots rather than scraping Wealthfolio UI.

The sync adapter intentionally filters zero-quantity position rows out of Wealthfolio's current holdings display. Broker rows with quantity `0` can remain in the normalized store for audit/source fidelity, but Wealthfolio should only show non-zero open holdings plus cash.

## Portfolio Secret Keys

The Helm chart and CronJob templates reference these keys from `global.existingSecretName` instead of storing plaintext values in repo-owned values files:

- `portfolio-account-identity-salt`
- `sinopac-api-key`
- `sinopac-secret-key`
- `sinopac-ca-path`
- `sinopac-ca-password`
- `sinopac-ca-pfx`
- `sinopac-person-id`
- `firstrade-plaid-client-id`
- `firstrade-plaid-secret`
- `firstrade-access-token`
- `wealthfolio-import-token`

Current usage expectations:

- The assistant deployment consumes `portfolio-account-identity-salt`.
- The assistant deployment consumes SinoPac Shioaji credentials for `/internal/portfolio/sync/live`.
- Disabled-by-default portfolio live sync, import, and export jobs reference broker and Wealthfolio keys as runtime inputs.
- SinoPac runtime env names are `SINOPAC_API_KEY`, `SINOPAC_SECRET_KEY`, `SINOPAC_CA_PATH`, `SINOPAC_CA_PASSWORD`, optional `SINOPAC_PERSON_ID`, and `SINOPAC_SHIOAJI_COMMAND`.
- For Kubernetes, store the `.pfx` certificate bytes in `sinopac-ca-pfx` and set `sinopac-ca-path` to `/run/secrets/sinopac/sinopac_API_credential.pfx`.
- `SINOPAC_SHIOAJI_COMMAND` defaults to `/app/scripts/sinopac_shioaji_snapshot.py`; it logs in through Shioaji, activates the CA, reads positions, attempts account balance, and returns bridge JSON to the assistant.
- The Shioaji bridge must call `api.list_positions(account, unit=sj.Unit.Share)`. The SDK default behaves like common-lot units and can return `0` for odd-lot or non-common-lot positions, which would hide valid holdings in Wealthfolio.
- Real-data jobs must remain disabled until owner validation gates are explicitly marked complete in Helm values.

## ezBookkeeping Setup

Configuration:

- Image: `mayswind/ezbookkeeping`
- Storage: SQLite on PVC
- Data path: `/ezbookkeeping/data`
- Object storage path: `/ezbookkeeping/storage`
- Timezone: `Asia/Taipei`
- Default currency: `TWD`
- API tokens: enabled through `EBK_SECURITY_ENABLE_API_TOKEN=true`

Initial bootstrap checklist:

- Create the owner account.
- Configure accounts from `config/finops/ezbookkeeping-bootstrap.json`.
- Configure categories from `config/finops/ezbookkeeping-bootstrap.json`.
- Keep `TWD` as the primary currency and add `USD`.
- Enable export/import for controlled recovery workflows.
- Generate an API token for the FinOps assistant.

Category and alias mapping workflow:

1. Prefer Telegram discovery before changing config:
   - `categories`
   - `categories expense`
   - `categories income`
   - `categories transfer`
   - `accounts`
2. To add a category from Telegram, send an explicit command such as:
   - `category add expense transport under Transportation`
   - `category add expense public transit under Transportation alias transit`
   - `category add income dividend under Finance alias dividend`
3. If a transaction uses an unknown category alias, the assistant stores the transaction for review and replies with a `category confirm <update_id> ...` command. Confirming creates the category, saves the alias in the assistant SQLite database, and retries the pending transaction once.
4. Keep bootstrap or recovery aliases in repo-owned config when useful:
   - Docker Compose: `EZBOOKKEEPING_ACCOUNT_IDS` and `EZBOOKKEEPING_CATEGORY_IDS` in `deploy/finops/.env`.
   - Helm: `assistant.ezBookkeepingAccountIds` and `assistant.ezBookkeepingCategoryIds` in the target values file.
5. Restart or roll the assistant only when changing env or Helm aliases. Telegram-created aliases are persisted in assistant SQLite state.
6. Send a non-production Telegram test command that uses the new alias and verify the created ezBookkeeping transaction points at the intended account/category.

Example mapping:

```json
{
  "food": "category-food-id",
  "medical": "category-medical-id",
  "cash": "account-cash-id"
}
```

Keep ezBookkeeping as the source of truth. Do not add a category only in the assistant; the assistant should only translate Telegram aliases into ezBookkeeping IDs.

## Assistant Operations

Assistant endpoints:

- `GET /healthz`: process health
- `GET /readyz`: process readiness
- `POST /telegram/webhook`: Telegram webhook receiver
- `POST /internal/reports/daily`: internal daily report trigger
- `POST /internal/reports/end-of-day-spending`: internal end-of-day spending summary trigger
- `GET /internal/portfolio/snapshots`: latest normalized portfolio snapshots
- `GET /internal/portfolio/aggregate`: aggregate-by-symbol portfolio view
- `POST /internal/portfolio/sync/fixture`: fixture-only broker snapshot seed
- `POST /internal/portfolio/sync/live`: real read-only live sync. Currently supports `brokerId=sinopac` through Shioaji credentials configured on the assistant.
- `POST /internal/portfolio/import/preview`: import preview before owner approval
- `POST /internal/portfolio/import/commit`: owner-approved import commit
- `POST /internal/portfolio/wealthfolio/export`: private Wealthfolio companion export
- `POST /internal/portfolio/maintenance/purge`: retention-based purge for snapshots, exports, raw imports, and backup metadata

Telegram overview commands:

- `overview today`: today's period overview.
- `overview 7d`: last 7 days overview.
- `overview month`: current local month overview, based on the configured timezone.

Overview replies include income total, expense total, transaction counts, income and expense category percentages, account movement, text bars, and pending review count. The assistant currently renders chart-like text bars directly in the Telegram message so the webhook response path works without publishing private finance charts or requiring outbound Telegram file upload. Telegram can send image charts with `sendPhoto`, but production should only enable that after deciding where charts are rendered, how private chart artifacts are protected, and whether the assistant can reliably reach the Telegram Bot API.

Security behavior:

- Reject requests without a matching `X-Telegram-Bot-Api-Secret-Token` when webhook secret is configured.
- Reject Telegram users not in the allowlist.
- Store processed Telegram update IDs before returning final success to prevent duplicate processing.
- Store ambiguous or failed writes as pending review items instead of silently dropping finance data.
- Redact tokens and avoid logging finance payloads.
- Redact broker account hashes, holdings payloads, cash balances, raw import rows, import file paths, and export artifacts in logs.

Telegram webhook registration and verification (Guided Flow ready gate):

- Register webhook with callback support:

  ```bash
  curl -fsS -X POST "https://api.telegram.org/bot${BOT_TOKEN}/setWebhook" \
    --data-urlencode "url=${WEBHOOK_URL}" \
    --data-urlencode "secret_token=${TELEGRAM_WEBHOOK_SECRET}" \
    --data-urlencode 'allowed_updates=["message","edited_message","callback_query"]' \
    -d "drop_pending_updates=true"
  ```

- Verify callback support before treating guided flow as production-ready:

  ```bash
  BOT_TOKEN=... deploy/finops/scripts/verify-telegram-webhook.sh
  ```

- If `callback_query` is missing from `allowed_updates`, guided buttons will be ignored by Telegram handlers.

### Guided bookkeeping runtime flow (Phase 2)

- Input entry points: quick sentence like `lunch 120`, explicit `income salary 50000`, `/cancel`, `/status`, and full legacy commands.
- Expense defaulting:
  - Quick sentence without explicit type is created as an `expense` draft.
  - Parsed date defaults to local date with `今天`, `昨天`, `前天`, and `YYYY-MM-DD`/`MM/DD` overrides.
  - Missing amount still remains legacy queue path.
- Draft state progression:
  1. `type`（按鈕或文字）
  2. `amount`
  3. `date`
  4. `category`（支出/收入）或 `from_account`/`to_account`（轉帳）
  5. `account`
  6. `note`
  7. `confirm`
- Button contract:
  - Every draft step renders only relevant buttons.
  - Callback data format is compact and internal-state-driven (`draftId + action + optional value`).
  - Callback path must acknowledge with `answerCallbackQuery`.
- Category/account selection:
  - Buttons are built from ezBookkeeping IDs.
  - New category flow is explicit only:
    `new_category` -> input name -> parent -> confirm.
  - Unknown text in draft steps does not auto-create categories.
- Confirmation/cancel:
  - Write on explicit `confirm` only.
  - Duplicate confirm is idempotent and reports already handled.
  - `/cancel` or cancel button cancels active draft.
- Smoke test checklist:
  1. 記錄測試前交易筆數。
  2. 發送一筆可回溯的非正式 quick sentence。
  3. 完成到 confirm 並確認可見。
  4. 刪除/回滾測試交易。
  5. 驗證交易筆數回到前測試值。

建議驗證指令：

```bash
# 1) 先確認 guided flow 前置條件
EBK_API_BASE_URL=https://<ebk-host> EBK_API_TOKEN=<token> BOT_TOKEN=<telegram-bot-token> \
deploy/finops/scripts/verify-guided-bookkeeping-ready.sh

# 2) VPS guided flow smoke（可支援自動與人工回退）
ASSISTANT_WEBHOOK_URL=https://<assistant-host>/telegram/webhook \
ASSISTANT_WEBHOOK_SECRET=<telegram-webhook-secret> \
EBK_API_BASE_URL=https://<ebk-host> EBK_API_TOKEN=<token> \
GUIDED_SMOKE_USER_ID=<allowlist-user-id> GUIDED_SMOKE_CHAT_ID=<chat-id> \
deploy/finops/scripts/verify-guided-bookkeeping-smoke.sh

# 3) 若無法自動刪除，改用手動清理後再回歸檢查
# 4) 生產日誌機密外洩掃描
deploy/finops/scripts/verify-guided-bookkeeping-no-leaks.sh
```

### Phase 3 mini app handoff boundary

- Mini app 只能接管「顯示/輸入」層，不得建立第二條 ezBookkeeping 寫入管道。
- 所有 mini app 的流程必須回到既有 `BookkeepingDraft` 狀態機：
  - 用同樣 `draft_id`、`draft.step`、`draft.status` 產生畫面。
  - 按鈕動作仍走現有 callback action（`set_type`、`set_category`、`confirm` 等）。
  - 確認送出時只呼叫 assistant 既有 `Draft -> ezBookkeeping` 寫入路徑。
- 確保 mini app 只能新增輸入方式，不影響既有 Telegram 指令與文字解析行為。

## Portfolio Operations

Enablement order for portfolio sync:

1. Keep `portfolioSync.enabled=false` or `portfolioSync.mode=fixture` until Wealthfolio baseline and gate validation are complete.
2. Run local fixture sync and inspect `/internal/portfolio/snapshots` plus `/internal/portfolio/aggregate`.
3. Run a one-shot SinoPac live sync only after `SINOPAC_*` credentials and the `.pfx` mount are present.
4. Review `/internal/portfolio/snapshots?brokerId=sinopac&accountAlias=sinopac-main` and `/internal/portfolio/wealthfolio/export` output before enabling schedules.
5. Review the direct Wealthfolio projection:

   ```bash
   deploy/finops/scripts/wealthfolio-snapshot-sync.sh
   curl -fsS http://localhost:8088/api/v1/accounts
   curl -fsS "http://localhost:8088/api/v1/holdings?accountId=<finops-account-id>"
   curl -fsS http://localhost:8088/api/v1/health/status
   ```

6. Review redacted import preview output before any Firstrade import commit job or manual commit.
7. Keep `portfolioSync.jobs.sinoPacLiveSync.enabled=false`, `portfolioSync.jobs.importCommit.enabled=false`, and `portfolioSync.jobs.wealthfolioExport.enabled=false` until fixture validation, dry-run validation, redacted preview approval, owner approval, and scheduled enablement approval are all true.
8. Enable one job at a time and observe CronJob status plus assistant health before widening schedules.

Firstrade QFX/OFX import validation (fallback path):

```bash
cp "/Users/ctchen/Development/project/homelab/Quicken File.qfx" /tmp/imports/firstrade.qfx
curl -fsS -X POST http://localhost:8090/internal/portfolio/import/preview \
  -H "Content-Type: application/json" \
  -H "X-Internal-Token: ${ASSISTANT_INTERNAL_TOKEN}" \
  -d '{"brokerId":"firstrade","accountAlias":"firstrade-main","sourceType":"statement-import","filePath":"/tmp/imports/firstrade.qfx","requestedAt":"2026-06-08T08:00:00.000Z"}'
curl -fsS -X POST http://localhost:8090/internal/portfolio/import/commit \
  -H "Content-Type: application/json" \
  -H "X-Internal-Token: ${ASSISTANT_INTERNAL_TOKEN}" \
  -d '{"brokerId":"firstrade","accountAlias":"firstrade-main","sourceType":"statement-import","filePath":"/tmp/imports/firstrade.qfx","requestedAt":"2026-06-08T08:00:00.000Z","ownerApproved":true,"retainRawImport":true}'
WEALTHFOLIO_SYNC_BROKER_ID=firstrade WEALTHFOLIO_SYNC_ACCOUNT_ALIAS=firstrade-main deploy/finops/scripts/wealthfolio-snapshot-sync.sh
```

Default SinoPac schedule after enablement:

- SinoPac live sync runs every 30 minutes during Taiwan market hours on weekdays: `10,40 9-13 * * 1-5` in `Asia/Taipei`.
- Wealthfolio snapshot sync runs 5 minutes after each SinoPac live sync: `15,45 9-13 * * 1-5` in `Asia/Taipei`.
- Docker Compose does not run this schedule automatically. Local refresh still requires running `portfolio-sync-sinopac-live` and `deploy/finops/scripts/wealthfolio-snapshot-sync.sh` manually.
- Keep `concurrencyPolicy=Forbid`; do not shorten the interval until Shioaji runtime, rate-limit behavior, and broker-side permission stability have been observed for several market sessions.

Disablement order without deleting data:

1. Set `portfolioSync.jobs.wealthfolioExport.enabled=false`.
2. Set `portfolioSync.jobs.importCommit.enabled=false`.
3. Set `portfolioSync.jobs.sinoPacLiveSync.enabled=false`.
4. Set `portfolioSync.jobs.fixtureSync.enabled=false`.
5. Set `portfolioSync.enabled=false` only after confirming no job should run.
6. Keep the portfolio PVC and SQLite file unless the owner explicitly requests purge.

Restore and purge workflow:

1. Stop the assistant or disable portfolio jobs before copying portfolio SQLite backups.
2. Restore `/data/portfolio/portfolio.sqlite` and, if needed, the export artifact directory under `/data/portfolio/exports`.
3. Start the assistant and verify `/healthz`, `/internal/portfolio/snapshots`, and one export run.
4. Use `POST /internal/portfolio/maintenance/purge` for retention-driven cleanup.
5. Purge raw imports and export artifacts before deleting normalized snapshots.

Broker-specific checks before production enablement:

- SinoPac: confirm which Shioaji read-only endpoints are available after owner login.
- Firstrade: current repo path is CSV/export import only. Do not enable a Firstrade live connector until Plaid/Apex/Firstrade-approved evidence confirms consent, pricing, refresh, field coverage, and read-only terms.
- Wealthfolio: review the first display/export with real or sanitized data before enabling scheduled export.

See also: [Portfolio Sync User Validation Checklist](/Users/ctchen/Development/project/homelab/docs/finops/portfolio-sync-user-validation.md) for 7.2~7.7 evidence collection.

## Backups and Restore

Back up these paths:

- ezBookkeeping: `/ezbookkeeping/data` and `/ezbookkeeping/storage`
- Assistant: `/data/assistant.sqlite` and `/data/reports`
- Wealthfolio: `/data/wealthfolio.db`
- Kubernetes Secret metadata: export names and required keys, not secret values, into the runbook

Minimum restore drill:

1. Stop or scale down the component that owns the SQLite file.
2. Copy the backup into the target PVC.
3. Start the component.
4. Verify health endpoint and one read-only UI/report workflow.
5. For ezBookkeeping, verify export and transaction list access.
6. For Wealthfolio, verify portfolio and net-worth pages.
7. For assistant, verify idempotency table and pending review count.

## Rollback

Disable in this order when resources or security gates fail:

1. Market research CronJob.
2. Daily report CronJob.
3. FinOps assistant.
4. Wealthfolio.
5. ezBookkeeping only if the full namespace must be disabled.

Rollback must not delete PVCs by default. Preserve finance data unless the owner explicitly requests data deletion.

Suggested Helm rollback controls:

- `marketResearch.enabled=false`
- `dailyReport.enabled=false`
- `endOfDaySpendingReport.enabled=false`
- `assistant.enabled=false`
- `wealthfolio.enabled=false`
- `ezbookkeeping.enabled=false`

## Health and Homepage Metadata

Health probes:

- ezBookkeeping: HTTP service root or configured health path.
- Assistant: `/healthz` and `/readyz`.
- Wealthfolio: HTTP service root.
- Market research: last successful report artifact and CronJob status.

Homepage metadata lives in `config/homelab-homepage/finops-services.yaml` and is also rendered into the Helm `finops-homepage-metadata` ConfigMap.

Disabled components must appear as `disabled` or `unknown`; they must not block access to enabled bookkeeping services.

## VPS Production Secrets Setup

Create all secrets in the `finops` namespace before the first Argo CD sync. The namespace is created automatically by Argo CD (`CreateNamespace=true`), but secrets must exist before the sync so pods start without `ErrImagePull` or `CreateContainerConfigError`.

`finops-secrets` — all application credentials:

```bash
kubectl create secret generic finops-secrets \
  --from-literal=telegram-bot-token='<VALUE>' \
  --from-literal=telegram-webhook-secret='<VALUE>' \
  --from-literal=telegram-allowed-user-ids='<COMMA_SEPARATED_USER_IDS>' \
  --from-literal=telegram-report-chat-id='<NUMERIC_CHAT_ID>' \
  --from-literal=ezbookkeeping-api-token='<VALUE>' \
  --from-literal=ezbookkeeping-secret-key='<VALUE>' \
  --from-literal=assistant-internal-token='<VALUE>' \
  --from-literal=wealthfolio-secret-key='<VALUE>' \
  --from-literal=wealthfolio-auth-password-hash='<VALUE>' \
  -n finops
```

`finops-basic-auth` — Traefik BasicAuth for UI entrypoints (generate with `htpasswd -nb <user> <password>`):

```bash
kubectl create secret generic finops-basic-auth \
  --from-literal=users='<HTPASSWD_GENERATED_STRING>' \
  -n finops
```

`ghcr-credentials` — GHCR image pull secret for custom images:

```bash
kubectl create secret docker-registry ghcr-credentials \
  --docker-server=ghcr.io \
  --docker-username=ctchen222 \
  --docker-password=<GHCR_PAT_WITH_READ_PACKAGES> \
  -n finops
```

`<GHCR_PAT_WITH_READ_PACKAGES>` 至少需有 `read:packages` 權限；若 PAT 會變更或重新產生，需刪除重建該 secret 並重啟 FinOps Pod。

> 目前 `ImagePullBackOff` + `403 Forbidden` 大多半代表此 token 沒有 `read:packages`；確認方式（不會回傳 secret）：
>
> ```bash
> gh api /users/ctchen222/packages/container/finops-assistant/versions --jq '. | length'
> ```
>
> 若回 403，請用具有 `read:packages` 的 PAT 重建 `ghcr-credentials`，並確認該 PAT 在目標套件上有可讀權限。

```bash
kubectl delete secret ghcr-credentials -n finops
kubectl create secret docker-registry ghcr-credentials \
  --docker-server=ghcr.io \
  --docker-username=ctchen222 \
  --docker-password=<NEW_GHCR_PAT_WITH_READ_PACKAGES> \
  -n finops
kubectl -n finops delete pod -l app.kubernetes.io/instance=finops-workspace
```

Do not commit real values. VPS firewall: open ports 8080 and 8081 before syncing Stage 1.

```bash
ufw allow 8080/tcp && ufw allow 8081/tcp
# Or restrict to owner IP: ufw allow from <OWNER_IP> to any port 8080
```

## Local Testing

The local workflow has three levels:

1. Docker Compose for quick functional checks.
2. k3d for local k3s parity.
3. VPS k3s for production deployment.

Docker Compose:

```bash
docker compose -f deploy/finops/docker-compose.yaml up --build
```

Local URLs:

- ezBookkeeping: `http://localhost:8080`
- Wealthfolio: `http://localhost:8088`
- FinOps assistant health: `http://localhost:8090/healthz`

Useful local checks:

```bash
npm --prefix apps/finops-assistant test
ASSISTANT_INTERNAL_TOKEN=... deploy/finops/scripts/portfolio-fixture-sync.sh
ASSISTANT_INTERNAL_TOKEN=... deploy/finops/scripts/wealthfolio-export.sh
docker compose -f deploy/finops/docker-compose.yaml --profile jobs run --rm portfolio-sync-fixture
docker compose -f deploy/finops/docker-compose.yaml --profile jobs run --rm wealthfolio-export
curl -fsS -X POST \
  -H "X-Internal-Token: ${ASSISTANT_INTERNAL_TOKEN}" \
  http://localhost:8090/internal/reports/end-of-day-spending
python3 -m unittest discover -s jobs/market-research -p '*test*.py'
python3 jobs/market-research/market_research.py \
  --watchlist config/finops/watchlist.json \
  --output /tmp/finops-market-report.json \
  --offline-fixture jobs/market-research/fixtures/sample-prices.json
```

Helm render:

```bash
helm lint charts/finops-workspace
helm template finops charts/finops-workspace \
  --namespace finops \
  -f charts/finops-workspace/values-local.yaml
```

Portfolio-specific Helm evidence:

```bash
helm template finops charts/finops-workspace \
  --namespace finops \
  --set portfolioSync.enabled=true \
  --set portfolioSync.jobs.fixtureSync.enabled=true \
  -f charts/finops-workspace/values-local.yaml
```

k3d parity check:

```bash
docker build -t finops-assistant:local apps/finops-assistant
docker build -t finops-market-research:local jobs/market-research
k3d cluster create finops-local --servers 1 --agents 0
k3d image import finops-assistant:local finops-market-research:local -c finops-local
helm upgrade --install finops charts/finops-workspace \
  --namespace finops \
  --create-namespace \
  -f charts/finops-workspace/values-local.yaml
kubectl get namespace,pods,svc,pvc,ingress,cronjobs -n finops
k3d cluster delete finops-local
```

Portfolio k3d checks before VPS enablement:

```bash
kubectl get pods,pvc,configmaps,cronjobs -n finops
kubectl describe cronjob finops-finops-workspace-portfolio-fixture-sync -n finops
kubectl logs job/<latest-portfolio-job> -n finops
```

VPS deployment:

```bash
helm upgrade --install finops charts/finops-workspace \
  --namespace finops \
  --create-namespace \
  -f charts/finops-workspace/values-prod.yaml
```

每個 Stage 啟用前先做 image pull smoke 驗證：

```bash
cd deploy/finops
KUBECTL_CONTEXT=furfriend-vps \
FINOPS_NAMESPACE=finops \
bash scripts/verify-finops-images.sh 0.1.0
```

若驗證失敗，先修正 GHCR 映像、secret 或 ingress 相關設定，
再回到下一階段。

Do not enable all components at once on the VPS. Capture resource usage after each step.

## UI Verification

Some OpenSpec tasks require real upstream UI evidence and owner-created credentials. Do not mark them complete from repo scaffolding alone.

For the remaining portfolio-user validation gates in section 7, write evidence in:

- [Portfolio Sync User Validation Checklist](/Users/ctchen/Development/project/homelab/docs/finops/portfolio-sync-user-validation.md)

ezBookkeeping UI/PWA checks:

- Create expense, income, transfer, account, and category records.
- Review spending, income, account, category, trend, and custom chart views.
- Open or install the PWA flow on the target device.
- Export finance data.
- Import a small test file in a non-production environment.

Wealthfolio checks:

- Create or import portfolio.
- Review holdings, performance, net-worth, and market-data refresh behavior.
- Verify authentication.
- Back up and restore the SQLite database in a test environment.

## Resource Verification

After enabling each component:

```bash
kubectl top nodes
kubectl top pods -n finops
kubectl get pods,pvc,ingress,cronjobs -n finops
```

Compare the result against the budget in `docs/finops/stack-and-baseline.md`. Disable the newest component if it exceeds the budget or destabilizes FurFriend-Finder.

Local Docker Compose snapshot on 2026-06-04:

| Component | Container | CPU | Memory | Result |
| --- | --- | ---: | ---: | --- |
| ezBookkeeping | `finops-ezbookkeeping-1` | `0.00%` | `10.95MiB` | Under `256Mi` budget |
| FinOps assistant | `finops-finops-assistant-1` | `0.00%` | `30.73MiB` | Under `128Mi` budget |
| Wealthfolio | `finops-wealthfolio-1` | `0.00%` | `3.082MiB` | Under `512Mi` budget |

No component required disabling in the local Docker Compose check. This is a local functional resource snapshot; repeat the `kubectl top` checks on k3s before treating the VPS resource gate as production evidence.