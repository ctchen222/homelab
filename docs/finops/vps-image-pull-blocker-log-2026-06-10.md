# VPS image pull blocker log (2026-06-10)

- `verify-finops-images.sh`（`VERIFY_MANIFEST=0`）在 `furfriend-vps` 上建立 `finops-ghcr-image-smoke-1781103265`，兩個容器都進入 `ErrImagePull`。
- 兩個 image 均回報：
  - `failed to pull and unpack image ".../manifests/0.1.0": unexpected status from HEAD request ...: 403 Forbidden`
  - `ErrImagePull` / `ImagePullBackOff`
- 觸發步驟：
  - `/Users/ctchen/Development/project/homelab/deploy/finops/scripts/verify-finops-images.sh`
  - `kubectl --context furfriend-vps -n finops get pod -l job-name=finops-ghcr-image-smoke-1781103265-4xd5v -o wide`
  - `kubectl --context furfriend-vps -n finops describe pod finops-ghcr-image-smoke-1781103265-4xd5v`
- 已確認 `ghcr-credentials` secret 內 username 是 `ctchen222`，但 `gh api` 查 package versions 會回 403，顯示目前 CLI token 未含 `read:packages`：
  - `gh api /users/ctchen222/packages/container/finops-assistant/versions --jq '. | length'`
  - 回應：`You need at least read:packages scope to get a package's versions.`
- 依 spec 判斷：
  - 2.3：暫時未達成（assistant image 可見性被阻擋）
  - 2.4：暫時未達成（market image 可見性被阻擋）
  - 2.13：未達成（VPS 仍無法拉取兩個 image）
- 下一步可執行：
  - 補一顆具 `read:packages` 的 GH PAT，重建 `ghcr-credentials`，重啟 `finops-workspace` Pod；重新執行 `verify-finops-images.sh`。
