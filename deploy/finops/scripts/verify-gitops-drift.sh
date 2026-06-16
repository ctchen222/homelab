#!/usr/bin/env bash

set -euo pipefail

CONTEXT="${KUBECTL_CONTEXT:-furfriend-vps}"
ARGO_NAMESPACE="${ARGO_NAMESPACE:-argocd}"
FINOPS_NAMESPACE="${FINOPS_NAMESPACE:-finops}"
APPLICATION_NAME="${ARGO_APPLICATION_NAME:-finops-workspace}"
ASSISTANT_DEPLOYMENT="${FINOPS_ASSISTANT_DEPLOYMENT:-finops-workspace-finops-workspace-assistant}"
EXPECTED_TARGET_REVISION="${EXPECTED_TARGET_REVISION:-main}"

log() {
  printf '%s %s\n' "[$(date -u +%Y-%m-%dT%H:%M:%SZ)]" "$*"
}

fail() {
  log "ERROR: $*"
  exit 1
}

require_cmd() {
  if ! command -v "$1" >/dev/null 2>&1; then
    fail "required command missing: $1"
  fi
}

require_cmd awk
require_cmd git
require_cmd kubectl

REPO_ROOT="$(git rev-parse --show-toplevel)"
VALUES_FILE="${REPO_ROOT}/charts/finops-workspace/values-prod.yaml"

read_assistant_image_field() {
  local field="$1"
  awk -v field="${field}" '
    /^[^[:space:]].*:$/ {
      in_assistant = ($1 == "assistant:")
      in_image = 0
      next
    }
    in_assistant && $1 == "image:" {
      in_image = 1
      next
    }
    in_assistant && in_image && $1 == field ":" {
      value = $2
      gsub(/^"/, "", value)
      gsub(/"$/, "", value)
      print value
      exit
    }
  ' "${VALUES_FILE}"
}

EXPECTED_REPOSITORY="$(read_assistant_image_field repository)"
EXPECTED_TAG="$(read_assistant_image_field tag)"

if [[ -z "${EXPECTED_REPOSITORY}" || -z "${EXPECTED_TAG}" ]]; then
  fail "unable to read assistant.image.repository/tag from ${VALUES_FILE}"
fi

EXPECTED_IMAGE="${EXPECTED_REPOSITORY}:${EXPECTED_TAG}"

log "Checking Argo CD application ${ARGO_NAMESPACE}/${APPLICATION_NAME}"
TARGET_REVISION="$(kubectl --context "${CONTEXT}" -n "${ARGO_NAMESPACE}" get application "${APPLICATION_NAME}" -o jsonpath='{.spec.source.targetRevision}')"
SYNC_REVISION="$(kubectl --context "${CONTEXT}" -n "${ARGO_NAMESPACE}" get application "${APPLICATION_NAME}" -o jsonpath='{.status.sync.revision}')"
SYNC_STATUS="$(kubectl --context "${CONTEXT}" -n "${ARGO_NAMESPACE}" get application "${APPLICATION_NAME}" -o jsonpath='{.status.sync.status}')"
HEALTH_STATUS="$(kubectl --context "${CONTEXT}" -n "${ARGO_NAMESPACE}" get application "${APPLICATION_NAME}" -o jsonpath='{.status.health.status}')"

log "targetRevision=${TARGET_REVISION}"
log "syncRevision=${SYNC_REVISION}"
log "syncStatus=${SYNC_STATUS}"
log "healthStatus=${HEALTH_STATUS}"

if [[ "${TARGET_REVISION}" != "${EXPECTED_TARGET_REVISION}" ]]; then
  fail "${APPLICATION_NAME} targetRevision drifted: expected ${EXPECTED_TARGET_REVISION}, got ${TARGET_REVISION}"
fi

if [[ "${SYNC_STATUS}" != "Synced" ]]; then
  fail "${APPLICATION_NAME} is not synced: ${SYNC_STATUS}"
fi

if [[ "${HEALTH_STATUS}" != "Healthy" ]]; then
  fail "${APPLICATION_NAME} is not healthy: ${HEALTH_STATUS}"
fi

log "Checking assistant deployment image"
ACTUAL_IMAGE="$(kubectl --context "${CONTEXT}" -n "${FINOPS_NAMESPACE}" get deploy "${ASSISTANT_DEPLOYMENT}" -o jsonpath='{.spec.template.spec.containers[0].image}')"

log "expectedImage=${EXPECTED_IMAGE}"
log "actualImage=${ACTUAL_IMAGE}"

if [[ "${ACTUAL_IMAGE}" != "${EXPECTED_IMAGE}" ]]; then
  fail "assistant image drifted: expected ${EXPECTED_IMAGE}, got ${ACTUAL_IMAGE}"
fi

log "GitOps drift verification OK."