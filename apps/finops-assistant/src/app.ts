import { createHash, timingSafeEqual } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { generateDailyReport, generateEndOfDaySpendingReport } from "./report";
import { handleTelegramUpdate } from "./telegram";
import {
  BrokerImportRequest,
  BrokerConnector,
  BrokerSyncRequest,
  PortfolioSourceType,
  isPortfolioSourceType,
  SnapshotEnvelope,
  SyncEvent,
  SyncStatus
} from "./portfolioSync";
import { createFixtureBrokerConnector } from "./portfolioSyncFixtures";
import { createFirstradeCsvImporter } from "./firstradeCsv";
import { createFirstradeQfxImporter } from "./firstradeQfx";
import { createManualCsvImporter } from "./manualCsv";
import { createSinoPacCsvImporter } from "./sinopacCsv";
import { createSinoPacShioajiLiveConnector } from "./sinopacShioaji";
import { createSinoPacShioajiBridgeProvider } from "./sinopacShioajiBridge";
import { resolveImportChecksum } from "./importHelpers";
import { AppConfig, PendingReviewItem } from "./types";
import { PortfolioStore, redactPortfolioLogPayload } from "./portfolioStore";

export interface AssistantRouteStore {
  isProcessed(updateId: number): boolean;
  markProcessed(updateId: number, outcome: string): void;
  addPendingReview(item: PendingReviewItem): void;
  pendingReviewCount(): number;
  recordReport(reportType: string, status: string, summary: string, artifactPath?: string): void;
}

interface HeaderMap {
  [name: string]: string | string[] | undefined;
}

export interface HttpRequestLike {
  method?: string;
  url?: string;
  headers: HeaderMap;
  [Symbol.asyncIterator](): AsyncIterableIterator<any>;
}

export interface HttpResponseLike {
  writeHead(statusCode: number, headers: Record<string, string>): void;
  end(payload: string): void;
}

export interface RouteDependencies {
  handleTelegramUpdate?: typeof handleTelegramUpdate;
  generateDailyReport?: typeof generateDailyReport;
  generateEndOfDaySpendingReport?: typeof generateEndOfDaySpendingReport;
  portfolioStore?: PortfolioStore;
  sinoPacLiveConnector?: BrokerConnector;
}

interface InternalRequestBody {
  [key: string]: unknown;
}

interface TelegramWebhookReply {
  method: "sendMessage";
  chat_id: number | string;
  text: string;
  disable_web_page_preview: boolean;
}

function json(response: HttpResponseLike, statusCode: number, payload: unknown): void {
  response.writeHead(statusCode, { "Content-Type": "application/json" });
  response.end(JSON.stringify(payload));
}

async function readJson(request: HttpRequestLike): Promise<unknown> {
  const chunks: any[] = [];
  for await (const chunk of request) {
    chunks.push(chunk);
  }

  const text = Buffer.concat(chunks).toString("utf8");
  return text ? JSON.parse(text) : {};
}

function headerValue(value: string | string[] | undefined): string {
  if (Array.isArray(value)) return value[0] || "";
  return value || "";
}

export function safeEqual(a: string | undefined, b: string | undefined): boolean {
  if (!a || !b || a.length !== b.length) return false;
  return timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

function fetchInputUrl(input: Parameters<typeof fetch>[0]): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.toString();
  return input.url;
}

function telegramWebhookReplyFromBody(body: BodyInit | null | undefined): TelegramWebhookReply | undefined {
  if (typeof body !== "string") return undefined;

  try {
    const payload = JSON.parse(body) as {
      chat_id?: unknown;
      text?: unknown;
      disable_web_page_preview?: unknown;
    };

    if ((typeof payload.chat_id !== "number" && typeof payload.chat_id !== "string") || typeof payload.text !== "string") {
      return undefined;
    }

    return {
      method: "sendMessage",
      chat_id: payload.chat_id,
      text: payload.text,
      disable_web_page_preview: payload.disable_web_page_preview !== false,
    };
  } catch {
    return undefined;
  }
}

function asInternalRequest(body: unknown): InternalRequestBody {
  if (!body || typeof body !== "object") return {};
  return body as InternalRequestBody;
}

