import { readFileSync } from "node:fs";
import {
  ActivityRow,
  BrokerAdapterDescriptor,
  BrokerImportRequest,
  BrokerImporter,
  CashBalance,
  ImportPreview,
  PortfolioHolding,
  PortfolioSourceType,
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
import { validateCsvImportPreflight } from "./importValidation";

type ReadFile = (path: string) => string;

export interface ManualCsvImporterOptions {
  adapterId?: string;
  brokerId?: string;
  readFile?: ReadFile;
  retainRawImport?: boolean;
  importHistoryStore?: ImportHistoryStore;
  supportedSourceTypes?: PortfolioSourceType[];
  importModes?: ("manual-import" | "csv-import")[];
  supportedMarkets?: string[];
  baseCurrency?: string;
  defaultCurrency?: string;
}

interface ParsedManualCsv {
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

export function createManualCsvImporter(options: ManualCsvImporterOptions = {}): BrokerImporter {
  const readFile = options.readFile || ((path: string) => String(readFileSync(path, "utf8")));
  const retainRawImportDefault = options.retainRawImport || false;
  const importHistoryStore = options.importHistoryStore || defaultImportHistoryStore;
  const supportedSourceTypes = options.supportedSourceTypes || ["manual-csv"];
  const importModes = options.importModes || ["manual-import"];
  const supportedMarkets = options.supportedMarkets || ["NYSE", "NASDAQ", "NYSEARCA", "TWSE", "TPEx"];
  const baseCurrency = options.baseCurrency || "USD";
  const defaultCurrency = options.defaultCurrency || baseCurrency;
  const descriptor: BrokerAdapterDescriptor = {
    adapterId: options.adapterId || "manual-csv",
    brokerId: options.brokerId || "manual",
    displayName: "Manual CSV Importer",
    kind: "manual-importer",
    supportedSourceTypes,
    supportedMarkets,
    supportsHoldings: true,
    supportsCash: true,
    supportsActivity: true,
    supportsCostBasis: true,
    credentialMode: "owner-upload",
    productionStatus: "import-only"
  };

  return {
    describe: () => descriptor,
    preflight: (request) => {
      if (!importModes.includes(request.mode)) {
        return {
          ok: false,
          status: "rejected",
          errorClass: "unsafe-input",
          reason: `Manual CSV importer does not support mode ${request.mode}.`
        };
      }
      if (!supportedSourceTypes.includes(request.sourceType)) {
        return {
          ok: false,
          status: "rejected",
          errorClass: "schema-mismatch",
          reason: `Unsupported manual source type: ${request.sourceType}`
        };
      }

      const preflight = validateCsvImportPreflight(request, readFile, PRE_FLIGHT_RULES);
      if (!preflight.ok) {
        return preflight;
      }

      return { ok: true, status: "succeeded" };
    },
    previewImport: (request) => {
      if (!supportedSourceTypes.includes(request.sourceType)) {
        throw new Error(`Unsupported manual source type: ${request.sourceType}`);
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
        return buildPreviewFromSnapshot(existing, checksum);
      }

      const preflight = validateCsvImportPreflight(request, readFile, PRE_FLIGHT_RULES);
      if (!preflight.ok) {
        throw new Error(`Invalid manual import request: ${preflight.reason}`);
      }

      const parsed = parseManualCsv(
        readFile(request.filePath),
        descriptor.brokerId,
        request.accountAlias,
        request.requestedAt,
        defaultCurrency
      );
      return buildPreview(request, parsed, checksum);
    },
    commitImport: (request) => {
      if (!request.ownerApproved) {
        throw new Error("Manual CSV import requires owner approval before commit.");
      }
      if (!supportedSourceTypes.includes(request.sourceType)) {
        throw new Error(`Unsupported manual source type: ${request.sourceType}`);
      }

      const preflight = validateCsvImportPreflight(request, readFile, PRE_FLIGHT_RULES);
      if (!preflight.ok) {
        throw new Error(`Invalid manual import request: ${preflight.reason}`);
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
        if (!(request.retainRawImport ?? retainRawImportDefault)) {
          deleteRawImportFile(request.filePath);
        }
        return existing;
      }

      const parsed = parseManualCsv(
        readFile(request.filePath),
        descriptor.brokerId,
        request.accountAlias,
        request.requestedAt,
        defaultCurrency
      );
      const snapshot = buildSnapshot(
        descriptor,
        { ...request, checksum },
        parsed,
        baseCurrency
      );
      importHistoryStore.set(historyKey, snapshot);

      if (!(request.retainRawImport ?? retainRawImportDefault)) {
        deleteRawImportFile(request.filePath);
      }

      return snapshot;
    },
    classifyError: classifyBrokerSyncError
  };
}

function buildPreviewFromSnapshot(snapshot: SnapshotEnvelope, checksum: string): ImportPreview {
  return {
    accountAlias: snapshot.account.accountAlias,
    sourceType: snapshot.sourceType,
    sourceTimestamp: snapshot.sourceFreshness.sourceTimestamp,
    dateRange: {
      from: snapshot.asOf,
      to: snapshot.asOf
    },
    checksum,
    status: snapshot.sourceFreshness.status === "fresh" ? "accepted" : snapshot.sourceFreshness.status === "failed" ? "rejected" : "partial",
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

function buildPreview(request: BrokerImportRequest, parsed: ParsedManualCsv, checksum: string): ImportPreview {
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
  parsed: ParsedManualCsv,
  baseCurrency: string
): SnapshotEnvelope {
  const status: SourceFreshness["status"] = parsed.missingFields.length > 0 ? "partial" : "fresh";

  return {
    schemaVersion: "investment-portfolio.snapshot.v1",
    syncRunId: `${descriptor.adapterId}-${request.accountAlias}-${request.sourceType}-${request.checksum}`,
    brokerId: descriptor.brokerId,
    account: {
      brokerId: descriptor.brokerId,
      accountAlias: request.accountAlias,
      accountIdentityHash: `${descriptor.adapterId}:${request.accountAlias}`,
      baseCurrency,
      marketScope: descriptor.supportedMarkets,
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
      maxAgeMinutes: 43200,
      status,
      reason: status === "partial" ? "Manual import has one or more missing normalized fields." : undefined,
      missingFields: parsed.missingFields
    },
    baseCurrency,
    asOf: parsed.sourceTimestamp,
    holdings: parsed.holdings,
    cashBalances: parsed.cashBalances,
    activityRows: parsed.activityRows,
    errors: [],
    dataQuality: parsed.missingFields
  };
}

function parseManualCsv(
  content: string,
  brokerId: string,
  accountAlias: string,
  fallbackAsOf: string,
  defaultCurrency = "USD"
): ParsedManualCsv {
  const rows = parseCsv(content).filter((row) => row.some((cell) => cell.trim().length > 0));
  if (rows.length === 0) {
    return { holdings: [], cashBalances: [], activityRows: [], sourceTimestamp: fallbackAsOf, missingFields: ["csv.rows"], skippedRows: 0 };
  }

  const headers = rows[0].map((header) => normalizeHeader(header));
  const records = rows.slice(1).map((row) => rowToRecord(headers, row));
  const holdings: PortfolioHolding[] = [];
  const cashBalances: CashBalance[] = [];
  const activityRows: ActivityRow[] = [];
  const missingFields: string[] = [];
  const dates: string[] = [];
  let skippedRows = 0;

  for (const record of records) {
    if (isBlankRecord(record)) {
      skippedRows += 1;
      continue;
    }

    const rowType = oneOf(record, ["row-type", "type"]).toLowerCase();
    const sourceDate = oneOf(record, ["trade-date", "as-of", "asof", "as_of", "date"], "");
    if (sourceDate) {
      dates.push(sourceDate);
    }

    if (rowType === "holding" || rowType === "position") {
      const holding = holdingFromRecordWithCurrency(record, brokerId, accountAlias, fallbackAsOf, defaultCurrency);
      if (!holding.symbol || !holding.quantity) {
        skippedRows += 1;
      } else {
        holdings.push(holding);
      }
      if (holding.dataQuality.length > 0) missingFields.push(...holding.dataQuality.map(normalizeHoldingQuality));
      continue;
    }

    if (rowType === "cash") {
      const cash = cashFromRecordWithCurrency(record, brokerId, accountAlias, fallbackAsOf, defaultCurrency);
      if (cash.dataQuality.length > 0) {
        skippedRows += 1;
        missingFields.push(...cash.dataQuality);
      } else {
        cashBalances.push(cash);
      }
      continue;
    }

  if (rowType === "activity" || rowType === "transaction") {
      const activity = activityFromRecordWithCurrency(record, brokerId, accountAlias, fallbackAsOf, defaultCurrency, rowType);
      if (activity.dataQuality.length > 0 || !activity.activityType) {
        skippedRows += 1;
        missingFields.push(...activity.dataQuality);
      } else {
        activityRows.push(activity);
      }
      continue;
    }

    skippedRows += 1;
  }

  return {
    holdings,
    cashBalances,
    activityRows,
    sourceTimestamp: firstAsOf(records) || fallbackAsOf,
    dateRange: parseDateRange(dates),
    missingFields: unique(missingFields),
    skippedRows
  };
}

function holdingFromRecord(record: Record<string, string>, brokerId: string, accountAlias: string, fallbackAsOf: string): PortfolioHolding {
  return holdingFromRecordWithCurrency(record, brokerId, accountAlias, fallbackAsOf, "USD");
}

function holdingFromRecordWithCurrency(
  record: Record<string, string>,
  brokerId: string,
  accountAlias: string,
  fallbackAsOf: string,
  defaultCurrency: string
): PortfolioHolding {
  const holding: PortfolioHolding = {
    brokerId,
    accountAlias,
    market: oneOf(record, ["market", "exchange", "marketplace"]) || "NYSE",
    symbol: sanitizeFormulaLikeText(oneOf(record, ["symbol", "ticker", "sec"])),
    assetType: normalizeAssetType(oneOf(record, ["asset-type", "assetType", "type"], "stock")),
    currency: oneOf(record, ["currency", "ccy"], defaultCurrency),
    quantity: oneOf(record, ["quantity", "qty", "shares"], ""),
    averageCost: optionalOneOf(record, ["average-cost", "averagecost", "avg-cost", "avgCost"]),
    costBasis: optionalOneOf(record, ["cost-basis", "costbasis", "costBasis"]),
    lastPrice: optionalOneOf(record, ["last-price", "last", "price"]),
    marketValue: optionalOneOf(record, ["market-value", "marketvalue", "value"]),
    asOf: oneOf(record, ["as-of", "asof", "as_of", "date"], fallbackAsOf),
    freshnessStatus: "fresh",
    dataQuality: []
  };

  const missing: string[] = [];
  if (!holding.symbol) missing.push("holdings.symbol");
  if (!holding.quantity) missing.push("holdings.quantity");
  if (!holding.marketValue) missing.push("holdings.marketValue");
  holding.dataQuality = missing;
  if (holding.dataQuality.length > 0) holding.freshnessStatus = "partial";
  return holding;
}

function cashFromRecord(record: Record<string, string>, brokerId: string, accountAlias: string, fallbackAsOf: string): CashBalance {
  return cashFromRecordWithCurrency(record, brokerId, accountAlias, fallbackAsOf, "USD");
}

function cashFromRecordWithCurrency(
  record: Record<string, string>,
  brokerId: string,
  accountAlias: string,
  fallbackAsOf: string,
  defaultCurrency: string
): CashBalance {
  const rawAmount = optionalOneOf(record, ["amount", "balance", "cash"]) || "0";
  const balanceTypeRaw = oneOf(record, ["balance-type", "balancetype", "type"], "settled");
  const balance: CashBalance = {
    brokerId,
    accountAlias,
    currency: oneOf(record, ["currency", "ccy"], defaultCurrency),
    amount: rawAmount,
    balanceType: cashBalanceType(balanceTypeRaw),
    asOf: oneOf(record, ["as-of", "asof", "as_of", "date"], fallbackAsOf),
    freshnessStatus: "fresh",
    dataQuality: []
  };

  if (!optionalOneOf(record, ["amount", "balance", "cash"])) {
    balance.dataQuality.push("cash-balance-missing-amount");
    balance.freshnessStatus = "partial";
  }
  return balance;
}

function activityFromRecord(
  record: Record<string, string>,
  brokerId: string,
  accountAlias: string,
  fallbackAsOf: string,
  rowType: string
): ActivityRow {
  return activityFromRecordWithCurrency(record, brokerId, accountAlias, fallbackAsOf, "USD", rowType);
}

function activityFromRecordWithCurrency(
  record: Record<string, string>,
  brokerId: string,
  accountAlias: string,
  fallbackAsOf: string,
  defaultCurrency: string,
  rowType: string
): ActivityRow {
  const activityType = mapActivityType(oneOf(record, ["activity-type", "action", "activity", "type"]));
  const sourceDescription = optionalOneOf(record, ["description", "desc", "memo"]) || "";
  const amount = optionalOneOf(record, ["amount", "total", "proceeds"]) || "0";
  const activity: ActivityRow = {
    brokerId,
    accountAlias,
    activityId: oneOf(record, ["activity-id", "id", "ref"], `${accountAlias}-${rowType}-${fallbackAsOf}`),
    activityType,
    tradeDate: optionalOneOf(record, ["trade-date", "tradeDate", "trade_date", "date"]),
    settleDate: optionalOneOf(record, ["settle-date", "settleDate", "settle_date"]),
    market: optionalOneOf(record, ["market", "exchange"]),
    symbol: sanitizeFormulaLikeText(optionalOneOf(record, ["symbol", "ticker"]) || ""),
    currency: oneOf(record, ["currency", "ccy"], defaultCurrency),
    amount,
    amountType: mapAmountType(oneOf(record, ["amount-type", "amountType"], "unknown")),
    sourceDescription: sanitizeFormulaLikeText(sourceDescription),
    asOf: oneOf(record, ["as-of", "asof", "as_of", "date"], fallbackAsOf),
    dataQuality: []
  };

  if (!activity.activityType) {
    activity.dataQuality.push("activity-type-missing");
  }
  const rawAmount = optionalOneOf(record, ["amount", "total", "proceeds"]);
  if (!rawAmount) {
    activity.dataQuality.push("activity-amount-missing");
  }
  return activity;
}

function mapActivityType(raw: string): ActivityRow["activityType"] {
  const normalized = raw.toLowerCase();
  if (normalized === "buy") return "buy";
  if (normalized === "sell") return "sell";
  if (normalized === "dividend") return "dividend";
  if (normalized === "interest") return "interest";
  if (normalized === "fee") return "fee";
  if (normalized === "tax") return "tax";
  if (normalized === "split") return "split";
  if (normalized === "transfer") return "transfer";
  if (normalized === "gain-loss") return "gain-loss";
  return "unknown";
}

function mapAmountType(raw: string): ActivityRow["amountType"] {
  const normalized = raw.toLowerCase();
  if (normalized === "gross") return "gross";
  if (normalized === "net") return "net";
  if (normalized === "fee") return "fee";
  if (normalized === "tax") return "tax";
  return "unknown";
}

function parseCsv(content: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let inQuotes = false;

  for (let index = 0; index < content.length; index += 1) {
    const char = content[index];
    const next = content[index + 1];
    if (char === '"' && inQuotes && next === '"') {
      cell += '"';
      index += 1;
    } else if (char === '"') {
      inQuotes = !inQuotes;
    } else if (char === "," && !inQuotes) {
      row.push(cell);
      cell = "";
    } else if ((char === "\n" || char === "\r") && !inQuotes) {
      if (char === "\r" && next === "\n") index += 1;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
    } else {
      cell += char;
    }
  }

  row.push(cell);
  rows.push(row);
  return rows;
}

function rowToRecord(headers: string[], row: string[]): Record<string, string> {
  const record: Record<string, string> = {};
  headers.forEach((header, index) => {
    record[header] = (row[index] || "").trim();
  });
  return record;
}

function normalizeHeader(header: string): string {
  return header
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "-");
}

function normalizeHoldingQuality(flag: string): string {
  return flag;
}

function oneOf(record: Record<string, string>, keys: string[], fallback = ""): string {
  for (const key of keys) {
    const normalizedKey = normalizeHeader(key);
    const value = record[key] || record[normalizedKey] || "";
    if (value.length > 0) return value;
  }
  return fallback;
}

function optionalOneOf(record: Record<string, string>, keys: string[]): string | undefined {
  const value = oneOf(record, keys);
  return value.length > 0 ? value : undefined;
}

function isBlankRecord(record: Record<string, string>): boolean {
  return Object.values(record).every((value) => value.length === 0);
}

function firstAsOf(records: Array<Record<string, string>>): string | undefined {
  const matched = records.find((record) => Boolean(oneOf(record, ["as-of", "asof", "as_of", "date"])));
  if (!matched) {
    return undefined;
  }
  return oneOf(matched, ["as-of", "asof", "as_of", "date"]);
}

function cashBalanceType(value: string): CashBalance["balanceType"] {
  const normalized = value.toLowerCase();
  if (normalized === "available") return "available";
  if (normalized === "buying power" || normalized === "buying-power") return "buying-power";
  if (normalized === "margin") return "margin";
  if (normalized === "withheld") return "withheld";
  if (normalized === "unknown") return "unknown";
  return "settled";
}

function normalizeAssetType(raw: string): PortfolioHolding["assetType"] {
  const normalized = raw.toLowerCase();
  if (["stock", "etf", "fund", "cash-equivalent", "option", "bond", "crypto"].includes(normalized)) {
    return normalized as PortfolioHolding["assetType"];
  }
  return "stock";
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

const PRE_FLIGHT_RULES = {
  sourceTypeRules: {
    "manual-csv": {
      requiredColumns: ["row-type"],
      numericColumns: [
        "quantity",
        "average-cost",
        "cost-basis",
        "market-value",
        "amount",
        "price",
        "unrealized-pnl",
        "unrealized-pnl-percent"
      ],
      symbolColumns: ["symbol", "ticker", "sec", "security"],
      currencyColumns: ["currency", "ccy"],
      dateColumns: ["trade-date", "tradeDate", "trade_date", "as-of", "asof", "as_of", "date"],
      minRows: 1,
      maxRows: 5000
    },
    "csv-cash-snapshot": {
      requiredColumns: ["row-type"],
      numericColumns: ["quantity", "average-cost", "cost-basis", "market-value", "amount", "price", "unrealized-pnl", "unrealized-pnl-percent"],
      symbolColumns: ["symbol", "ticker", "sec", "security"],
      currencyColumns: ["currency", "ccy"],
      dateColumns: ["trade-date", "tradeDate", "trade_date", "as-of", "asof", "as_of", "date"],
      minRows: 1,
      maxRows: 5000
    },
    "statement-import": {
      requiredColumns: ["row-type"],
      numericColumns: ["quantity", "average-cost", "cost-basis", "market-value", "amount", "price", "unrealized-pnl", "unrealized-pnl-percent"],
      symbolColumns: ["symbol", "ticker", "sec", "security"],
      currencyColumns: ["currency", "ccy"],
      dateColumns: ["trade-date", "tradeDate", "trade_date", "as-of", "asof", "as_of", "date"],
      minRows: 1,
      maxRows: 5000
    },
    "partial-activity-only-import": {
      requiredColumns: ["row-type"],
      numericColumns: ["quantity", "average-cost", "cost-basis", "market-value", "amount", "price", "unrealized-pnl", "unrealized-pnl-percent"],
      symbolColumns: ["symbol", "ticker", "sec", "security"],
      currencyColumns: ["currency", "ccy"],
      dateColumns: ["trade-date", "tradeDate", "trade_date", "as-of", "asof", "as_of", "date"],
      minRows: 1,
      maxRows: 5000
    }
  },
  normalizeHeaders: true,
  allowedExtensions: [".csv"],
  allowedCurrencies: ["USD", "TWD", "EUR", "GBP", "JPY", "HKD", "CNY"],
  maxRows: 5000
};
