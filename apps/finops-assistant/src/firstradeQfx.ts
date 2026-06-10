import { readFileSync } from "node:fs";
import {
  ActivityRow,
  BrokerAdapterDescriptor,
  BrokerImportRequest,
  BrokerImporter,
  BrokerPreflightResult,
  CashBalance,
  ImportPreview,
  PortfolioHolding,
  SourceFreshness,
  SNAPSHOT_SCHEMA_VERSION,
  SnapshotEnvelope,
  classifyBrokerSyncError
} from "./portfolioSync";
import {
  deleteRawImportFile,
  defaultImportHistoryStore,
  ImportHistoryStore,
  importHistoryKey,
  parseDateRange,
  resolveImportChecksum,
  sanitizeFormulaLikeText
} from "./importHelpers";

type ReadFile = (path: string) => string;

export interface FirstradeQfxImporterOptions {
  adapterId?: string;
  brokerId?: string;
  readFile?: ReadFile;
  retainRawImport?: boolean;
  importHistoryStore?: ImportHistoryStore;
}

interface ParsedFirstradeQfx {
  holdings: PortfolioHolding[];
  cashBalances: CashBalance[];
  activityRows: ActivityRow[];
  sourceTimestamp: string;
  missingFields: string[];
  skippedRows: number;
  dateRange?: {
    from: string;
    to: string;
  };
}

interface SecurityInfo {
  uniqueId: string;
  ticker: string;
  name?: string;
}

const QFX_SOURCE_TYPE = "statement-import";

export function createFirstradeQfxImporter(options: FirstradeQfxImporterOptions = {}): BrokerImporter {
  const readFile = options.readFile || ((path: string) => String(readFileSync(path, "utf8")));
  const retainRawImportDefault = options.retainRawImport || false;
  const importHistoryStore = options.importHistoryStore || defaultImportHistoryStore;
  const descriptor: BrokerAdapterDescriptor = {
    adapterId: options.adapterId || "firstrade-qfx",
    brokerId: options.brokerId || "firstrade",
    displayName: "Firstrade QFX/OFX Importer",
    kind: "statement-importer",
    supportedSourceTypes: [QFX_SOURCE_TYPE],
    supportedMarkets: ["US"],
    supportsHoldings: true,
    supportsCash: true,
    supportsActivity: true,
    supportsCostBasis: false,
    credentialMode: "owner-upload",
    productionStatus: "import-only"
  };

  return {
    describe: () => descriptor,
    preflight: (request) => preflightQfx(request, readFile),
    previewImport: (request) => {
      const preflight = preflightQfx(request, readFile);
      if (!preflight.ok) {
        throw new Error(`Invalid Firstrade QFX import request: ${preflight.reason}`);
      }

      const checksum = resolveImportChecksum(request.filePath, readFile, request.checksum);
      const historyKey = importHistoryKey({
        brokerId: descriptor.brokerId,
        accountAlias: request.accountAlias,
        sourceType: request.sourceType,
        checksum
      });

      const existing = importHistoryStore.get(historyKey);
      if (existing) return buildPreviewFromSnapshot(existing, checksum);

      const parsed = parseFirstradeQfx(readFile(request.filePath), descriptor.brokerId, request.accountAlias, request.requestedAt);
      return buildPreview(request, parsed, checksum);
    },
    commitImport: (request) => {
      if (!request.ownerApproved) {
        throw new Error("Firstrade QFX import requires owner approval before commit.");
      }

      const preflight = preflightQfx(request, readFile);
      if (!preflight.ok) {
        throw new Error(`Invalid Firstrade QFX import request: ${preflight.reason}`);
      }

      const checksum = resolveImportChecksum(request.filePath, readFile, request.checksum);
      const historyKey = importHistoryKey({
        brokerId: descriptor.brokerId,
        accountAlias: request.accountAlias,
        sourceType: request.sourceType,
        checksum
      });
      const existing = importHistoryStore.get(historyKey);
      if (existing) {
        if (!(request.retainRawImport ?? retainRawImportDefault)) deleteRawImportFile(request.filePath);
        return existing;
      }

      const parsed = parseFirstradeQfx(readFile(request.filePath), descriptor.brokerId, request.accountAlias, request.requestedAt);
      const snapshot = buildSnapshot(descriptor, { ...request, checksum }, parsed);
      importHistoryStore.set(historyKey, snapshot);

      if (!(request.retainRawImport ?? retainRawImportDefault)) deleteRawImportFile(request.filePath);
      return snapshot;
    },
    classifyError: classifyBrokerSyncError
  };
}

