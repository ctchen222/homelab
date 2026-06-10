import {
  BrokerAdapterDescriptor,
  BrokerConnector,
  BrokerPreflightResult,
  BrokerSyncRequest,
  CashBalance,
  PortfolioHolding,
  SNAPSHOT_SCHEMA_VERSION,
  SnapshotEnvelope,
  SourceFreshness,
  classifyBrokerSyncError
} from "./portfolioSync";

type MaybePromise<T> = T | Promise<T>;
type SinoPacSyncCapability = "dry-run" | "live-read";

export interface ShioajiStockPosition {
  code: string;
  quantity: string | number;
  market?: string;
  name?: string;
  currency?: string;
  averageCost?: string | number;
  costBasis?: string | number;
  lastPrice?: string | number;
  marketValue?: string | number;
  unrealizedPnl?: string | number;
  unrealizedPnlPercent?: string | number;
  asOf?: string;
}

export interface ShioajiCashBalance {
  currency?: string;
  amount: string | number;
  balanceType?: CashBalance["balanceType"];
  asOf?: string;
}

export interface ShioajiPositionProvider {
  preflight?(request: BrokerSyncRequest): MaybePromise<BrokerPreflightResult>;
  readStockPositions(request: BrokerSyncRequest): MaybePromise<ShioajiStockPosition[]>;
  readCashBalances?(request: BrokerSyncRequest): MaybePromise<ShioajiCashBalance[]>;
}

export interface SinoPacShioajiDryRunOptions {
  adapterId?: string;
  brokerId?: string;
  sourceTimestamp?: string;
  capability?: SinoPacSyncCapability;
}

export function createSinoPacShioajiDryRunConnector(
  provider: ShioajiPositionProvider,
  options: SinoPacShioajiDryRunOptions = {}
): BrokerConnector {
  return createSinoPacShioajiConnector(provider, { ...options, capability: "dry-run" });
}

export function createSinoPacShioajiLiveConnector(
  provider: ShioajiPositionProvider,
  options: Omit<SinoPacShioajiDryRunOptions, "capability"> = {}
): BrokerConnector {
  return createSinoPacShioajiConnector(provider, { ...options, capability: "live-read" });
}

function createSinoPacShioajiConnector(
  provider: ShioajiPositionProvider,
  options: SinoPacShioajiDryRunOptions = {}
): BrokerConnector {
  const capability = options.capability || "dry-run";
  const descriptor: BrokerAdapterDescriptor = {
    adapterId: options.adapterId || "sinopac-shioaji",
    brokerId: options.brokerId || "sinopac",
    displayName: capability === "live-read" ? "SinoPac Shioaji Live Read" : "SinoPac Shioaji Dry-Run",
    kind: "live-connector",
    supportedSourceTypes: ["live-api"],
    supportedMarkets: ["TWSE", "TPEx"],
    supportsHoldings: true,
    supportsCash: Boolean(provider.readCashBalances),
    supportsActivity: false,
    supportsCostBasis: true,
    credentialMode: capability === "live-read" ? "read-only-secret" : "none",
    productionStatus: capability === "live-read" ? "approved-read-only" : "dry-run"
  };

  return {
    describe: () => descriptor,
    preflight: (request) => {
      if (request.mode !== capability) {
        return {
          ok: false,
          status: "rejected",
          errorClass: "unsafe-input",
          reason: `SinoPac/Shioaji stock position sync currently supports ${capability} mode only.`
        };
      }

      if (provider.preflight) {
        return provider.preflight(request);
      }

      return { ok: true, status: "succeeded", sourceTimestamp: options.sourceTimestamp || request.requestedAt };
    },
    syncSnapshot: async (request) => {
      if (request.mode !== capability) {
        throw new Error(`SinoPac/Shioaji stock position sync currently supports ${capability} mode only.`);
      }

      const stockResult = await readStockPositions(provider, request);
      const cashResult = await readCashBalances(provider, request);
      return buildSinoPacSnapshot(descriptor, request, stockResult, cashResult, options.sourceTimestamp, capability);
    },
    classifyError: classifyBrokerSyncError
  };
}

interface StockPositionReadResult {
  positions: ShioajiStockPosition[];
  errorClass?: SnapshotEnvelope["errors"][number]["errorClass"];
  errorMessage?: string;
}

interface CashBalanceReadResult {
  balances: ShioajiCashBalance[];
  errorClass?: SnapshotEnvelope["errors"][number]["errorClass"];
  errorMessage?: string;
}

