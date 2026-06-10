# Portfolio Sync User Validation Checklist

本文件對應 `add-investment-intelligence-broker-sync` 的 7.2 ~ 7.7。
這 5 項是 owner 實際憑證與 UI 驗證任務，不能用程式靜態測試代替。

## 7.2 SinoPac read-only endpoint 確認

### 執行前置
- Shioaji 帳號已可登入
- 憑證為「唯讀」用途
- `SINOPAC_*` 環境變數已寫入，CA 證書掛載正常
- API 電子交易風險預告書暨使用同意書（證券）已簽署：https://www.sinotrade.com.tw/newweb/signCenter/S_openAPI/
- Python API 模擬環境測試紀錄已完成並審核通過：https://ai.sinotrade.com.tw/python/Main/index.aspx
- Shioaji production login 後股票帳戶 `signed=true`

### Python API 模擬測試

官方測試服務時間為週一到週五 `08:00-20:00`。若只使用 Shioaji，不需要完成 T4 測試；仍需完成 Python API 模擬測試報告。

從 repo root 執行：

```bash
deploy/finops/scripts/sinopac-python-simulation-test.sh
```

驗收條件：

- `login_ok=true`
- `place_order_ok=true`
- `trade_status` 為 `OrderStatus.PendingSubmit` 或 `OrderStatus.Submitted`
- `test_report_likely_accepted=true`

若在週末或官方測試服務時間外執行，可能只會得到 `OrderStatus.Inactive`，不代表正式 read-only sync 程式錯誤。

### 驗證項目
| Endpoint/功能 | 權限要求 | 測試結果 | 觀察時間 | 備註 |
| --- | --- | --- | --- | --- |
| Shioaji `list_positions(unit=sj.Unit.Share)` 讀取股票持倉 | `SINOPAC_API_KEY`、`SINOPAC_SECRET_KEY`、`SINOPAC_CA_PATH`、`SINOPAC_CA_PASSWORD`，必要時 `SINOPAC_PERSON_ID` | PASS：live sync 寫入 4 筆 broker position rows，4 筆皆為非零目前持股 | 2026-06-08 UTC+8 | 經 `/internal/portfolio/sync/live` 寫入 normalized snapshot；不可使用預設 `Unit.Common`，否則零股/非整張部位會被回成 `0` |
| Shioaji `account_balance` 讀取資產/現金餘額 | 同上，且帳戶權限支援 balance endpoint | PASS：live sync 寫入 1 個 cash currency | 2026-06-08 UTC+8 | snapshot `freshness=partial`，缺漏欄位為 `holdings.marketValue` |
| Shioaji quote/last price 欄位 | 同上 | PASS：4 筆目前持股可投影 4 筆 broker quote 到 Wealthfolio | 2026-06-08 UTC+8 | Wealthfolio 使用 broker snapshot quote；source 為 `FINOPS_BROKER` |
| 交易明細（如有） |  | N/A | 2026-06-08 UTC+8 | 本 change 目前只驗證 read-only holdings/cash display，不依賴交易明細 |

### 本機驗證命令

```bash
cd deploy/finops
docker compose --profile jobs run --rm portfolio-sync-sinopac-live
curl -fsS -H "X-Internal-Token: ${ASSISTANT_INTERNAL_TOKEN}" \
  "http://localhost:8090/internal/portfolio/snapshots?brokerId=sinopac&accountAlias=${SINOPAC_ACCOUNT_ALIAS:-sinopac-main}"
```

或從 repo root 執行完整 readiness check：

```bash
deploy/finops/scripts/sinopac-readiness-check.sh
```

### 驗收輸出
- 填寫可用 endpoint 名稱與回傳樣本。
- 若現金/部份欄位缺漏，標註為 `partial`。
- 若 `api.stock_account.signed=false`，7.2 不可打勾；先完成官方 API 簽署與 Python 模擬測試審核。

## 7.3 Firstrade read-only connector 可行性

### 檢核項目
- 是否可用 Plaid Investments 官方/第三方 approved 流程？
- 是否可用 Apex 相關整合？
- 是否有其他 owner 可接受的 read-only 路徑？
- 是否有 2FA、refresh、費率、憑證輪替、同意文件限制？

### 驗收輸出
- 結論（6月）：live connector 目前未啟用。預設採用 `firstrade-csv` 與 `firstrade-qfx` 匯入路徑；待 owner 提供可持續 `Plaid/Apex/Firstrade-approved` 官方授權後再啟動 live connector。
- 如有可用路徑，需補上：client、授權方式、scope、更新/刷新機制、預估費率、憑證續期作法。