function preflightQfx(request: BrokerImportRequest, readFile: ReadFile): BrokerPreflightResult {
  if (request.mode !== "csv-import") {
    return { ok: false, status: "rejected", errorClass: "unsafe-input", reason: "Firstrade QFX importer only supports import mode." };
  }
  if (request.sourceType !== QFX_SOURCE_TYPE) {
    return { ok: false, status: "rejected", errorClass: "schema-mismatch", reason: "Firstrade QFX imports must use statement-import sourceType." };
  }
  if (!/^[A-Za-z0-9._-]{1,64}$/.test(request.accountAlias)) {
    return { ok: false, status: "rejected", errorClass: "unsafe-input", reason: `Invalid accountAlias: ${request.accountAlias}` };
  }
  if (!request.filePath.toLowerCase().endsWith(".qfx") && !request.filePath.toLowerCase().endsWith(".ofx")) {
    return { ok: false, status: "rejected", errorClass: "schema-mismatch", reason: "Firstrade QFX import requires a .qfx or .ofx file." };
  }
  if (request.filePath.includes("\0") || request.filePath.includes("..")) {
    return { ok: false, status: "rejected", errorClass: "unsafe-input", reason: "Import file path is unsafe." };
  }

  let content: string;
  try {
    content = readFile(request.filePath);
  } catch (error) {
    return {
      ok: false,
      status: "rejected",
      errorClass: "unsafe-input",
      reason: `Failed to read import file: ${error instanceof Error ? error.message : "read error"}`
    };
  }

  if (!content.includes("<OFX>") || !content.includes("<INVSTMTRS>")) {
    return { ok: false, status: "rejected", errorClass: "schema-mismatch", reason: "Import file is not a Firstrade investment QFX/OFX statement." };
  }
  if (!content.includes("<INVPOSLIST>") && !content.includes("<INVBAL>") && !content.includes("<INVTRANLIST>")) {
    return { ok: false, status: "rejected", errorClass: "schema-mismatch", reason: "QFX file does not contain holdings, balances, or investment transactions." };
  }

  return { ok: true, status: "succeeded", sourceTimestamp: ofxDateToIso(tag(content, "DTASOF")) };
}

function buildPreviewFromSnapshot(snapshot: SnapshotEnvelope, checksum: string): ImportPreview {
  return {
    accountAlias: snapshot.account.accountAlias,
    sourceType: snapshot.sourceType,
    sourceTimestamp: snapshot.sourceFreshness.sourceTimestamp,
    dateRange: { from: snapshot.asOf, to: snapshot.asOf },
    checksum,
    status: snapshot.sourceFreshness.status === "fresh" ? "accepted" : "partial",
    missingFields: snapshot.sourceFreshness.missingFields,
    rowCounts: {
      accounts: 1,
      holdings: snapshot.holdings.length,
      cashBalances: snapshot.cashBalances.length,
      activityRows: snapshot.activityRows.length,
      skippedRows: 0,
      errors: snapshot.errors.length
    }
  };
}

function buildPreview(request: BrokerImportRequest, parsed: ParsedFirstradeQfx, checksum: string): ImportPreview {
  return {
    accountAlias: request.accountAlias,
    sourceType: request.sourceType,
    sourceTimestamp: parsed.sourceTimestamp,
    dateRange: parsed.dateRange,
    checksum,
    status: parsed.missingFields.length > 0 ? "partial" : "accepted",
    missingFields: parsed.missingFields,
    rowCounts: {
      accounts: 1,
      holdings: parsed.holdings.length,
      cashBalances: parsed.cashBalances.length,
      activityRows: parsed.activityRows.length,
      skippedRows: parsed.skippedRows,
      errors: 0
    }
  };
}

