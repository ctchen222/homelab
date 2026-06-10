import { readFileSync } from "node:fs";
import {
  BrokerAdapterDescriptor,
  BrokerImportRequest,
  BrokerImporter,
  CashBalance,
  ImportPreview,
  PortfolioHolding,
  SNAPSHOT_SCHEMA_VERSION,
  SnapshotEnvelope,
  SourceFreshness,
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

export interface SinoPacCsvImporterOptions {
  adapterId?: string;
  brokerId?: string;
  readFile?: ReadFile;
  retainRawImport?: boolean;
  importHistoryStore?: ImportHistoryStore;
}

interface ParsedSinoPacCsv {
  holdings: PortfolioHolding[];
  cashBalances: CashBalance[];
  sourceTimestamp: string;
  dateRange?: {
    from: string;
    to: string;
  };
  missingFields: string[];
  skippedRows: number;
}

const PRE_FLIGHT_RULES = {
  sourceTypeRules: {
    "csv-current-position-snapshot": {
      requiredColumns: ["type", "symbol", "quantity"],
      numericColumns: ["quantity", "averageCost", "costBasis", "marketValue", "lastPrice", "unrealizedPnl", "unrealizedPnlPercent", "amount"],
      symbolColumns: ["symbol", "providerSymbol"],
      currencyColumns: ["currency"],
      dateColumns: ["asOf", "as-of", "asof", "date"],
      minRows: 1,
      maxRows: 5000
    },
    "csv-cash-snapshot": {
      requiredColumns: ["type", "amount"],
      numericColumns: ["amount"],
      currencyColumns: ["currency"],
      dateColumns: ["asOf", "as-of", "asof", "date"],
      minRows: 1,
      maxRows: 5000
    }
  },
  normalizeHeaders: false,
  allowedExtensions: [".csv"],
  allowedCurrencies: ["USD", "TWD", "EUR", "GBP", "JPY", "HKD", "CNY"],
  maxRows: 5000
};

export function createSinoPacCsvImporter(options: SinoPacCsvImporterOptions = {}): BrokerImporter {
  const readFile = options.readFile || ((path: string) => String(readFileSync(path, "utf8")));
  const retainRawImportDefault = options.retainRawImport || false;
  const importHistoryStore = options.importHistoryStore || defaultImportHistoryStore;
  const descriptor: BrokerAdapterDescriptor = {
    adapterId: options.adapterId || "sinopac-csv",
    brokerId: options.brokerId || "sinopac",
    displayName: "SinoPac CSV Importer",
    kind: "csv-importer",
    supportedSourceTypes: ["csv-current-position-snapshot", "csv-cash-snapshot"],
    supportedMarkets: ["TWSE", "TPEx"],
    supportsHoldings: true,
    supportsCash: true,
    supportsActivity: false,
    supportsCostBasis: true,
    credentialMode: "owner-upload",
    productionStatus: "import-only"
  };

  const preflight = (request: BrokerImportRequest): ReturnType<typeof validateCsvImportPreflight> => {
    if (request.mode !== "csv-import") {
      return {
        ok: false,
        status: "rejected",
        errorClass: "unsafe-input",
        reason: "SinoPac CSV importer only supports csv-import mode."
      };
    }

    if (!descriptor.supportedSourceTypes.includes(request.sourceType)) {
      return {
        ok: false,
        status: "rejected",
        errorClass: "schema-mismatch",
        reason: `Unsupported SinoPac CSV source type: ${request.sourceType}`
      };
    }

    return validateCsvImportPreflight(request, readFile, PRE_FLIGHT_RULES);
  };

  return {
    describe: () => descriptor,
    preflight,
    previewImport: (request) => {
      if (!descriptor.supportedSourceTypes.includes(request.sourceType)) {
        throw new Error(`Unsupported SinoPac source type: ${request.sourceType}`);
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

      const checked = preflight(request);
      if (!checked.ok) {
        throw new Error(`Invalid SinoPac import request: ${checked.reason}`);
      }

      const parsed = parseSinoPacCsv(readFile(request.filePath), descriptor.brokerId, request);
      return buildPreview(request, parsed, checksum);
    },
    commitImport: (request) => {
      if (!request.ownerApproved) {
        throw new Error("SinoPac CSV import requires owner approval before commit.");
      }

      if (!descriptor.supportedSourceTypes.includes(request.sourceType)) {
        throw new Error(`Unsupported SinoPac source type: ${request.sourceType}`);
      }

      const checked = preflight(request);
      if (!checked.ok) {
        throw new Error(`Invalid SinoPac import request: ${checked.reason}`);
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

      const parsed = parseSinoPacCsv(readFile(request.filePath), descriptor.brokerId, request);
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
    status: snapshot.sourceFreshness.status === "fresh" ? "accepted" : "partial",
    missingFields: snapshot.sourceFreshness.missingFields,
    rowCounts: {
      accounts: 1,
      holdings: snapshot.holdings.length,
      cashBalances: snapshot.cashBalances.length,
      activityRows: 0,
      skippedRows: 0,
      errors: snapshot.errors.length
    }
  };
}

function buildPreview(request: BrokerImportRequest, parsed: ParsedSinoPacCsv, checksum: string): ImportPreview {
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
      activityRows: 0,
      skippedRows: parsed.skippedRows,
      errors: 0
    }
  };
}

function buildSnapshot(
  descriptor: BrokerAdapterDescriptor,
  request: BrokerImportRequest & { checksum: string },
  parsed: ParsedSinoPacCsv
): SnapshotEnvelope {
  const status: SourceFreshness["status"] = parsed.missingFields.length > 0 ? "partial" : "fresh";

  return {
    schemaVersion: SNAPSHOT_SCHEMA_VERSION,
    syncRunId: `sinopac-csv-${request.accountAlias}-${request.sourceType}-${request.checksum}`,
    brokerId: descriptor.brokerId,
    account: {
      brokerId: descriptor.brokerId,
      accountAlias: request.accountAlias,
      accountIdentityHash: `sinopac-csv:${request.accountAlias}`,
      accountType: "tw-stock",
      baseCurrency: "TWD",
      marketScope: ["TWSE", "TPEx"],
      displayName: "SinoPac CSV Account",
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
      reason: status === "partial" ? "SinoPac CSV import is missing optional normalized fields." : undefined,
      missingFields: parsed.missingFields
    },
    baseCurrency: "TWD",
    asOf: parsed.sourceTimestamp,
    holdings: parsed.holdings,
    cashBalances: parsed.cashBalances,
    activityRows: [],
    errors: [],
    dataQuality: parsed.missingFields.length > 0 ? ["sinopac-csv-partial"] : []
  };
}

function parseSinoPacCsv(content: string, brokerId: string, request: BrokerImportRequest): ParsedSinoPacCsv {
  const rows = parseCsv(content).filter((row) => row.some((cell) => cell.trim().length > 0));
  if (rows.length === 0) {
    return {
      holdings: [],
      cashBalances: [],
      sourceTimestamp: request.requestedAt,
      dateRange: {
        from: request.requestedAt,
        to: request.requestedAt
      },
      missingFields: ["csv.rows"],
      skippedRows: 0
    };
  }

  const headers = rows[0].map((header) => header.trim());
  const records = rows.slice(1).map((row) => rowToRecord(headers, row));
  const holdings: PortfolioHolding[] = [];
  const cashBalances: CashBalance[] = [];
  const missingFields: string[] = [];
  const dates: string[] = [];
  let skippedRows = 0;

  for (const record of records) {
    const rowType = value(record, "type").toLowerCase();
    if (rowType === "position") {
      const holding = positionRecordToHolding(record, brokerId, request.accountAlias, request.requestedAt);
      holdings.push(holding);
      missingFields.push(...holding.dataQuality.map(dataQualityToField));
      const sourceDate = oneOf(record, ["asOf", "as-of", "asof", "date"], "");
      if (sourceDate) dates.push(sourceDate);
    } else if (rowType === "cash") {
      const cash = cashRecordToBalance(record, brokerId, request.accountAlias, request.requestedAt);
      cashBalances.push(cash);
      const sourceDate = oneOf(record, ["asOf", "as-of", "asof", "date"], "");
      if (sourceDate) dates.push(sourceDate);
    } else {
      skippedRows += 1;
    }
  }

  return {
    holdings,
    cashBalances,
    sourceTimestamp: firstAsOf(records) || request.requestedAt,
    dateRange: parseDateRange(dates),
    missingFields: unique(missingFields),
    skippedRows
  };
}

function positionRecordToHolding(
  record: Record<string, string>,
  brokerId: string,
  accountAlias: string,
  fallbackAsOf: string
): PortfolioHolding {
  const holding: PortfolioHolding = {
    brokerId,
    accountAlias,
    market: oneOf(record, ["market"], "TWSE"),
    symbol: sanitizeFormulaLikeText(value(record, "symbol")),
      providerSymbol: value(record, "providerSymbol") ? sanitizeFormulaLikeText(value(record, "providerSymbol")) : value(record, "symbol"),
      securityName: oneOf(record, ["name", "securityName", "security-name"]) ? sanitizeFormulaLikeText(oneOf(record, ["name", "securityName", "security-name"])) : undefined,
    assetType: "stock",
    currency: value(record, "currency") || "TWD",
    quantity: value(record, "quantity"),
    averageCost: optionalValue(record, "averageCost"),
    costBasis: optionalValue(record, "costBasis"),
    lastPrice: optionalValue(record, "lastPrice"),
    marketValue: optionalValue(record, "marketValue"),
    unrealizedPnl: optionalValue(record, "unrealizedPnl"),
    unrealizedPnlPercent: optionalValue(record, "unrealizedPnlPercent"),
    asOf: oneOf(record, ["asOf", "as-of", "asof", "date"], fallbackAsOf),
    freshnessStatus: "fresh",
    dataQuality: []
  };

  holding.dataQuality = missingHoldingFields(holding);
  if (holding.dataQuality.length > 0) holding.freshnessStatus = "partial";
  return holding;
}

function cashRecordToBalance(record: Record<string, string>, brokerId: string, accountAlias: string, fallbackAsOf: string): CashBalance {
  return {
    brokerId,
    accountAlias,
    currency: value(record, "currency") || "TWD",
    amount: value(record, "amount"),
    balanceType: cashBalanceType(value(record, "balanceType")),
    asOf: oneOf(record, ["asOf", "as-of", "asof", "date"], fallbackAsOf),
    freshnessStatus: "fresh",
    dataQuality: []
  };
}

function parseCsv(content: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let inQuotes = false;

  for (let index = 0; index < content.length; index += 1) {
    const char = content[index];
    const next = content[index + 1];
    if (char === "\"" && inQuotes && next === "\"") {
      cell += "\"";
      index += 1;
    } else if (char === "\"") {
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

function value(record: Record<string, string>, key: string): string {
  return record[key] || "";
}

function oneOf(record: Record<string, string>, keys: string[], fallback = ""): string {
  for (const key of keys) {
    const field = value(record, key);
    if (field.length > 0) return field;
  }
  return fallback;
}

function optionalValue(record: Record<string, string>, key: string): string | undefined {
  const field = value(record, key);
  return field.length > 0 ? field : undefined;
}

function firstAsOf(records: Array<Record<string, string>>): string | undefined {
  const matched = records.find((record) => Boolean(oneOf(record, ["asOf", "as-of", "asof", "date"])));
  if (!matched) return undefined;
  return oneOf(matched, ["asOf", "as-of", "asof", "date"]);
}

function cashBalanceType(value: string): CashBalance["balanceType"] {
  if (value === "available" || value === "buying-power" || value === "margin" || value === "withheld" || value === "unknown") {
    return value;
  }
  return "settled";
}

function missingHoldingFields(holding: PortfolioHolding): string[] {
  const missing: string[] = [];
  if (!holding.symbol) missing.push("missing-symbol");
  if (!holding.quantity) missing.push("missing-quantity");
  if (!holding.averageCost) missing.push("missing-average-cost");
  if (!holding.costBasis) missing.push("missing-cost-basis");
  if (!holding.marketValue) missing.push("missing-market-value");
  return missing;
}

function dataQualityToField(flag: string): string {
  if (flag === "missing-symbol") return "holdings.symbol";
  if (flag === "missing-quantity") return "holdings.quantity";
  if (flag === "missing-average-cost") return "holdings.averageCost";
  if (flag === "missing-cost-basis") return "holdings.costBasis";
  if (flag === "missing-market-value") return "holdings.marketValue";
  return flag;
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}