function buildSinoPacSnapshot(
  descriptor: BrokerAdapterDescriptor,
  request: BrokerSyncRequest,
  stockResult: StockPositionReadResult,
  cashResult: CashBalanceReadResult,
  configuredSourceTimestamp: string | undefined,
  capability: SinoPacSyncCapability
): SnapshotEnvelope {
  const sourceTimestamp =
    configuredSourceTimestamp || firstPositionTimestamp(stockResult.positions) || firstCashTimestamp(cashResult.balances) || request.requestedAt;
  const holdings =
    stockResult.errorClass
      ? []
      : stockResult.positions.map((position) => normalizePosition(descriptor.brokerId, request.accountAlias, position, sourceTimestamp));
  const cashBalances = cashResult.balances.map((balance) => normalizeCashBalance(descriptor.brokerId, request.accountAlias, balance, sourceTimestamp));
  const missingFields = unique([
    ...holdings.flatMap((holding) => holding.dataQuality.map((flag) => dataQualityToField(flag))),
    ...(cashResult.errorClass ? ["cashBalances"] : []),
    ...(stockResult.errorClass ? ["positions"] : [])
  ]);
  const status: SourceFreshness["status"] =
    stockResult.errorClass
      ? "failed"
      : missingFields.length > 0
        ? "partial"
        : "fresh";

  return {
    schemaVersion: SNAPSHOT_SCHEMA_VERSION,
    syncRunId: `sinopac-shioaji-${capability}-${request.accountAlias}-${request.requestedAt}`,
    brokerId: descriptor.brokerId,
    account: {
      brokerId: descriptor.brokerId,
      accountAlias: request.accountAlias,
      accountIdentityHash: `sinopac:${request.accountAlias}`,
      accountType: "tw-stock",
      baseCurrency: "TWD",
      marketScope: ["TWSE", "TPEx"],
      displayName: "SinoPac Taiwan Stock",
      status: "active",
      createdAt: request.requestedAt,
      updatedAt: request.requestedAt
    },
    sourceType: "live-api",
    sourceFreshness: {
      sourceType: "live-api",
      sourceName: descriptor.adapterId,
      sourceTimestamp,
      fetchedAt: request.requestedAt,
      maxAgeMinutes: 1440,
      status,
      reason: status === "partial" ? "SinoPac/Shioaji positions are missing optional valuation fields or cash endpoint data." : undefined,
      missingFields
    },
    baseCurrency: "TWD",
    asOf: sourceTimestamp,
    holdings,
    cashBalances,
    activityRows: [],
    errors: [
      ...(
        cashResult.errorClass
          ? [{ errorClass: cashResult.errorClass, message: cashResult.errorMessage || "SinoPac/Shioaji cash balance sync failed." }]
          : []
      ),
      ...(
        stockResult.errorClass
          ? [{ errorClass: stockResult.errorClass, message: stockResult.errorMessage || "SinoPac/Shioaji stock position sync failed." }]
          : []
      )
    ],
    dataQuality: dataQualityFor(missingFields, cashResult, stockResult)
  };
}

async function readStockPositions(provider: ShioajiPositionProvider, request: BrokerSyncRequest): Promise<StockPositionReadResult> {
  try {
    return { positions: await provider.readStockPositions(request) };
  } catch (error) {
    return {
      positions: [],
      errorClass: classifyBrokerSyncError(error),
      errorMessage: error instanceof Error ? error.message : "SinoPac/Shioaji stock position sync failed."
    };
  }
}

async function readCashBalances(provider: ShioajiPositionProvider, request: BrokerSyncRequest): Promise<CashBalanceReadResult> {
  if (!provider.readCashBalances) return { balances: [] };

  try {
    return { balances: await provider.readCashBalances(request) };
  } catch (error) {
    return {
      balances: [],
      errorClass: classifyBrokerSyncError(error),
      errorMessage: error instanceof Error ? error.message : "SinoPac/Shioaji cash balance sync failed."
    };
  }
}

function normalizePosition(brokerId: string, accountAlias: string, position: ShioajiStockPosition, fallbackAsOf: string): PortfolioHolding {
  const holding: PortfolioHolding = {
    brokerId,
    accountAlias,
    market: position.market || "TWSE",
    symbol: position.code,
    providerSymbol: position.code,
    securityName: position.name,
    assetType: "stock",
    currency: position.currency || "TWD",
    quantity: decimal(position.quantity) || "0",
    averageCost: decimal(position.averageCost),
    costBasis: decimal(position.costBasis),
    lastPrice: decimal(position.lastPrice),
    marketValue: decimal(position.marketValue),
    unrealizedPnl: decimal(position.unrealizedPnl),
    unrealizedPnlPercent: decimal(position.unrealizedPnlPercent),
    asOf: position.asOf || fallbackAsOf,
    freshnessStatus: "fresh",
    dataQuality: []
  };

  holding.dataQuality = missingHoldingFields(holding);
  if (holding.dataQuality.length > 0) {
    holding.freshnessStatus = "partial";
  }

  return holding;
}

function normalizeCashBalance(brokerId: string, accountAlias: string, balance: ShioajiCashBalance, fallbackAsOf: string): CashBalance {
  return {
    brokerId,
    accountAlias,
    currency: balance.currency || "TWD",
    amount: decimal(balance.amount) || "0",
    balanceType: balance.balanceType || "settled",
    asOf: balance.asOf || fallbackAsOf,
    freshnessStatus: "fresh",
    dataQuality: []
  };
}

function missingHoldingFields(holding: PortfolioHolding): string[] {
  const missing: string[] = [];
  if (!holding.averageCost) missing.push("missing-average-cost");
  if (!holding.costBasis) missing.push("missing-cost-basis");
  if (!holding.marketValue) missing.push("missing-market-value");
  return missing;
}

function decimal(value: string | number | undefined): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  return String(value);
}

function firstPositionTimestamp(positions: ShioajiStockPosition[]): string | undefined {
  return positions.find((position) => Boolean(position.asOf))?.asOf;
}

function firstCashTimestamp(balances: ShioajiCashBalance[]): string | undefined {
  return balances.find((balance) => Boolean(balance.asOf))?.asOf;
}

function dataQualityToField(flag: string): string {
  if (flag === "missing-average-cost") return "holdings.averageCost";
  if (flag === "missing-cost-basis") return "holdings.costBasis";
  if (flag === "missing-market-value") return "holdings.marketValue";
  return flag;
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

function dataQualityFor(
  missingFields: string[],
  cashResult: CashBalanceReadResult,
  stockResult: StockPositionReadResult
): string[] {
  const quality: string[] = [];
  if (missingFields.some((field) => field.startsWith("holdings."))) quality.push("positions-partial");
  if (cashResult.errorClass) quality.push("cash-balance-unavailable");
  if (stockResult.errorClass) quality.push("positions-unavailable");
  return quality;
}
