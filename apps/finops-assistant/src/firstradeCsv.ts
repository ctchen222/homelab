import { readFileSync } from "node:fs";
import {
  ActivityRow,
  BrokerAdapterDescriptor,
  BrokerImportRequest,
  BrokerImporter,
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
import { validateCsvImportPreflight } from "./importValidation";

type ReadFile = (path: string) => string;

export interface FirstradeCsvImporterOptions {
  adapterId?: string;
  brokerId?: string;
  readFile?: ReadFile;
  retainRawImport?: boolean;
  importHistoryStore?: ImportHistoryStore;
}

interface ParsedFirstradeCsv {
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

type FirstradeActivitySourceType = "statement-import" | "transaction-history" | "prior-year-gain-loss";
type FirstradeCsvSourceType = "csv-current-position-snapshot" | "csv-cash-snapshot" | FirstradeActivitySourceType;

const FIRSTRADE_SOURCE_TYPES: FirstradeCsvSourceType[] = [
  "csv-current-position-snapshot",
  "csv-cash-snapshot",
  "statement-import",
  "transaction-history",
  "prior-year-gain-loss"
];

export function createFirstradeCsvImporter(options: FirstradeCsvImporterOptions = {}): BrokerImporter {
  const readFile = options.readFile || ((path: string) => String(readFileSync(path, "utf8")));
  const retainRawImportDefault = options.retainRawImport || false;
  const importHistoryStore = options.importHistoryStore || defaultImportHistoryStore;
  const descriptor: BrokerAdapterDescriptor = {
    adapterId: options.adapterId || "firstrade-csv",
    brokerId: options.brokerId || "firstrade",
    displayName: "Firstrade CSV/Statement Importer",
    kind: "csv-importer",
    supportedSourceTypes: [
      "csv-current-position-snapshot",
      "csv-cash-snapshot",
      "transaction-history",
      "prior-year-gain-loss",
      "statement-import"
    ],
    supportedMarkets: ["NYSE", "NASDAQ", "NYSEARCA"],
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
      if (request.mode !== "csv-import") {
        return {
          ok: false,
          status: "rejected",
          errorClass: "unsafe-input",
          reason: "Firstrade importer only supports csv-import mode."
        };
      }

      if (!descriptor.supportedSourceTypes.includes(request.sourceType)) {
        return {
          ok: false,
          status: "rejected",
          errorClass: "schema-mismatch",
          reason: `Unsupported Firstrade source type: ${request.sourceType}`
        };
      }
      if (!isFirstradeSourceType(request.sourceType)) {
        return {
          ok: false,
          status: "rejected",
          errorClass: "schema-mismatch",
          reason: `Unsupported Firstrade source type: ${request.sourceType}`
        };
      }

      const preflight = validateCsvImportPreflight(request, readFile, PRE_FLIGHT_RULES);
      if (!preflight.ok) {
        return preflight;
      }

      return { ok: true, status: "succeeded" };
    },
    previewImport: (request) => {
      if (!isFirstradeSourceType(request.sourceType)) {
        throw new Error(`Unsupported Firstrade source type: ${request.sourceType}`);
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
        throw new Error(`Invalid Firstrade import request: ${preflight.reason}`);
      }

      const parsed = parseFirstradeCsv(
        readFile(request.filePath),
        request.sourceType,
        descriptor.brokerId,
        request.accountAlias,
        request.requestedAt
      );
      return buildPreview(request, parsed, checksum);
    },
    commitImport: (request) => {
      if (!request.ownerApproved) {
        throw new Error("Firstrade CSV import requires owner approval before commit.");
      }
      if (!isFirstradeSourceType(request.sourceType)) {
        throw new Error(`Unsupported Firstrade source type: ${request.sourceType}`);
      }

      const preflight = validateCsvImportPreflight(request, readFile, PRE_FLIGHT_RULES);
      if (!preflight.ok) {
        throw new Error(`Invalid Firstrade import request: ${preflight.reason}`);
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

      const parsed = parseFirstradeCsv(
        readFile(request.filePath),
        request.sourceType,
        descriptor.brokerId,
        request.accountAlias,
        request.requestedAt
      );
      const snapshot = buildSnapshot(descriptor, { ...request, checksum }, parsed);
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
    status: snapshot.sourceFreshness.status === "failed" ? "rejected" : snapshot.sourceFreshness.status === "fresh" ? "accepted" : "partial",
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

function buildPreview(request: BrokerImportRequest, parsed: ParsedFirstradeCsv, checksum: string): ImportPreview {
  const status =
    request.sourceType === "transaction-history" || request.sourceType === "prior-year-gain-loss" || request.sourceType === "statement-import"
      ? "partial"
      : parsed.missingFields.length > 0
        ? "partial"
        : "accepted";

  return {
    accountAlias: request.accountAlias,
    sourceType: request.sourceType,
    sourceTimestamp: parsed.sourceTimestamp,
    dateRange: parsed.dateRange,
    checksum,
    status,
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
  parsed: ParsedFirstradeCsv
): SnapshotEnvelope {
  let status: SourceFreshness["status"] = "fresh";
  const missingFields = [...parsed.missingFields];

  if (request.sourceType === "transaction-history" || request.sourceType === "prior-year-gain-loss" || request.sourceType === "statement-import") {
    status = "partial";
  }

  if (missingFields.length > 0) {
    status = "partial";
  }

  return {
    schemaVersion: SNAPSHOT_SCHEMA_VERSION,
    syncRunId: `firstrade-csv-${request.accountAlias}-${request.sourceType}-${request.checksum}`,
    brokerId: descriptor.brokerId,
    account: {
      brokerId: descriptor.brokerId,
      accountAlias: request.accountAlias,
      accountIdentityHash: `firstrade-csv:${request.accountAlias}`,
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
      reason: status === "partial" ? sourcePartialReason(request.sourceType, missingFields.length > 0) : undefined,
      missingFields
    },
    baseCurrency: "USD",
    asOf: parsed.sourceTimestamp,
    holdings: request.sourceType === "csv-current-position-snapshot" || request.sourceType === "statement-import" ? parsed.holdings : [],
    cashBalances: request.sourceType === "csv-cash-snapshot" || request.sourceType === "statement-import" ? parsed.cashBalances : [],
    activityRows:
      request.sourceType === "transaction-history" || request.sourceType === "prior-year-gain-loss" || request.sourceType === "statement-import"
        ? parsed.activityRows
        : [],
    errors: [],
    dataQuality: missingFields
  };
}

function isFirstradeSourceType(value: BrokerImportRequest["sourceType"]): value is FirstradeCsvSourceType {
  return FIRSTRADE_SOURCE_TYPES.includes(value as FirstradeCsvSourceType);
}

function sourcePartialReason(sourceType: string, hasMissingFields: boolean): string {
  if (sourceType === "transaction-history" || sourceType === "prior-year-gain-loss" || sourceType === "statement-import") {
    return "Firstrade transaction-based exports are activity-only and do not prove full current holdings.";
  }
  if (hasMissingFields) {
    return "Firstrade export is missing one or more normalized fields.";
  }
  return "Firstrade import is partially normalized.";
}

function parseFirstradeCsv(
  content: string,
  sourceType: FirstradeCsvSourceType,
  brokerId: string,
  accountAlias: string,
  fallbackAsOf: string
): ParsedFirstradeCsv {
  const rows = parseCsv(content).filter((row) => row.some((cell) => cell.trim().length > 0));
  if (rows.length === 0) {
    return {
      holdings: [],
      cashBalances: [],
      activityRows: [],
      sourceTimestamp: fallbackAsOf,
      missingFields: ["csv.rows"],
      skippedRows: 0
    };
  }

  const headers = rows[0].map((header) => normalizeHeader(header));
  const records = rows.slice(1).map((row) => rowToRecord(headers, row));
  const holdings: PortfolioHolding[] = [];
  const cashBalances: CashBalance[] = [];
  const activityRows: ActivityRow[] = [];
  const missingFields: string[] = [];
  const dates: string[] = [];
  let skippedRows = 0;

  records.forEach((record, index) => {
    if (isBlankRecord(record)) {
      skippedRows += 1;
      return;
    }

    if (sourceType === "csv-current-position-snapshot") {
      const holding = positionRecordToHolding(record, brokerId, accountAlias, fallbackAsOf);
      if (holding.symbol && holding.quantity) {
        holdings.push(holding);
      } else {
        skippedRows += 1;
      }
      missingFields.push(...holding.dataQuality.map(missingHoldingFieldToOutput));
      const sourceDate = oneOf(record, ["as-of", "asof", "as_of", "date", "trade-date"], "");
      if (sourceDate) {
        dates.push(sourceDate);
      }
      return;
    }

    if (sourceType === "csv-cash-snapshot") {
      const cash = cashRecordToBalance(record, brokerId, accountAlias, fallbackAsOf);
      if (!cash.dataQuality.includes("cash-balance-missing-amount")) {
        cashBalances.push(cash);
      } else {
        skippedRows += 1;
      }
      if (cash.dataQuality.length > 0) missingFields.push(...cash.dataQuality);
      const sourceDate = oneOf(record, ["as-of", "asof", "as_of", "date"], "");
      if (sourceDate) {
        dates.push(sourceDate);
      }
      return;
    }

    const activity = activityRecordToActivityRow(record, sourceType, brokerId, accountAlias, fallbackAsOf, index);
    if (activity.activityType) {
      activityRows.push(activity);
    } else {
      skippedRows += 1;
    }
    if (activity.dataQuality.length > 0) missingFields.push(...activity.dataQuality);

    const sourceDate = oneOf(record, ["trade-date", "tradeDate", "trade_date", "as-of", "asof", "as_of", "date"], "");
    if (sourceDate) {
      dates.push(sourceDate);
    }
  });

  return {
    holdings,
    cashBalances,
    activityRows,
    sourceTimestamp: firstAsOf(records) || fallbackAsOf,
    missingFields: unique(missingFields),
    dateRange: parseDateRange(dates),
    skippedRows
  };
}

function positionRecordToHolding(
  record: Record<string, string>,
  brokerId: string,
  accountAlias: string,
  fallbackAsOf: string
): PortfolioHolding {
  const providerSymbol = optionalOneOf(record, ["provider-symbol", "providerSymbol", "broker-symbol"]);
  const securityName = optionalOneOf(record, ["name", "security-name", "description", "holding"]);
  const holding: PortfolioHolding = {
    brokerId,
    accountAlias,
    market: oneOf(record, ["market", "exchange", "marketplace"], "NYSE"),
    symbol: sanitizeFormulaLikeText(oneOf(record, ["symbol", "ticker", "sec", "security", "symbolticker"])),
    providerSymbol: providerSymbol ? sanitizeFormulaLikeText(providerSymbol) : undefined,
    securityName: securityName ? sanitizeFormulaLikeText(securityName) : undefined,
    assetType: normalizeAssetType(oneOf(record, ["asset-type", "assetType", "type"], "stock")),
    currency: oneOf(record, ["currency", "ccy"], "USD"),
    quantity: optionalOneOf(record, ["quantity", "qty", "shares", "size"]) || "0",
    averageCost: optionalOneOf(record, ["average-cost", "averagecost", "averageCost", "avg-cost", "avgCost"]),
    costBasis: optionalOneOf(record, ["cost-basis", "costbasis", "costBasis", "baseCost"]),
    lastPrice: optionalOneOf(record, ["last-price", "lastprice", "price", "last"]),
    marketValue: optionalOneOf(record, ["market-value", "marketvalue", "marketValue", "value"]),
    unrealizedPnl: optionalOneOf(record, ["unrealized-pl", "unrealizedpnl", "unrealizedPnl", "pl"]),
    unrealizedPnlPercent: optionalOneOf(record, ["unrealized-pl-percent", "unrealizedPnlPercent", "unrealized-pct", "unrealizedpct"]),
    asOf: oneOf(record, ["as-of", "asof", "as_of", "snapshot-date", "date", "trade-date"], fallbackAsOf),
    freshnessStatus: "fresh",
    dataQuality: []
  };

  holding.dataQuality = missingHoldingFields(holding);
  if (holding.dataQuality.length > 0) holding.freshnessStatus = "partial";
  return holding;
}

function cashRecordToBalance(
  record: Record<string, string>,
  brokerId: string,
  accountAlias: string,
  fallbackAsOf: string
): CashBalance {
  const rawAmount = optionalOneOf(record, ["amount", "balance", "cash", "amount-available"]);
  const balanceType = cashBalanceType(oneOf(record, ["balance-type", "balancetype", "balance type", "type"], "settled"));
  const cashBalance: CashBalance = {
    brokerId,
    accountAlias,
    currency: oneOf(record, ["currency", "ccy"], "USD"),
    amount: rawAmount ?? "0",
    balanceType,
    asOf: oneOf(record, ["as-of", "asof", "as_of", "as-of-date", "date"], fallbackAsOf),
    freshnessStatus: "fresh",
    dataQuality: []
  };

  if (rawAmount === undefined) cashBalance.dataQuality.push("cash-balance-missing-amount");
  if (!cashBalance.currency) cashBalance.dataQuality.push("cash-balance-missing-currency");
  if (cashBalance.dataQuality.length > 0) cashBalance.freshnessStatus = "partial";
  return cashBalance;
}

function activityRecordToActivityRow(
  record: Record<string, string>,
  sourceType: FirstradeActivitySourceType,
  brokerId: string,
  accountAlias: string,
  fallbackAsOf: string,
  index: number
): ActivityRow {
  const activityType = mapActivityType(oneOf(record, ["activity-type", "action", "type", "txnType", "transactionType"]));
  const row: ActivityRow = {
    brokerId,
    accountAlias,
    activityId: oneOf(record, ["activity-id", "activityId", "transaction-id", "id", "ref"], `${accountAlias}-${sourceType}-${index}`),
    activityType,
    tradeDate: optionalOneOf(record, ["trade-date", "tradeDate", "trade_date"]),
    settleDate: optionalOneOf(record, ["settle-date", "settleDate", "settle_date"]),
    market: optionalOneOf(record, ["market", "exchange"]),
    symbol: sanitizeFormulaLikeText(optionalOneOf(record, ["symbol", "ticker"]) || ""),
    currency: oneOf(record, ["currency", "ccy"], "USD"),
    quantity: optionalOneOf(record, ["quantity", "qty", "shares"]),
    price: optionalOneOf(record, ["price", "unit-price"]),
    amount: optionalOneOf(record, ["amount", "total", "proceeds"]),
    amountType: mapAmountType(oneOf(record, ["amount-type", "amountType", "type"], "unknown")),
    sourceDescription: sanitizeFormulaLikeText(optionalOneOf(record, ["description", "desc", "memo", "detail"]) || ""),
    asOf: oneOf(record, ["as-of", "asof", "as_of", "trade-date", "date"], fallbackAsOf),
    dataQuality: []
  };

  if (!row.activityType) row.dataQuality.push("activity-type-missing");
  if (!row.amount) row.dataQuality.push("activity-amount-missing");
  return row;
}

function mapActivityType(raw: string): ActivityRow["activityType"] {
  const normalized = raw.toLowerCase();
  if (normalized === "buy" || normalized === "purchase") return "buy";
  if (normalized === "sell") return "sell";
  if (normalized === "dividend") return "dividend";
  if (normalized === "interest") return "interest";
  if (normalized === "deposit" || normalized === "contribution") return "deposit";
  if (normalized === "withdrawal" || normalized === "withdraw") return "withdrawal";
  if (normalized === "fee") return "fee";
  if (normalized === "tax") return "tax";
  if (normalized === "split") return "split";
  if (normalized === "transfer") return "transfer";
  if (normalized === "gain-loss" || normalized === "gainloss" || normalized === "capital-gain") return "gain-loss";
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

function normalizeAssetType(raw: string): PortfolioHolding["assetType"] {
  const normalized = raw.toLowerCase();
  if (
    normalized === "stock" ||
    normalized === "etf" ||
    normalized === "fund" ||
    normalized === "cash-equivalent" ||
    normalized === "option" ||
    normalized === "bond" ||
    normalized === "crypto"
  ) {
    return normalized;
  }
  return "stock";
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

function missingHoldingFieldToOutput(flag: string): string {
  if (flag === "holdings.missing-symbol") return "holdings.symbol";
  if (flag === "holdings.missing-quantity") return "holdings.quantity";
  return flag;
}

function missingHoldingFields(holding: PortfolioHolding): string[] {
  const missing: string[] = [];
  if (!holding.symbol) missing.push("holdings.missing-symbol");
  if (!holding.quantity) missing.push("holdings.missing-quantity");
  if (!holding.averageCost) missing.push("holdings.averageCost");
  if (!holding.costBasis) missing.push("holdings.costBasis");
  if (!holding.marketValue) missing.push("holdings.marketValue");
  return missing;
}

function oneOf(record: Record<string, string>, keys: string[], fallback = ""): string {
  return normalizeOneOf(record, keys) || fallback;
}

function optionalOneOf(record: Record<string, string>, keys: string[]): string | undefined {
  const value = oneOf(record, keys);
  return value.length > 0 ? value : undefined;
}

function normalizeOneOf(record: Record<string, string>, keys: string[]): string {
  for (const key of keys) {
    const value = record[key] || record[normalizeHeader(key)] || "";
    if (value.length > 0) return value;
  }
  return "";
}

function isBlankRecord(record: Record<string, string>): boolean {
  return Object.values(record).every((value) => value.length === 0);
}

function firstAsOf(records: Array<Record<string, string>>): string | undefined {
  const record = records.find((row) => Boolean(oneOf(row, ["as-of", "asof", "as_of", "date", "trade-date"])));
  if (!record) return undefined;
  return oneOf(record, ["as-of", "asof", "as_of", "date", "trade-date"]);
}

function cashBalanceType(value: string): CashBalance["balanceType"] {
  const normalized = value.toLowerCase();
  if (
    normalized === "available" ||
    normalized === "buying-power" ||
    normalized === "buying power" ||
    normalized === "margin" ||
    normalized === "withheld" ||
    normalized === "unknown"
  ) {
    return normalized === "buying power" ? "buying-power" : normalized;
  }
  return "settled";
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

const PRE_FLIGHT_RULES = {
  sourceTypeRules: {
    "csv-current-position-snapshot": {
      requiredColumns: ["symbol", "quantity"],
      numericColumns: [
        "quantity",
        "average-cost",
        "cost-basis",
        "last-price",
        "market-value",
        "unrealized-pl",
        "unrealized-pl-percent",
        "price",
        "amount"
      ],
      symbolColumns: ["symbol", "ticker", "sec", "security", "symbolticker"],
      currencyColumns: ["currency", "ccy"],
      dateColumns: ["as-of", "asof", "as_of", "snapshot-date", "date", "trade-date"],
      minRows: 1,
      maxRows: 5000
    },
    "csv-cash-snapshot": {
      requiredColumns: ["currency", "type"],
      numericColumns: ["amount", "balance"],
      currencyColumns: ["currency", "ccy"],
      dateColumns: ["as-of", "asof", "as_of", "date"]
    },
    "transaction-history": {
      requiredColumns: ["action", "amount"],
      numericColumns: ["quantity", "price", "amount", "total", "proceeds"],
      symbolColumns: ["symbol", "ticker"],
      currencyColumns: ["currency", "ccy"],
      dateColumns: ["trade-date", "tradeDate", "trade_date", "as-of", "asof", "as_of", "date"]
    },
    "prior-year-gain-loss": {
      requiredColumns: ["action", "amount"],
      numericColumns: ["amount"],
      symbolColumns: ["symbol", "ticker"],
      currencyColumns: ["currency", "ccy"],
      dateColumns: ["trade-date", "tradeDate", "trade_date", "as-of", "asof", "as_of", "date"]
    },
    "statement-import": {
      requiredColumns: ["action", "amount"],
      numericColumns: ["amount"],
      symbolColumns: ["symbol", "ticker"],
      currencyColumns: ["currency", "ccy"],
      dateColumns: ["trade-date", "tradeDate", "trade_date", "as-of", "asof", "as_of", "date"]
    }
  },
  normalizeHeaders: true,
  allowedExtensions: [".csv"],
  allowedCurrencies: ["USD", "TWD", "EUR", "GBP", "JPY", "HKD", "CNY"],
  maxRows: 5000
};
