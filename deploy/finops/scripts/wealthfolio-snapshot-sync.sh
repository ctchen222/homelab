#!/usr/bin/env bash

set -euo pipefail

COMPOSE_FILE="${COMPOSE_FILE:-deploy/finops/docker-compose.yaml}"

docker compose -f "${COMPOSE_FILE}" --profile jobs run --rm wealthfolio-snapshot-sync
