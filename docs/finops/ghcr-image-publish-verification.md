# FinOps GHCR 映像發佈與取像檢核

此頁面補齊 `deploy-finops-workspace-to-vps-k3s` 的 image publish 需求：

## 1) 手動發布指定 tag

```bash
# 由 workflow 發佈 0.1.0
gh workflow run publish-finops-images.yml -f image_tag=0.1.0
```

## 2) GitHub Actions 內建驗證

workflow 會在 push 後對每個 image tag 跑一次：

```bash
docker buildx imagetools inspect ghcr.io/<owner>/<image>:<tag>
```

這是最小的「鏡像真的存在」驗證。

## 3) VPS 取像前置檢查

- 確認 `ghcr-credentials` Secret 存在
- 確認 secret 使用者為 `ctchen222`
- 確認 token 有 `read:packages` scope
- 確認 token 權限帳號對 `ctchen222` 套件有可讀取權限

```bash
kubectl --context=furfriend-vps -n finops get secret ghcr-credentials \
  -o jsonpath='{.data..dockerconfigjson}' | base64 --decode | jq .
```

如果 secret 還在但 401 重複，請重建 secret 並重啟 pod（參考 `operations-runbook.md`）後再驗證。

## 4) VPS 端 Script 檢核（推薦）

實際 deploy 前，建議先跑一次共用檢核腳本：

```bash
cd deploy/finops
bash scripts/verify-finops-images.sh 0.1.0
```

這個腳本會做 3 件事：

1. 檢查 `${image}:0.1.0` 是否在 GHCR 可見。
2. 檢查 `finops` namespace `ghcr-credentials` secret。
3. 在 k3s 建立一次性 Job，直接嘗試 pull 兩個映像。

建議保留 log（至少 `Step 3` 的 job log）當作部署證據。

```bash
KUBECTL_CONTEXT=furfriend-vps \
FINOPS_NAMESPACE=finops \
FINOPS_ASSISTANT_IMAGE=ghcr.io/ctchen222/finops-assistant \
FINOPS_MARKET_IMAGE=ghcr.io/ctchen222/finops-market-research \
bash scripts/verify-finops-images.sh 0.1.0 \
  | tee /tmp/finops-image-verify-$(date +%F-%H%M%S).log
```

## 5) VPS 上的實務驗證

同步 `assistant` 後，先看 Pod 狀態是否離開 `ImagePullBackOff`：

```bash
kubectl --context=furfriend-vps -n finops get pod -l app.kubernetes.io/component=assistant
```

若仍為 `ImagePullBackOff`，請重複檢查：

- `kubectl --context=furfriend-vps -n finops describe pod <assistant-pod>` 中是否有 `failed to fetch anonymous token`
- `FailedToRetrieveImagePullSecret`
- `ghcr` secret 是否有正確帳號（建議對應 owner `ctchen222`）
- Token 是否仍有效

> 目標：`assistant` 能成功重建後才進入下一個 FinOps stage。