function buildSnapshot(
  descriptor: BrokerAdapterDescriptor,
  request: BrokerImportRequest & { checksum: string },
  parsed: ParsedFirstradeQfx
): SnapshotEnvelope {
  const missingFields = [...parsed.missingFields];
  const status: SourceFreshness["status"] = missingFields.length > 0 ? "partial" : "fresh";

  return {
    schemaVersion: SNAPSHOT_SCHEMA_VERSION,
    syncRunId: `firstrade-qfx-${request.accountAlias}-${request.sourceType}-${request.checksum}`,
    brokerId: descriptor.brokerId,
    account: {
      brokerId: descriptor.brokerId,
      accountAlias: request.accountAlias,
      accountIdentityHash: `firstrade-qfx:${request.accountAlias}`,
      accountType: "brokerage",
      baseCurrency: "USD",
      marketScope: descriptor.supportedMarkets,
      displayName: "Firstrade Account",
      status: "import-only",
      createdAt: request.requestedAt,
      updatedAt: request.requestedAt
    },
    sourceType: request.sourceType,
    sourceFreshness: {
      sourceType: request.sourceType,
      sourceName: descriptor.adapterId,
      sourceTimestamp: parsed.sourceTimestamp,
      fetchedAt: request.requestedAt,
      committedAt: request.requestedAt,
      maxAgeMinutes: 1440,
      status,
      reason: status === "partial" ? "Firstrade QFX is missing cost-basis fields or other optional normalized fields." : undefined,
      missingFields
    },
    baseCurrency: "USD",
    asOf: parsed.sourceTimestamp,
    holdings: parsed.holdings,
    cashBalances: parsed.cashBalances,
    activityRows: parsed.activityRows,
    errors: [],
    dataQuality: missingFields
  };
}

function parseFirstradeQfx(content: string, brokerId: string, accountAlias: string, fallbackAsOf: string): ParsedFirstradeQfx {
  const sourceTimestamp = ofxDateToIso(tag(content, "DTASOF")) || fallbackAsOf;
  const securities = parseSecurities(content);
  const holdings = parseHoldings(content, securities, brokerId, accountAlias, sourceTimestamp);
  const cashBalances = parseCashBalances(content, brokerId, accountAlias, sourceTimestamp);
  const activityRows = parseActivities(content, securities, brokerId, accountAlias, sourceTimestamp);
  const missingFields = unique(holdings.flatMap((holding) => holding.dataQuality));
  const dates = activityRows.flatMap((row) => [row.tradeDate || "", row.settleDate || ""]).filter(Boolean);

  return {
    holdings,
    cashBalances,
    activityRows,
    sourceTimestamp,
    missingFields,
    dateRange: parseDateRange([sourceTimestamp, ...dates]),
    skippedRows: 0
  };
}

function parseSecurities(content: string): Map<string, SecurityInfo> {
  const result = new Map<string, SecurityInfo>();
  for (const block of tags(content, "STOCKINFO")) {
    const secInfo = tag(block, "SECINFO") || block;
    const uniqueId = tag(tag(secInfo, "SECID") || "", "UNIQUEID");
    const ticker = tag(secInfo, "TICKER");
    if (!uniqueId || !ticker) continue;
    result.set(uniqueId, {
      uniqueId,
      ticker: sanitizeFormulaLikeText(ticker),
      name: cleanSecurityName(tag(secInfo, "SECNAME"), uniqueId)
    });
  }
  return result;
}

function parseHoldings(
  content: string,
  securities: Map<string, SecurityInfo>,
  brokerId: string,
  accountAlias: string,
  asOf: string
): PortfolioHolding[] {
  return tags(content, "POSSTOCK").map((block) => {
    const invPos = tag(block, "INVPOS") || block;
    const uniqueId = tag(tag(invPos, "SECID") || "", "UNIQUEID");
    const security = uniqueId ? securities.get(uniqueId) : undefined;
    const ticker = security?.ticker || uniqueId || "";
    const units = tag(invPos, "UNITS") || "0";
    const unitPrice = tag(invPos, "UNITPRICE");
    const marketValue = tag(invPos, "MKTVAL");
    const dataQuality = ["holdings.averageCost", "holdings.costBasis"];
    if (!marketValue) dataQuality.push("holdings.marketValue");
    if (!ticker) dataQuality.push("holdings.symbol");

    return {
      brokerId,
      accountAlias,
      market: "US",
      symbol: sanitizeFormulaLikeText(ticker),
      providerSymbol: uniqueId || undefined,
      securityName: sanitizeFormulaLikeText(security?.name || tag(invPos, "MEMO") || ticker),
      assetType: "stock",
      currency: "USD",
      quantity: units,
      lastPrice: unitPrice || undefined,
      marketValue: marketValue || undefined,
      asOf,
      freshnessStatus: dataQuality.length > 0 ? "partial" : "fresh",
      dataQuality
    };
  });
}