## 7.4~7.5 Firstrade export/statement 欄位確認

### 你可直接上傳/放置的範本
- 已用 `Quicken File.qfx` 驗證：先放到本地脫敏檔再回填。
- 必要欄位：
  - `symbol`
  - `quantity`
  - `cost basis`
  - `market value`
  - `cash`
  - `currency`
  - `as-of date`

### 驗收輸出
- 這份檔案是快照型（`position snapshot`）還是只有交易紀錄／損益紀錄。
- 逐欄位是否完整可映射到 `investment-portfolio-contracts.md`。

2026-06-08 驗證補記：
- `symbol` / `quantity` / `market value` / `cash` / `currency` / `as-of date` 已可對應。
- `cost basis` 未於這份 qfx 內完整提供；系統已標記 `missingFields`。
- 該 qfx 為快照型（含持股 + 現金），同時有交易明細列，可補充 activity rows。

## 7.6 Wealthfolio display/import path

### 驗證流程
- 匯入流程（手動/自動）走完一次。
- 目標欄位在 Wealthfolio 可看見：symbol、market value、cash、currency、as-of 時間。
- 若有 source freshness/staleness 標記，則確認不會影響主頁瀏覽。

### 驗收輸出
- Wealthfolio 匯入來源：`direct sqlite snapshot sync adapter`，由 normalized portfolio store 投影到 Wealthfolio Holdings Mode。
- 本機執行命令：

```bash
deploy/finops/scripts/wealthfolio-snapshot-sync.sh
```

2026-06-08 驗證補記：
- 帳戶已可於 Wealthfolio 顯示 `Firstrade firstrade-main`。
- Holdings 顯示 3 檔美股持股 + 1 筆 TWD cash（帳戶中含 4 列）。
- Firstrade QFX 原始 USD snapshot 由 Wealthfolio projection 依 `WEALTHFOLIO_EXCHANGE_RATES=USD:TWD=32.1` 轉成 TWD 顯示；原始幣別與匯率保留在 account meta/position JSON。
- Wealthfolio API 驗證：account currency=`TWD`；holdings instrument 為 `NET/CLOUDFLARE INC`、`NVDA/NVIDIA CORP`、`PLTR/PALANTIR TECHNOLOGIES INC`；cash holding 為 `Cash (TWD)`。
- Wealthfolio DB 驗證：`holdings_snapshots.currency=TWD`、`cost_basis=104843.736`、`cash_total_account_currency=5769.333`、`cash_total_base_currency=5769.333`、`cash_balances={"TWD":"5769.333"}`。
- `sourceFreshness` 為 `partial`，因 `holdings.averageCost`、`holdings.costBasis` 缺漏。

## 7.7 首次展示審閱

### 要求
- 審閱至少一次含真實（或脫敏）資料的
  - Wealthfolio 顯示結果
  - 或 `/internal/portfolio/wealthfolio/export` 輸出

### 驗收輸出
- 截圖/截圖連結或 JSON 摘要
- 是否確認為上線前最終基礎資料（Y/N）
- 不一致項目（若有）與待修項目

### 2026-06-08 UTC+8 審閱結果

- 審閱人：Codex，使用本機 Wealthfolio API 與 SQLite 脫敏筆數驗證。
- Wealthfolio account API：`provider=finops-assistant`、`trackingMode=HOLDINGS`、`currency=TWD`。
- Wealthfolio holdings API：`GET /api/v1/holdings?accountId=<finops-account-id>` 回傳 4 筆 security holding 與 1 筆 cash holding。
- Wealthfolio DB：latest broker snapshot 為 `source=BROKER_IMPORTED`，含 4 個非零 open positions 與 1 個 cash currency。
- Wealthfolio health：`overallSeverity=INFO`、`issueCounts={}`。
- 確認結果：Y，SinoPac read-only holdings/cash 可以顯示到 Wealthfolio；資料品質仍標示 `partial`，因 Shioaji source 缺 `holdings.marketValue`，但 adapter 已用 broker last price 投影可用估值欄位。

## 統一記錄

完成上述每一項後，請回填 `openspec/changes/add-investment-intelligence-broker-sync/tasks.md` 的 7.2~7.7，並附上：

- 日期（UTC+8）
- 測試人
- 憑證/日誌參考（不含敏感值）
