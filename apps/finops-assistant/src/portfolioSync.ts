export const SNAPSHOT_SCHEMA_VERSION = "investment-portfolio.snapshot.v1" as const;

export const PORTFOLIO_SOURCE_TYPES = [
  "live-api",
  "csv-current-position-snapshot",
  "csv-cash-snapshot",
  "statement-import",
  "transaction-history",
  "prior-year-gain-loss",
  "partial-activity-only-import",
  "manual-csv"
] as const;

export type PortfolioSourceType = (typeof PORTFOLIO_SOURCE_TYPES)[number];

export type FreshnessStatus = "fresh" | "stale" | "partial" | "failed" | "unavailable";
export type SyncStatus = "succeeded" | "partial" | "failed" | "rejected" | "skipped";
export type AdapterKind = "live-connector" | "csv-importer" | "statement-importer" | "aggregator-candidate" | "manual-importer";
export type CredentialMode = "none" | "read-only-secret" | "owner-upload" | "candidate-approval-required" | "write-capable-secret" | "browser-session";
export type ProductionStatus = "fixture-only" | "dry-run" | "approved-read-only" | "import-only" | "rejected";
export type BrokerSyncMode = "fixture" | "dry-run" | "live-read" | "csv-import" | "manual-import";
export type SyncErrorClass =
  | "missing-credentials"
  | "auth-failed"
  | "permission-denied"
  | "rate-limited"
  | "schema-mismatch"
  | "stale-source"
  | "unsafe-input"
  | "write-capable-credential"
  | "unknown";

type MaybePromise<T> = T | Promise<T>;

export interface BrokerAdapterDescriptor {
  adapterId: string;
  brokerId: string;
  displayName: string;
  kind: AdapterKind;
  supportedSourceTypes: PortfolioSourceType[];
  supportedMarkets: string[];
  supportsHoldings: boolean;
  supportsCash: boolean;
  supportsActivity: boolean;
  supportsCostBasis: boolean;
  credentialMode: CredentialMode;
  productionStatus: ProductionStatus;
}

export interface BrokerAccount {
  brokerId: string;
  accountAlias: string;
  accountIdentityHash: string;
  accountType?: string;
  baseCurrency: string;
  marketScope: string[];
  displayName?: string;
  status: "active" | "disabled" | "sync-unavailable" | "import-only";
  createdAt: string;
  updatedAt: string;
}

export interface PortfolioHolding {
  brokerId: string;
  accountAlias: string;
  market: string;
  symbol: string;
  providerSymbol?: string;
  securityName?: string;
  assetType: "stock" | "etf" | "fund" | "cash-equivalent" | "option" | "bond" | "crypto" | "unknown";
  currency: string;
  quantity: string;
  averageCost?: string;
  costBasis?: string;
  lastPrice?: string;
  marketValue?: string;
  unrealizedPnl?: string;
  unrealizedPnlPercent?: string;
  asOf: string;
  freshnessStatus: FreshnessStatus;
  dataQuality: string[];
}

export interface CashBalance {
  brokerId: string;
  accountAlias: string;
  currency: string;
  amount: string;
  balanceType: "settled" | "available" | "buying-power" | "margin" | "withheld" | "unknown";
  asOf: string;
  freshnessStatus: FreshnessStatus;
  dataQuality: string[];
}

export interface ActivityRow {
  brokerId: string;
  accountAlias: string;
  activityId: string;
  activityType:
    | "buy"
    | "sell"
    | "dividend"
    | "interest"
    | "deposit"
    | "withdrawal"
    | "fee"
    | "tax"
    | "split"
    | "transfer"
    | "gain-loss"
    | "unknown";
  tradeDate?: string;
  settleDate?: string;
  market?: string;
  symbol?: string;
  currency: string;
  quantity?: string;
  price?: string;
  amount?: string;
  amountType?: "gross" | "net" | "fee" | "tax" | "unknown";
  sourceDescription?: string;
  asOf: string;
  dataQuality: string[];
}