function parseCashBalances(content: string, brokerId: string, accountAlias: string, asOf: string): CashBalance[] {
  const availableCash = tag(content, "AVAILCASH");
  if (!availableCash) return [];
  return [
    {
      brokerId,
      accountAlias,
      currency: "USD",
      amount: availableCash,
      balanceType: "available",
      asOf,
      freshnessStatus: "fresh",
      dataQuality: []
    }
  ];
}

function parseActivities(
  content: string,
  securities: Map<string, SecurityInfo>,
  brokerId: string,
  accountAlias: string,
  asOf: string
): ActivityRow[] {
  const rows: ActivityRow[] = [];
  for (const block of tags(content, "BUYSTOCK")) {
    const invBuy = tag(block, "INVBUY") || block;
    const invTran = tag(invBuy, "INVTRAN") || "";
    const uniqueId = tag(tag(invBuy, "SECID") || "", "UNIQUEID");
    const security = uniqueId ? securities.get(uniqueId) : undefined;
    rows.push({
      brokerId,
      accountAlias,
      activityId: tag(invTran, "FITID") || `${accountAlias}-qfx-buy-${rows.length}`,
      activityType: "buy",
      tradeDate: ofxDateToIso(tag(invTran, "DTTRADE")),
      settleDate: ofxDateToIso(tag(invTran, "DTSETTLE")),
      market: "US",
      symbol: sanitizeFormulaLikeText(security?.ticker || uniqueId || ""),
      currency: "USD",
      quantity: tag(invBuy, "UNITS") || undefined,
      price: tag(invBuy, "UNITPRICE") || undefined,
      amount: tag(invBuy, "TOTAL") || undefined,
      amountType: "net",
      sourceDescription: sanitizeFormulaLikeText(tag(invTran, "MEMO") || ""),
      asOf,
      dataQuality: []
    });
  }

  for (const block of tags(content, "INVBANKTRAN")) {
    const stmt = tag(block, "STMTTRN") || block;
    rows.push({
      brokerId,
      accountAlias,
      activityId: tag(stmt, "FITID") || `${accountAlias}-qfx-cash-${rows.length}`,
      activityType: mapBankTransactionType(tag(stmt, "TRNTYPE")),
      tradeDate: ofxDateToIso(tag(stmt, "DTPOSTED")),
      currency: "USD",
      amount: tag(stmt, "TRNAMT") || undefined,
      amountType: "net",
      sourceDescription: sanitizeFormulaLikeText(tag(stmt, "NAME") || ""),
      asOf,
      dataQuality: []
    });
  }
  return rows;
}

function mapBankTransactionType(type: string): ActivityRow["activityType"] {
  const normalized = type.toUpperCase();
  if (normalized === "CREDIT" || normalized === "DEP") return "deposit";
  if (normalized === "DEBIT" || normalized === "WITHDRAWAL") return "withdrawal";
  if (normalized === "INT") return "interest";
  if (normalized === "FEE") return "fee";
  return "unknown";
}

function tag(content: string, name: string): string {
  const match = new RegExp(`<${name}>([\\s\\S]*?)</${name}>`, "i").exec(content);
  return match?.[1]?.trim() || "";
}

function tags(content: string, name: string): string[] {
  return [...content.matchAll(new RegExp(`<${name}>([\\s\\S]*?)</${name}>`, "gi"))].map((match) => match[1]?.trim() || "");
}

function ofxDateToIso(value: string): string {
  if (!value || value.length < 8) return "";
  return `${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6, 8)}T00:00:00.000Z`;
}

function cleanSecurityName(value: string, uniqueId: string): string | undefined {
  const cleaned = value.replace(uniqueId, "").trim().replace(/\s+/g, " ");
  return cleaned || undefined;
}

function unique(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}