function requiredText(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function clampDays(value: unknown): number | undefined {
  if (typeof value !== "number" && typeof value !== "string") return undefined;
  const parsed = Number.parseInt(String(value), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

function ensureInternalToken(request: HttpRequestLike, config: AppConfig): boolean {
  const token = headerValue(request.headers["x-internal-token"]);
  return safeEqual(token, config.assistantInternalToken);
}

function chooseImporter(importers: PortfolioImporterSet, brokerId: string, request?: Pick<BrokerImportRequest, "filePath" | "sourceType">) {
  if (brokerId === "sinopac") return importers.sinoPacCsv;
  if (
    brokerId === "firstrade" &&
    request?.sourceType === "statement-import" &&
    (request.filePath.toLowerCase().endsWith(".qfx") || request.filePath.toLowerCase().endsWith(".ofx"))
  ) {
    return importers.firstradeQfx;
  }
  if (brokerId === "firstrade") return importers.firstradeCsv;
  if (brokerId === "manual") return importers.manualCsv;
  return importers.manualCsv;
}

function normalizeImportMode(
  brokerId: string,
  request: ReturnType<typeof toImportRequest>
): BrokerImportRequest {
  if (brokerId === "manual") {
    return {
      ...request,
      mode: "manual-import"
    };
  }

  return {
    ...request,
    mode: "csv-import"
  };
}

interface PortfolioImporterSet {
  sinoPacCsv: ReturnType<typeof createSinoPacCsvImporter>;
  firstradeCsv: ReturnType<typeof createFirstradeCsvImporter>;
  firstradeQfx: ReturnType<typeof createFirstradeQfxImporter>;
  manualCsv: ReturnType<typeof createManualCsvImporter>;
}

function aggregateFreshness(values: string[]): "fresh" | "partial" | "stale" | "failed" | "unavailable" {
  if (values.includes("failed")) return "failed";
  if (values.includes("unavailable")) return "unavailable";
  if (values.includes("stale")) return "stale";
  if (values.includes("partial")) return "partial";
  return "fresh";
}

function buildSyncEvent(snapshot: SnapshotEnvelope): SyncEvent {
  return {
    syncRunId: snapshot.syncRunId,
    brokerId: snapshot.brokerId,
    accountAlias: snapshot.account.accountAlias,
    adapterId: snapshot.sourceFreshness.sourceName,
    mode: snapshot.sourceType === "live-api" ? "live-read" : "csv-import",
    startedAt: snapshot.sourceFreshness.fetchedAt,
    finishedAt: snapshot.sourceFreshness.fetchedAt,
    status: snapshot.sourceFreshness.status as SyncStatus,
    errorClass: snapshot.errors[0]?.errorClass,
    rowCounts: {
      accounts: 1,
      holdings: snapshot.holdings.length,
      cashBalances: snapshot.cashBalances.length,
      activityRows: snapshot.activityRows.length,
      skippedRows: 0,
      errors: snapshot.errors.length
    },
    artifactRefs: []
  };
}

function buildExportPayload(snapshots: SnapshotEnvelope[]) {
  const byAccount = snapshots.map((snapshot) => {
    const freshness = snapshot.sourceFreshness.status;
    return {
      brokerId: snapshot.brokerId,
      accountAlias: snapshot.account.accountAlias,
      accountType: snapshot.account.accountType,
      accountStatus: snapshot.account.status,
      asOf: snapshot.asOf,
      baseCurrency: snapshot.baseCurrency,
      sourceType: snapshot.sourceType,
      sourceName: snapshot.sourceFreshness.sourceName,
      status: freshness,
      missingFields: snapshot.sourceFreshness.missingFields,
      holdingsCount: snapshot.holdings.length,
      cashRowsCount: snapshot.cashBalances.length,
      activityRowsCount: snapshot.activityRows.length
    };
  });

  const allRows = snapshots.flatMap((snapshot) =>
    snapshot.holdings.map((holding) => ({
      brokerId: snapshot.brokerId,
      accountAlias: snapshot.account.accountAlias,
      market: holding.market,
      symbol: holding.symbol,
      currency: holding.currency,
      quantity: holding.quantity,
      marketValue: holding.marketValue || "0",
      costBasis: holding.costBasis || "0",
      unrealizedPnl: holding.unrealizedPnl || "0",
      dataQuality: holding.dataQuality
    }))
  );

  return {
    generatedAt: new Date().toISOString(),
    accounts: byAccount,
    holdings: allRows,
    cash: snapshots.flatMap((snapshot) =>
      snapshot.cashBalances.map((cashBalance) => ({
        brokerId: snapshot.brokerId,
        accountAlias: snapshot.account.accountAlias,
        currency: cashBalance.currency,
        amount: cashBalance.amount,
        balanceType: cashBalance.balanceType
      }))
    )
  };
}

function parseSourceType(value: unknown): PortfolioSourceType | undefined {
  if (typeof value !== "string") return undefined;
  return isPortfolioSourceType(value) ? value : undefined;
}

function toImportRequest(body: InternalRequestBody): Omit<BrokerImportRequest, "requestedAt"> & {
  requestedAt: string;
  mode: BrokerImportRequest["mode"]; 
} {
  return {
    accountAlias: requiredText(body.accountAlias) || "",
    mode: "csv-import",
    sourceType: parseSourceType(body.sourceType) || "csv-current-position-snapshot",
    filePath: requiredText(body.filePath) || "",
    requestedAt: requiredText(body.requestedAt) || new Date().toISOString(),
    checksum: requiredText(body.checksum),
    ownerApproved: body.ownerApproved === true,
    retainRawImport: body.retainRawImport === true
  };
}

function toFixtureRequest(body: InternalRequestBody): BrokerSyncRequest & { scenario?: "complete" | "partial" | "failed" | "stale"; adapterId?: string } {
  return {
    accountAlias: requiredText(body.accountAlias) || "",
    mode: "fixture",
    requestedAt: requiredText(body.requestedAt) || new Date().toISOString(),
    scenario: (requiredText(body.scenario) as "complete" | "partial" | "failed" | "stale") || "complete",
    adapterId: requiredText(body.adapterId)
  };
}

function toLiveSyncRequest(body: InternalRequestBody): BrokerSyncRequest {
  return {
    accountAlias: requiredText(body.accountAlias) || "",
    mode: "live-read",
    requestedAt: requiredText(body.requestedAt) || new Date().toISOString()
  };
}

export function createRequestHandler(
  config: AppConfig,
  store: AssistantRouteStore,
  dependencies: RouteDependencies = {}
) {
  const telegramHandler = dependencies.handleTelegramUpdate || handleTelegramUpdate;
  const dailyReportGenerator = dependencies.generateDailyReport || generateDailyReport;
  const endOfDaySpendingReportGenerator =
    dependencies.generateEndOfDaySpendingReport || generateEndOfDaySpendingReport;
  const portfolioStore = dependencies.portfolioStore;
  const sinoPacLiveConnector = dependencies.sinoPacLiveConnector || createSinoPacShioajiLiveConnector(
    createSinoPacShioajiBridgeProvider({
      apiKey: config.sinoPacApiKey,
      secretKey: config.sinoPacSecretKey,
      caPath: config.sinoPacCaPath,
      caPassword: config.sinoPacCaPassword,
      personId: config.sinoPacPersonId,
      command: config.sinoPacShioajiCommand,
      timeoutMs: config.sinoPacShioajiTimeoutMs
    })
  );

  const importers: PortfolioImporterSet = {
    sinoPacCsv: createSinoPacCsvImporter({ brokerId: "sinopac", retainRawImport: false }),
    firstradeCsv: createFirstradeCsvImporter({ brokerId: "firstrade", retainRawImport: false }),
    firstradeQfx: createFirstradeQfxImporter({ brokerId: "firstrade", retainRawImport: false }),
    manualCsv: createManualCsvImporter({ brokerId: "manual", retainRawImport: false })
  };

  return async function handleRequest(request: HttpRequestLike, response: HttpResponseLike): Promise<void> {
    const url = new URL(request.url || "/", "http://localhost");

    try {
      if (request.method === "GET" && url.pathname === "/healthz") {
        return json(response, 200, { ok: true });
      }

      if (request.method === "GET" && url.pathname === "/readyz") {
        return json(response, 200, { ok: true, pendingReviews: store.pendingReviewCount() });
      }

      if (request.method === "POST" && url.pathname === "/telegram/webhook") {
        if (config.telegramWebhookSecret) {
          const header = headerValue(request.headers["x-telegram-bot-api-secret-token"]);
          if (!safeEqual(header, config.telegramWebhookSecret)) {
            return json(response, 403, { ok: false, error: "forbidden" });
          }
        }

        let webhookReply: TelegramWebhookReply | undefined;
        const telegramFetch: typeof fetch = async (input, init) => {
          const fetchUrl = fetchInputUrl(input);
          if (fetchUrl.includes("api.telegram.org") && fetchUrl.includes("/sendMessage")) {
            const reply = telegramWebhookReplyFromBody(init?.body);
            if (reply) {
              webhookReply = reply;
              return new Response(JSON.stringify({ ok: true }), {
                status: 200,
                headers: { "Content-Type": "application/json" },
              });
            }
          }

          return fetch(input, init);
        };

        const result = await telegramHandler(await readJson(request), config, store, { fetchImpl: telegramFetch });
        if (webhookReply && result.status !== "failed") {
          return json(response, 200, webhookReply);
        }

        return json(response, result.status === "failed" ? 400 : 200, result);
      }

      if (request.method === "POST" && url.pathname === "/internal/reports/daily") {
        if (!ensureInternalToken(request, config)) {
          return json(response, 403, { ok: false, error: "forbidden" });
        }

        const report = await dailyReportGenerator(config, store);
        return json(response, 200, report);
      }

      if (request.method === "POST" && url.pathname === "/internal/reports/end-of-day-spending") {
        if (!ensureInternalToken(request, config)) {
          return json(response, 403, { ok: false, error: "forbidden" });
        }

        const report = await endOfDaySpendingReportGenerator(config, store);
        return json(response, 200, report);
      }

      if (request.method === "GET" && url.pathname === "/internal/portfolio/snapshots") {
        if (!ensureInternalToken(request, config)) {
          return json(response, 403, { ok: false, error: "forbidden" });
        }
        if (!portfolioStore) {
          return json(response, 503, { ok: false, error: "portfolio_store_unavailable" });
        }

        const brokerId = requiredText(url.searchParams.get("brokerId"));
        const accountAlias = requiredText(url.searchParams.get("accountAlias"));
        const includePartialOrStale = url.searchParams.get("includePartialOrStale") === "true";

        if (brokerId && accountAlias) {
          const snapshot = portfolioStore.getLatestSnapshotForAccount({ brokerId, accountAlias });
          if (!snapshot) {
            return json(response, 404, { ok: false, error: "not_found" });
          }

          return json(response, 200, {
            ok: true,
            snapshot,
            effectiveFreshness: portfolioStore.snapshotEffectiveFreshness(snapshot),
            redacted: portfolioStore.redactLogPayload(snapshot)
          });
        }

        const snapshots = portfolioStore.getLatestSnapshots().filter((snapshot) => {
          const freshness = portfolioStore.snapshotEffectiveFreshness(snapshot);
          return includePartialOrStale || freshness === "fresh";
        });

        return json(response, 200, {
          ok: true,
          count: snapshots.length,
          snapshots
        });
      }

      if (request.method === "GET" && url.pathname === "/internal/portfolio/aggregate") {
        if (!ensureInternalToken(request, config)) {
          return json(response, 403, { ok: false, error: "forbidden" });
        }
        if (!portfolioStore) {
          return json(response, 503, { ok: false, error: "portfolio_store_unavailable" });
        }

        const includePartialOrStale = url.searchParams.get("includePartialOrStale") === "true";
        return json(response, 200, {
          ok: true,
          rows: portfolioStore.getAggregateBySymbol(includePartialOrStale)
        });
      }

      if (request.method === "POST" && url.pathname === "/internal/portfolio/sync/fixture") {
        if (!ensureInternalToken(request, config)) {
          return json(response, 403, { ok: false, error: "forbidden" });
        }
        if (!portfolioStore) {
          return json(response, 503, { ok: false, error: "portfolio_store_unavailable" });
        }

        const body = asInternalRequest(await readJson(request));
        const syncRequest = toFixtureRequest(body);
        if (!syncRequest.accountAlias) {
          return json(response, 400, { ok: false, error: "accountAlias is required" });
        }

        const connector = createFixtureBrokerConnector({
          adapterId: syncRequest.adapterId || "fixture-broker",
          brokerId: requiredText(body.brokerId) || "fixture",
          scenario: syncRequest.scenario || "complete"
        });

        const preflight = await connector.preflight(syncRequest);
        if (!preflight.ok) {
          return json(response, 400, { ok: false, status: preflight.status, errorClass: preflight.errorClass, error: preflight.reason });
        }

        const snapshot = await connector.syncSnapshot(syncRequest);
        portfolioStore.persistSnapshot(snapshot, buildSyncEvent(snapshot));

        return json(response, 200, {
          ok: true,
          snapshot,
          redacted: redactPortfolioLogPayload(snapshot)
        });
      }

      if (request.method === "POST" && url.pathname === "/internal/portfolio/sync/live") {
        if (!ensureInternalToken(request, config)) {
          return json(response, 403, { ok: false, error: "forbidden" });
        }
        if (!portfolioStore) {
          return json(response, 503, { ok: false, error: "portfolio_store_unavailable" });
        }

        const body = asInternalRequest(await readJson(request));
        const brokerId = requiredText(body.brokerId) || "sinopac";
        const syncRequest = toLiveSyncRequest(body);
        if (!syncRequest.accountAlias) {
          return json(response, 400, { ok: false, error: "accountAlias is required" });
        }
        if (brokerId !== "sinopac") {
          return json(response, 400, { ok: false, error: "unsupported live broker", supportedBrokerIds: ["sinopac"] });
        }

        const preflight = await sinoPacLiveConnector.preflight(syncRequest);
        if (!preflight.ok) {
          return json(response, 400, { ok: false, status: preflight.status, errorClass: preflight.errorClass, error: preflight.reason });
        }

        const snapshot = await sinoPacLiveConnector.syncSnapshot(syncRequest);
        portfolioStore.persistSnapshot(snapshot, buildSyncEvent(snapshot));

        return json(response, 200, {
          ok: true,
          snapshot,
          redacted: redactPortfolioLogPayload(snapshot)
        });
      }

      if (request.method === "POST" && url.pathname === "/internal/portfolio/import/preview") {
        if (!ensureInternalToken(request, config)) {
          return json(response, 403, { ok: false, error: "forbidden" });
        }
        if (!portfolioStore) {
          return json(response, 503, { ok: false, error: "portfolio_store_unavailable" });
        }

        const body = asInternalRequest(await readJson(request));
        const brokerId = requiredText(body.brokerId) || "manual";
        const importRequest = toImportRequest(body);
        if (!importRequest.accountAlias) {
          return json(response, 400, { ok: false, error: "accountAlias is required" });
        }
        if (!importRequest.filePath) {
          return json(response, 400, { ok: false, error: "filePath is required" });
        }

        const importer = chooseImporter(importers, brokerId, importRequest);
        const normalizedImportRequest = normalizeImportMode(brokerId, importRequest);
        const preflight = await importer.preflight(normalizedImportRequest);
        if (!preflight.ok) {
          return json(response, 400, { ok: false, status: preflight.status, errorClass: preflight.errorClass, error: preflight.reason });
        }

        const preview = await importer.previewImport(normalizedImportRequest);
        return json(response, 200, { ok: true, preview });
      }

      if (request.method === "POST" && url.pathname === "/internal/portfolio/import/commit") {
        if (!ensureInternalToken(request, config)) {
          return json(response, 403, { ok: false, error: "forbidden" });
        }
        if (!portfolioStore) {
          return json(response, 503, { ok: false, error: "portfolio_store_unavailable" });
        }

        const body = asInternalRequest(await readJson(request));
        const brokerId = requiredText(body.brokerId) || "manual";
        const importRequest = toImportRequest(body);
        if (!importRequest.accountAlias) {
          return json(response, 400, { ok: false, error: "accountAlias is required" });
        }
        if (!importRequest.filePath) {
          return json(response, 400, { ok: false, error: "filePath is required" });
        }
        if (!importRequest.ownerApproved) {
          return json(response, 400, { ok: false, error: "ownerApproved must be true" });
        }

        const importer = chooseImporter(importers, brokerId, importRequest);
        const normalizedImportRequest = normalizeImportMode(brokerId, importRequest);
        const preflight = await importer.preflight(normalizedImportRequest);
        if (!preflight.ok) {
          return json(response, 400, { ok: false, status: preflight.status, errorClass: preflight.errorClass, error: preflight.reason });
        }

        const checksum = resolveImportChecksum(importRequest.filePath, (path) => readFileSync(path, "utf8"), importRequest.checksum);
        const snapshot = await importer.commitImport(normalizedImportRequest);
        portfolioStore.recordRawImport({
          sourceType: importRequest.sourceType,
          checksum,
          brokerId: snapshot.brokerId,
          accountAlias: snapshot.account.accountAlias,
          filePath: importRequest.filePath,
          retained: importRequest.retainRawImport ? 1 : 0
        });
        portfolioStore.persistSnapshot(snapshot, buildSyncEvent(snapshot));

        return json(response, 200, {
          ok: true,
          snapshot,
          redacted: redactPortfolioLogPayload(snapshot)
        });
      }

      if (request.method === "POST" && url.pathname === "/internal/portfolio/wealthfolio/export") {
        if (!ensureInternalToken(request, config)) {
          return json(response, 403, { ok: false, error: "forbidden" });
        }
        if (!portfolioStore) {
          return json(response, 503, { ok: false, error: "portfolio_store_unavailable" });
        }

        const body = asInternalRequest(await readJson(request));
        const target = requiredText(body.target) || "wealthfolio-local";
        const format = requiredText(body.format) || "json";
        const includePartialOrStale = body.includePartialOrStale === true;

        const snapshots = portfolioStore.getLatestSnapshots().filter((snapshot) => {
          const freshness = portfolioStore.snapshotEffectiveFreshness(snapshot);
          return includePartialOrStale || freshness === "fresh";
        });

        mkdirSync(config.portfolioExportDir, { recursive: true });
        const freshnessStatus = aggregateFreshness(snapshots.map((snapshot) => snapshot.sourceFreshness.status));
        const snapshotIds = snapshots.map((snapshot) => snapshot.syncRunId);
        const exportId = `wealthfolio-${Date.now()}-${createHash("sha256").update(`${target}-${Date.now()}`).digest("hex").slice(0, 12)}`;
        const artifactPath = join(config.portfolioExportDir, `${exportId}.json`);
        const payload = buildExportPayload(snapshots);

        const validFormats = new Set(["json", "csv", "api-payload", "markdown"]);
        const safeFormat = validFormats.has(format) ? format : "json";

        const record = portfolioStore.createWealthfolioExportRecord({
          target,
          format: safeFormat as "json" | "csv" | "api-payload" | "markdown",
          snapshotSyncRunIds: snapshotIds,
          artifactPath,
          freshnessStatus,
          includedFields: ["brokerId", "accountAlias", "market", "symbol", "currency", "quantity", "marketValue", "costBasis", "unrealizedPnl", "asOf"],
          omittedFields: ["raw-imports", "credentials", "secrets"],
          status: "created"
        });
        writeFileSync(record.artifactPath, JSON.stringify(payload, null, 2));

        return json(response, 200, {
          ok: true,
          exportId: record.exportId,
          artifactPath: record.artifactPath,
          status: record.status,
          snapshotSyncRunIds: snapshotIds,
          includedRows: snapshots.length
        });
      }

      if (request.method === "POST" && url.pathname === "/internal/portfolio/maintenance/purge") {
        if (!ensureInternalToken(request, config)) {
          return json(response, 403, { ok: false, error: "forbidden" });
        }
        if (!portfolioStore) {
          return json(response, 503, { ok: false, error: "portfolio_store_unavailable" });
        }

        const body = asInternalRequest(await readJson(request));
        const snapshotRetentionDays = clampDays(body.snapshotRetentionDays) || config.portfolioSnapshotRetentionDays;
        const exportRetentionDays = clampDays(body.exportRetentionDays) || config.portfolioExportRetentionDays;
        const rawImportRetentionDays = clampDays(body.rawImportRetentionDays) || config.portfolioRawImportRetentionDays;
        const backupRetentionDays = clampDays(body.backupRetentionDays) || config.portfolioExportRetentionDays;

        const purged = {
          snapshots: portfolioStore.purgeExpiredSnapshots(snapshotRetentionDays),
          exports: portfolioStore.purgeExpiredExports(exportRetentionDays),
          rawImports: portfolioStore.purgeExpiredRawImports(rawImportRetentionDays),
          backups: portfolioStore.purgeExpiredBackups(backupRetentionDays)
        };

        return json(response, 200, { ok: true, purged });
      }

      return json(response, 404, { ok: false, error: "not_found" });
    } catch (error) {
      console.error("request failed", error instanceof Error ? error.message : error);
      return json(response, 500, { ok: false, error: "internal_error" });
    }
  };
}
