FROM node:20-bookworm-slim AS build

WORKDIR /app
COPY package.json tsconfig.json ./
RUN npm install
COPY src ./src
RUN npm run build

FROM node:20-bookworm-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 python3-pip sqlite3 \
  && pip3 install --break-system-packages --no-cache-dir shioaji \
  && rm -rf /var/lib/apt/lists/*
WORKDIR /app
ENV NODE_ENV=production
RUN mkdir -p /data /app/scripts && chown -R node:node /data /app/scripts
COPY --from=build /app/dist ./dist
COPY scripts ./scripts
COPY docker-entrypoint.sh ./docker-entrypoint.sh
RUN chmod +x /app/scripts/sinopac_shioaji_snapshot.py /app/docker-entrypoint.sh && chown -R node:node /app

EXPOSE 8090
ENTRYPOINT ["/app/docker-entrypoint.sh"]
