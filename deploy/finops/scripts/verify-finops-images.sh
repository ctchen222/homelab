#!/usr/bin/env bash

set -euo pipefail

IMAGE_TAG="${1:-0.1.0}"
CONTEXT="${KUBECTL_CONTEXT:-furfriend-vps}"
NAMESPACE="${FINOPS_NAMESPACE:-finops}"
SECRET_NAME="${FINOPS_IMAGE_PULL_SECRET:-ghcr-credentials}"
ASSISTANT_IMAGE="${FINOPS_ASSISTANT_IMAGE:-ghcr.io/ctchen222/finops-assistant}"
MARKET_IMAGE="${FINOPS_MARKET_IMAGE:-ghcr.io/ctchen222/finops-market-research}"
ASSISTANT_POD_TEST_IMAGE="${FINOPS_ASSISTANT_TEST_IMAGE:-$ASSISTANT_IMAGE:$IMAGE_TAG}"
MARKET_POD_TEST_IMAGE="${FINOPS_MARKET_TEST_IMAGE:-$MARKET_IMAGE:$IMAGE_TAG}"
EXPECTED_USERNAME="${FINOPS_EXPECTED_GHCR_USERNAME:-ctchen222}"
VERIFY_MANIFEST="${VERIFY_MANIFEST:-1}"
JOB_NAME_PREFIX="${FINOPS_IMAGE_TEST_JOB:-finops-ghcr-image-smoke}"
JOB_FULL_NAME="${JOB_NAME_PREFIX}-$(date +%s)"

log() {
  printf '%s %s\n' "[$(date -u +%Y-%m-%dT%H:%M:%SZ)]" "$*"
}

require_cmd() {
  if ! command -v "$1" >/dev/null 2>&1; then
    log "required command missing: $1"
    exit 1
  fi
}

require_cmd docker
require_cmd base64
require_cmd kubectl
require_cmd python3

cleanup_job() {
  kubectl --context "${CONTEXT}" delete job "${JOB_FULL_NAME}" -n "${NAMESPACE}" --ignore-not-found=true >/tmp/finops-ghcr-smoke-delete.log 2>&1 || true
}
trap 'cleanup_job; rm -f "${tmp_job:-}"' EXIT

if [[ "${VERIFY_MANIFEST}" == "1" ]]; then
  log "Step 1/3: verify GHCR image manifests exist for tag=${IMAGE_TAG}"
  docker buildx imagetools inspect "${ASSISTANT_IMAGE}:${IMAGE_TAG}" >/tmp/finops-assistant-imagetools.out
  log "assistant image OK: ${ASSISTANT_IMAGE}:${IMAGE_TAG}"
  docker buildx imagetools inspect "${MARKET_IMAGE}:${IMAGE_TAG}" >/tmp/finops-market-imagetools.out
  log "market-research image OK: ${MARKET_IMAGE}:${IMAGE_TAG}"
else
  log "Step 1/3 skipped: VERIFY_MANIFEST=${VERIFY_MANIFEST}; skip GHCR manifest check and proceed with k8s pull smoke"
fi

log "Step 2/3: verify ghcr-credentials secret in Kubernetes"
if kubectl --context "${CONTEXT}" -n "${NAMESPACE}" get secret "${SECRET_NAME}" >/tmp/finops-ghcr-secret-check.log 2>&1; then
  log "secret exists: ${NAMESPACE}/${SECRET_NAME}"

  raw=$(kubectl --context "${CONTEXT}" -n "${NAMESPACE}" get secret "${SECRET_NAME}" \
    -o jsonpath='{.data..dockerconfigjson}')
  decoded=$(printf '%s' "${raw}" | base64 --decode)
  log "secret decode preview: ${decoded:0:80}..."

  username=$(printf '%s' "${decoded}" | python3 - <<'PY'
import sys, json
config = json.load(sys.stdin)
print(config.get('auths', {}).get('ghcr.io', {}).get('username', ''))
PY
)
  if [[ -z "${username}" ]]; then
    log "warning: cannot parse ghcr.io username from secret payload"
  elif [[ "${username}" != "${EXPECTED_USERNAME}" ]]; then
    log "warning: secret username is ${username}, expected ${EXPECTED_USERNAME}"
  else
    log "secret username matches expected owner: ${EXPECTED_USERNAME}"
  fi
else
  log "warning: unable to read secret ${NAMESPACE}/${SECRET_NAME}; skipping Kubernetes-only assertions"
fi

log "Step 3/3: smoke-check image pull through Kubernetes with the same pull secret"
tmp_job=$(mktemp)
cat >"${tmp_job}" <<YAML
apiVersion: batch/v1
kind: Job
metadata:
  name: ${JOB_FULL_NAME}
  namespace: ${NAMESPACE}
  labels:
    app.kubernetes.io/name: finops-ghcr-image-smoke
spec:
  backoffLimit: 0
  ttlSecondsAfterFinished: 60
  template:
    spec:
      restartPolicy: Never
      imagePullSecrets:
        - name: ${SECRET_NAME}
      containers:
        - name: assistant-image-pull-check
          image: ${ASSISTANT_POD_TEST_IMAGE}
          command:
            - sh
            - -lc
            - "echo finops assistant image pull check passed"
        - name: market-image-pull-check
          image: ${MARKET_POD_TEST_IMAGE}
          command:
            - sh
            - -lc
            - "echo finops market-research image pull check passed"
YAML

kubectl --context "${CONTEXT}" apply --validate=false -f "${tmp_job}"
if ! kubectl --context "${CONTEXT}" wait --for=condition=complete "job/${JOB_FULL_NAME}" -n "${NAMESPACE}" --timeout=180s; then
  log "k8s image pull check job failed. show job + pod diagnostics:"
  kubectl --context "${CONTEXT}" describe job "${JOB_FULL_NAME}" -n "${NAMESPACE}"
  kubectl --context "${CONTEXT}" get pods -n "${NAMESPACE}" -l "job-name=${JOB_FULL_NAME}" -o wide
  kubectl --context "${CONTEXT}" logs -n "${NAMESPACE}" -l "job-name=${JOB_FULL_NAME}" --all-containers=true
  exit 1
fi

log "k8s image pull smoke job completed. logs:"
kubectl --context "${CONTEXT}" logs -n "${NAMESPACE}" -l "job-name=${JOB_FULL_NAME}" --all-containers=true

log "Verification complete."
