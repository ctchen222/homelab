import { BrokerImportRequest, BrokerPreflightResult } from "./portfolioSync";

interface CsvImportRule {
  requiredColumns: string[];
  numericColumns?: string[];
  symbolColumns?: string[];
  currencyColumns?: string[];
  dateColumns?: string[];
  minRows?: number;
  maxRows?: number;
}

export interface CsvImportPreflightOptions {
  sourceTypeRules: Record<string, CsvImportRule>;
  allowedExtensions?: readonly string[];
  accountAliasPattern?: RegExp;
  normalizeHeaders?: boolean;
  allowedCurrencies?: string[];
  maxRows?: number;
  minRows?: number;
  maxAgeDays?: number;
  symbolPattern?: RegExp;
  delimiter?: "," | ";";
}

export interface CsvImportPreflightValidationResult extends BrokerPreflightResult {
  sourceTimestamp?: string;
}

const DEFAULT_ACCOUNT_ALIAS = /^[A-Za-z0-9._-]{1,64}$/;
const DEFAULT_SYMBOL = /^[A-Z0-9._-]{1,16}$/i;
const DEFAULT_OPTIONS = {
  allowedExtensions: [".csv"],
  allowedCurrencies: ["USD", "TWD", "JPY", "EUR", "GBP", "HKD", "CNY"],
  maxRows: 5000,
  minRows: 1,
  maxAgeDays: 3650,
  symbolPattern: DEFAULT_SYMBOL,
  delimiter: ","
} as const;