export interface SourceFreshness {
  sourceType: PortfolioSourceType;
  sourceName: string;
  sourceTimestamp?: string;
  fetchedAt: string;
  committedAt?: string;
  maxAgeMinutes: number;
  status: FreshnessStatus;
  reason?: string;
  missingFields: string[];
}

export interface SyncEvent {
  syncRunId: string;
  brokerId: string;
  accountAlias: string;
  adapterId: string;
  mode: BrokerSyncMode;
  startedAt: string;
  finishedAt?: string;
  status: SyncStatus;
  errorClass?: SyncErrorClass;
  rowCounts: {
    accounts: number;
    holdings: number;
    cashBalances: number;
    activityRows: number;
    skippedRows: number;
    errors: number;
  };
  artifactRefs: string[];
}

export interface SnapshotEnvelope {
  schemaVersion: typeof SNAPSHOT_SCHEMA_VERSION;
  syncRunId: string;
  brokerId: string;
  account: BrokerAccount;
  sourceType: PortfolioSourceType;
  sourceFreshness: SourceFreshness;
  baseCurrency: string;
  asOf: string;
  holdings: PortfolioHolding[];
  cashBalances: CashBalance[];
  activityRows: ActivityRow[];
  errors: Array<{ errorClass: SyncErrorClass; message: string }>;
  dataQuality: string[];
}

export interface BrokerSyncRequest {
  accountAlias: string;
  mode: Extract<BrokerSyncMode, "fixture" | "dry-run" | "live-read">;
  requestedAt: string;
}

export interface BrokerImportRequest {
  accountAlias: string;
  mode: Extract<BrokerSyncMode, "csv-import" | "manual-import">;
  sourceType: PortfolioSourceType;
  filePath: string;
  requestedAt: string;
  checksum?: string;
  ownerApproved?: boolean;
  retainRawImport?: boolean;
}

export interface ImportPreview {
  accountAlias: string;
  sourceType: PortfolioSourceType;
  sourceTimestamp?: string;
  dateRange?: {
    from: string;
    to: string;
  };
  checksum?: string;
  status: "accepted" | "partial" | "rejected";
  missingFields: string[];
  rowCounts: SyncEvent["rowCounts"];
}

export interface BrokerPreflightResult {
  ok: boolean;
  status: SyncStatus;
  errorClass?: SyncErrorClass;
  reason?: string;
  sourceTimestamp?: string;
}

export interface BrokerConnector {
  describe(): BrokerAdapterDescriptor;
  preflight(request: BrokerSyncRequest): MaybePromise<BrokerPreflightResult>;
  syncSnapshot(request: BrokerSyncRequest): MaybePromise<SnapshotEnvelope>;
  classifyError(error: unknown): SyncErrorClass;
}

export interface BrokerImporter {
  describe(): BrokerAdapterDescriptor;
  preflight(request: BrokerImportRequest): MaybePromise<BrokerPreflightResult>;
  previewImport(request: BrokerImportRequest): MaybePromise<ImportPreview>;
  commitImport(request: BrokerImportRequest): MaybePromise<SnapshotEnvelope>;
  classifyError(error: unknown): SyncErrorClass;
}

export interface RegisteredBrokerAdapter {
  descriptor: BrokerAdapterDescriptor;
  connector?: BrokerConnector;
  importer?: BrokerImporter;
}

export interface BrokerAdapterSelection {
  brokerId: string;
  sourceType: PortfolioSourceType;
  role?: "connector" | "importer";
}

export class BrokerAdapterRegistry {
  private readonly adapters = new Map<string, RegisteredBrokerAdapter>();

  registerConnector(connector: BrokerConnector): BrokerPreflightResult {
    return this.register({ descriptor: connector.describe(), connector });
  }

  registerImporter(importer: BrokerImporter): BrokerPreflightResult {
    return this.register({ descriptor: importer.describe(), importer });
  }

  list(): RegisteredBrokerAdapter[] {
    return [...this.adapters.values()];
  }

  get(adapterId: string): RegisteredBrokerAdapter | undefined {
    return this.adapters.get(adapterId);
  }

