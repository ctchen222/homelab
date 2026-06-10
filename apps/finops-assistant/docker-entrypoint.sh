#!/bin/sh
set -e

mkdir -p /data/portfolio/exports /data/reports
chown -R node:node /data /app

exec su node -s /bin/sh -c "exec node dist/server.js"