export function validateCsvImportPreflight(
  request: BrokerImportRequest,
  readFile: (path: string) => string,
  options: CsvImportPreflightOptions
): CsvImportPreflightValidationResult {
  const normalizedOptions = {
    ...DEFAULT_OPTIONS,
    ...options,
    accountAliasPattern: options.accountAliasPattern || DEFAULT_ACCOUNT_ALIAS
  };

  const rule = options.sourceTypeRules[request.sourceType];
  if (!rule) {
    return {
      ok: false,
      status: "rejected",
      errorClass: "schema-mismatch",
      reason: `Unsupported import source type: ${request.sourceType}`
    };
  }

  if (!normalizedOptions.accountAliasPattern.test(request.accountAlias)) {
    return {
      ok: false,
      status: "rejected",
      errorClass: "unsafe-input",
      reason: `Invalid accountAlias: ${request.accountAlias}`
    };
  }

  const extension = getPathExtension(request.filePath);
  if (!normalizedOptions.allowedExtensions.includes(extension)) {
    return {
      ok: false,
      status: "rejected",
      errorClass: "schema-mismatch",
      reason: `Unsupported import file extension: ${extension || "none"}`
    };
  }

  if (request.filePath.includes("\0") || request.filePath.includes("..")) {
    return {
      ok: false,
      status: "rejected",
      errorClass: "unsafe-input",
      reason: "Import file path is unsafe."
    };
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

  if (content.includes("\u0000")) {
    return {
      ok: false,
      status: "rejected",
      errorClass: "unsafe-input",
      reason: "Import file appears to contain non-text content."
    };
  }

  if (!content.includes(normalizedOptions.delimiter)) {
    return {
      ok: false,
      status: "rejected",
      errorClass: "schema-mismatch",
      reason: `Unsupported import delimiter. Expected '${normalizedOptions.delimiter}'.`
    };
  }

  const rows = parseCsv(content).filter((row) => row.some((cell) => cell.trim().length > 0));
  if (rows.length < 2) {
    return {
      ok: false,
      status: "rejected",
      errorClass: "schema-mismatch",
      reason: "Import file is empty or has no data rows."
    };
  }

  const minRows = rule.minRows ?? normalizedOptions.minRows;
  const maxRows = rule.maxRows ?? normalizedOptions.maxRows;
  if (rows.length - 1 < minRows) {
    return {
      ok: false,
      status: "rejected",
      errorClass: "schema-mismatch",
      reason: `Import file has too few rows: ${rows.length - 1}`
    };
  }
  if (rows.length - 1 > maxRows) {
    return {
      ok: false,
      status: "rejected",
      errorClass: "unsafe-input",
      reason: `Import file row limit exceeded: ${rows.length - 1} > ${maxRows}`
    };
  }

  const headers = normalizeHeaderRow(rows[0], normalizedOptions.normalizeHeaders);
  if (headers.length === 0) {
    return {
      ok: false,
      status: "rejected",
      errorClass: "schema-mismatch",
      reason: "Import file is missing a header row."
    };
  }

  const requiredHeaders = rule.requiredColumns.map((header) => normalizeHeaderName(header, normalizedOptions.normalizeHeaders));
  const missingHeaders = requiredHeaders.filter((required) => !headers.includes(required));
  if (missingHeaders.length > 0) {
    return {
      ok: false,
      status: "rejected",
      errorClass: "schema-mismatch",
      reason: `Missing required headers: ${missingHeaders.join(", ")}`
    };
  }

  const records = rows.slice(1).map((row) => rowToRecord(headers, row));

  for (const record of records) {
    const badHeader = invalidRecord(
      record,
      rule,
      normalizedOptions.normalizeHeaders,
      normalizedOptions.allowedCurrencies,
      normalizedOptions.symbolPattern,
      normalizedOptions.maxAgeDays,
      request.requestedAt
    );
    if (badHeader) return badHeader;
  }

  return {
    ok: true,
    status: "succeeded",
    sourceTimestamp: firstDate(records, rule.dateColumns, normalizedOptions.normalizeHeaders)
  };
}

function getPathExtension(filePath: string): string {
  const index = Math.max(filePath.lastIndexOf("/"), filePath.lastIndexOf("\\"));
  if (index === -1) {
    const dotIndex = filePath.lastIndexOf(".");
    return dotIndex === -1 ? "" : filePath.slice(dotIndex).toLowerCase();
  }
  const fileName = filePath.slice(index + 1);
  const dotIndex = fileName.lastIndexOf(".");
  return dotIndex === -1 ? "" : fileName.slice(dotIndex).toLowerCase();
}

function invalidRecord(
  record: Record<string, string>,
  rule: CsvImportRule,
  normalizeHeaders: boolean | undefined,
  allowedCurrencies: readonly string[],
  symbolPattern: RegExp,
  maxAgeDays: number,
  requestedAt: string
): BrokerPreflightResult | undefined {
  const numericColumns = rule.numericColumns || [];
  for (const field of numericColumns) {
    const value = record[normalizeHeaderName(field, normalizeHeaders)] ?? "";
    if (value && !isNumeric(value)) {
      return {
        ok: false,
        status: "rejected",
        errorClass: "schema-mismatch",
        reason: `Non-numeric value for ${field}: ${value}`
      };
    }
  }

  const symbolColumns = rule.symbolColumns || [];
  for (const field of symbolColumns) {
    const symbol = record[normalizeHeaderName(field, normalizeHeaders)] ?? "";
    if (!symbol) {
      continue;
    }
    if (!symbolPattern.test(symbol)) {
      return {
        ok: false,
        status: "rejected",
        errorClass: "schema-mismatch",
        reason: `Invalid symbol format: ${symbol}`
      };
    }
  }

  const currencyColumns = rule.currencyColumns || [];
  for (const field of currencyColumns) {
    const currency = record[normalizeHeaderName(field, normalizeHeaders)] ?? "";
    if (!currency) {
      continue;
    }
    if (!allowedCurrencies.includes(currency.toUpperCase())) {
      return {
        ok: false,
        status: "rejected",
        errorClass: "schema-mismatch",
        reason: `Unsupported currency: ${currency}`
      };
    }
  }

  const dateColumns = rule.dateColumns || [];
  for (const field of dateColumns) {
    const value = record[normalizeHeaderName(field, normalizeHeaders)] ?? "";
    if (!value) continue;
    const date = Date.parse(value);
    if (Number.isNaN(date)) {
      return {
        ok: false,
        status: "rejected",
        errorClass: "schema-mismatch",
        reason: `Invalid date value for ${field}: ${value}`
      };
    }

    const parsedRequestedAt = Date.parse(requestedAt);
    if (Number.isNaN(parsedRequestedAt)) continue;

    const ageMinutes = (parsedRequestedAt - date) / 60000;
    if (ageMinutes < -8640) {
      return {
        ok: false,
        status: "rejected",
        errorClass: "schema-mismatch",
        reason: `Date is in the future: ${value}`
      };
    }
    if (ageMinutes > maxAgeDays * 24 * 60) {
      return {
        ok: false,
        status: "rejected",
        errorClass: "schema-mismatch",
        reason: `Date is stale: ${value}`
      };
    }
  }

  return undefined;
}

function firstDate(
  records: Array<Record<string, string>>,
  dateColumns: string[] | undefined,
  normalizeHeaders: boolean | undefined
): string | undefined {
  if (!dateColumns || dateColumns.length === 0) return undefined;
  const normalizedColumns = dateColumns.map((field) => normalizeHeaderName(field, normalizeHeaders));
  const candidate = records
    .flatMap((record) => normalizedColumns.map((column) => record[column]).filter(Boolean))
    .find(Boolean);
  return candidate;
}

function isNumeric(value: string): boolean {
  const parsed = Number(value);
  return Number.isFinite(parsed) && !Number.isNaN(parsed);
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

function normalizeHeaderName(header: string, normalizeHeader: boolean | undefined): string {
  return normalizeHeader ? normalizeHeaderString(header) : header;
}

function normalizeHeaderRow(headers: string[], normalizeHeader: boolean | undefined): string[] {
  if (normalizeHeader) return headers.map((header) => normalizeHeaderString(header));
  return headers.map((header) => header.trim());
}

function normalizeHeaderString(header: string): string {
  return header
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "-");
}