  select(selection: BrokerAdapterSelection): RegisteredBrokerAdapter | undefined {
    return this.list().find((entry) => {
      if (entry.descriptor.brokerId !== selection.brokerId) return false;
      if (!entry.descriptor.supportedSourceTypes.includes(selection.sourceType)) return false;
      if (selection.role === "connector" && !entry.connector) return false;
      if (selection.role === "importer" && !entry.importer) return false;
      return true;
    });
  }

  private register(entry: RegisteredBrokerAdapter): BrokerPreflightResult {
    const validation = validateReadOnlyDescriptor(entry.descriptor);
    if (!validation.ok) return validation;

    if (this.adapters.has(entry.descriptor.adapterId)) {
      return {
        ok: false,
        status: "rejected",
        errorClass: "schema-mismatch",
        reason: `Broker adapter ${entry.descriptor.adapterId} is already registered.`
      };
    }

    this.adapters.set(entry.descriptor.adapterId, entry);
    return { ok: true, status: "succeeded" };
  }
}

export function isPortfolioSourceType(value: string): value is PortfolioSourceType {
  return PORTFOLIO_SOURCE_TYPES.includes(value as PortfolioSourceType);
}

export function validateReadOnlyDescriptor(descriptor: BrokerAdapterDescriptor): BrokerPreflightResult {
  if (descriptor.credentialMode === "write-capable-secret") {
    return {
      ok: false,
      status: "rejected",
      errorClass: "write-capable-credential",
      reason: "Broker adapter credentials must be read-only."
    };
  }

  if (descriptor.credentialMode === "browser-session") {
    return {
      ok: false,
      status: "rejected",
      errorClass: "unsafe-input",
      reason: "Authenticated broker browser sessions are outside the approved sync contract."
    };
  }

  if (descriptor.supportedSourceTypes.some((sourceType) => !isPortfolioSourceType(sourceType))) {
    return {
      ok: false,
      status: "rejected",
      errorClass: "schema-mismatch",
      reason: "Broker adapter declares an unsupported source type."
    };
  }

  return { ok: true, status: "succeeded" };
}

export function classifyBrokerSyncError(error: unknown): SyncErrorClass {
  if (isErrorClassObject(error)) return error.errorClass;

  const message = error instanceof Error ? error.message : String(error ?? "");
  const normalized = message.toLowerCase();

  if (normalized.includes("missing") && (normalized.includes("credential") || normalized.includes("secret") || normalized.includes("token"))) {
    return "missing-credentials";
  }
  if (normalized.includes("unauthorized") || normalized.includes("authentication") || normalized.includes("auth failed")) {
    return "auth-failed";
  }
  if (
    normalized.includes("permission") ||
    normalized.includes("forbidden") ||
    normalized.includes("account not acceptable") ||
    normalized.includes("not signed")
  ) {
    return "permission-denied";
  }
  if (normalized.includes("rate limit") || normalized.includes("too many requests")) {
    return "rate-limited";
  }
  if (normalized.includes("stale")) {
    return "stale-source";
  }
  if (normalized.includes("unsafe") || normalized.includes("formula") || normalized.includes("path traversal")) {
    return "unsafe-input";
  }
  if (normalized.includes("write-capable") || normalized.includes("trading credential")) {
    return "write-capable-credential";
  }
  if (normalized.includes("schema") || normalized.includes("header")) {
    return "schema-mismatch";
  }

  return "unknown";
}

function isErrorClassObject(error: unknown): error is { errorClass: SyncErrorClass } {
  if (!error || typeof error !== "object" || !("errorClass" in error)) return false;
  const errorClass = (error as { errorClass?: unknown }).errorClass;
  return typeof errorClass === "string" && isSyncErrorClass(errorClass);
}

function isSyncErrorClass(value: string): value is SyncErrorClass {
  return [
    "missing-credentials",
    "auth-failed",
    "permission-denied",
    "rate-limited",
    "schema-mismatch",
    "stale-source",
    "unsafe-input",
    "write-capable-credential",
    "unknown"
  ].includes(value);
}
