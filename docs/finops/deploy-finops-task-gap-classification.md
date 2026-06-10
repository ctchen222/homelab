# deploy-finops 任務缺口分類與優先順序（2026-06-10）

此文件用於持續對齊 `openspec/changes/deploy-finops-workspace-to-vps-k3s/tasks.md` 的未完成項目。
目標：先處理可阻塞後續驗證的項目，避免階段跳躍。

## 分類結果

- 已完成：23 項
- 未完成：28 項
- 未完成項目總清單：`2.3 / 2.4 / 2.13 / 3.3 / 3.4 / 3.5 / 4.1~4.8 / 5.1~5.5 / 6.1~6.5 / 7.1 / 7.3 / 7.4 / 7.6`

## 優先順序

### P0：阻塞階段（先解這裡，才能繼續）

- `2.3` `2.4` `2.13`（VPS image 可拉取驗證）
  - 問題：`ImagePullBackOff` 且出現 `403 Forbidden`
  - 證據：`docs/finops/vps-image-pull-blocker-log-2026-06-10.md`
  - 根因假設：`ghcr-credentials` token 權限不足，缺少 GHCR read:packages

### P1：基礎上線能力

- `3.3` `3.4` `3.5`（ezBookkeeping：owner 帳務初始化、核心流程驗證、備份/還原權責）
- `4.1` `4.2`（FinOps assistant 透過 GitOps 啟用 + 健康檢查）

### P2：金融報表與 webhook

- `4.3` `4.4` `4.5` `4.6` `4.7` `4.8`（telegram webhook 設定/驗證、內部報表 one-off 觸發與排程啟用條件）

### P3：市場研究與資源行為

- `5.1` `5.2` `5.3` `5.4` `5.5`（CronJob 啟用、one-off 運行、partial provider 行為、資源觀測）

### P4：投資報酬面板與收斂

- `6.1` `6.2` `6.3` `6.4` `6.5`（Wealthfolio 啟用與回退）
- `7.1` `7.3` `7.4` `7.6`（最終現場證據、回滾指令、備份還原權責、完工門檻）

## 下一步建議執行順序（每步驟結束都建議在 PR 內留 evidence）

1. 先修正 GHCR 權限與 `finops` secret，讓 `2.3`、`2.4`、`2.13` 可驗證通過。
2. 完成 `3.3`/`3.4`/`3.5`（owner 資料與 backup 邏輯）後，啟用 `4.1`~`4.2` 並完成 webhook 全量驗證。
3. 按 `5.x` 與 `6.x` 順序完成附帶資源門檻觀測與回退驗證。
4. 收斂 `7.x` 文件與 live 證據後，進行最終完成判定。
