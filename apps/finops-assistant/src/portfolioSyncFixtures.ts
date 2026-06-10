import {
  BrokerAdapterDescriptor,
  BrokerConnector,
  BrokerSyncRequest,
  CashBalance,
  PortfolioHolding,
  SNAPSHOT_SCHEMA_VERSION,
  SnapshotEnvelope,
  SourceFreshness,
  classifyBrokerSyncError
} from "./portfolioSync";

export type FixtureBrokerScenario = "complete" | "partial" | "failed" | "stale";

export interface FixtureBrokerConnectorOptions {
  adapterId?: string;
  brokerId?: string;
  displayName?: string;
  market?: string;
  symbol?: string;
  baseCurrency?: string;
  sourceTimestamp?: string;
  scenario?: FixtureBrokerScenario;
}

export function createFixtureBrokerConnector(options: FixtureBrokerConnectorOptions = {}): BrokerConnector {
  const scenario = options.scenario || "complete";
  const brokerId = options.brokerId || "fixture";
  const adapterId = options.adapterId || "fixture-broker";
  const market = options.market || "NASDAQ";
  const baseCurrency = options.baseCurrency || "USD";
  const descriptor: BrokerAdapterDescriptor = {
    adapterId,
    brokerId,
    displayName: options.displayName || "Fixture Broker",
    kind: "live-connector",
    supportedSourceTypes: ["live-api"],
    supportedMarkets: [market],
    supportsHoldings: true,
    supportsCash: true,
    supportsActivity: false,
    supportsCostBasis: true,
    credentialMode: "none",
    productionStatus: "fixture-only"
  };

  return {
    describe: () => descriptor,
    preflight: (request) => {
      if (request.mode !== "fixture") {
        return {
          ok: false,
          status: "rejected",
          errorClass: "unsafe-input",
          reason: "Fixture broker sync only supports fixture mode."
        };
      }

      return { ok: true, status: "succeeded", sourceTimestamp: options.sourceTimestamp || request.requestedAt };
    },
    syncSnapshot: (request) => buildFixtureSnapshot(descriptor, request, { ...options, scenario, market, baseCurrency }),
    classifyError: classifyBrokerSyncError
  };
}

function buildFixtureSnapshot(
  descriptor: BrokerAdapterDescriptor,
  request: BrokerSyncRequest,
  options: Required<Pick<FixtureBrokerConnectorOptions, "scenario" | "market" | "baseCurrency">> & FixtureBrokerConnectorOptions
): SnapshotEnvelope {
  const sourceTimestamp = options.sourceTimestamp || request.requestedAt;
  const status = freshnessStatusFor(options.scenario, sourceTimestamp, request.requestedAt, 1440);
  const missingFields = missingFieldsFor(options.scenario);
  const holdings = fixtureHoldings(descriptor, request, options, sourceTimestamp);
  const cashBalances = fixtureCashBalances(descriptor, request, options, sourceTimestamp);

  return {
    schemaVersion: SNAPSHOT_SCHEMA_VERSION,
    syncRunId: `fixture-${options.scenario}-${request.accountAlias}-${request.requestedAt}`,
    brokerId: descriptor.brokerId,
    account: {
      brokerId: descriptor.brokerId,
      accountAlias: request.accountAlias,
      accountIdentityHash: `fixture:${descriptor.brokerId}:${request.accountAlias}`,
      baseCurrency: options.baseCurrency,
      marketScope: [options.market],
      displayName: "Fixture Account",
      status: options.scenario === "failed" ? "sync-unavailable" : "active",
      createdAt: request.requestedAt,
      updatedAt: request.requestedAt
    },
    sourceType: "live-api",
    sourceFreshness: fixtureFreshness(descriptor.adapterId, sourceTimestamp, request.requestedAt, status, missingFields),
    baseCurrency: options.baseCurrency,
    asOf: sourceTimestamp,
    holdings,
    cashBalances,
    activityRows: [],
    errors:
      options.scenario === "failed"
        ? [{ errorClass: "auth-failed", message: "Fixture failed sync state." }]
        : [],
    dataQuality: dataQualityFor(options.scenario)
  };
}

function fixtureFreshness(
  adapterId: string,
  sourceTimestamp: string,
  fetchedAt: string,
  status: SourceFreshness["status"],
  missingFields: string[]
): SourceFreshness {
  return {
    sourceType: "live-api",
    sourceName: adapterId,
    sourceTimestamp,
    fetchedAt,
    maxAgeMinutes: 1440,
    status,
    reason: status === "fresh" ? undefined : `Fixture ${status} sync state.`,
    missingFields
  };
}

function fixtureHoldings(
  descriptor: BrokerAdapterDescriptor,
  request: BrokerSyncRequest,
  options: Required<Pick<FixtureBrokerConnectorOptions, "scenario" | "market" | "baseCurrency">> & FixtureBrokerConnectorOptions,
  asOf: string
): PortfolioHolding[] {
  if (options.scenario === "failed") return [];

  const holding: PortfolioHolding = {
    brokerId: descriptor.brokerId,
    accountAlias: request.accountAlias,
    market: options.market,
    symbol: options.symbol || "VTI",
    providerSymbol: options.symbol || "VTI",
    securityName: "Fixture Total Market ETF",
    assetType: "etf",
    currency: options.baseCurrency,
    quantity: "10",
    lastPrice: "250.00",
    marketValue: "2500.00",
    asOf,
    freshnessStatus: options.scenario === "partial" ? "partial" : "fresh",
    dataQuality: options.scenario === "partial" ? ["missing-cost-basis"] : []
  };

  if (options.scenario !== "partial") {
    holding.averageCost = "200.00";
    holding.costBasis = "2000.00";
    holding.unrealizedPnl = "500.00";
    holding.unrealizedPnlPercent = "25.00";
  }

  return [holding];
}

function fixtureCashBalances(
  descriptor: BrokerAdapterDescriptor,
  request: BrokerSyncRequest,
  options: Required<Pick<FixtureBrokerConnectorOptions, "scenario" | "baseCurrency">> & FixtureBrokerConnectorOptions,
  asOf: string
): CashBalance[] {
  if (options.scenario !== "complete") return [];

  return [
    {
      brokerId: descriptor.brokerId,
      accountAlias: request.accountAlias,
      currency: options.baseCurrency,
      amount: "1250.00",
      balanceType: "settled",
      asOf,
      freshnessStatus: "fresh",
      dataQuality: []
    }
  ];
}

function freshnessStatusFor(
  scenario: FixtureBrokerScenario,
  sourceTimestamp: string,
  fetchedAt: string,
  maxAgeMinutes: number
): SourceFreshness["status"] {
  const parsedSource = Date.parse(sourceTimestamp);
  const parsedFetched = Date.parse(fetchedAt);
  const ageMinutes = Number.isNaN(parsedSource) || Number.isNaN(parsedFetched) ? Number.MAX_SAFE_INTEGER : (parsedFetched - parsedSource) / 60000;

  if (scenario === "failed") return "failed";
  if (scenario === "partial") return "partial";
  if (scenario === "stale") return "stale";
  if (ageMinutes > maxAgeMinutes) return "stale";
  return "fresh";
}

function missingFieldsFor(scenario: FixtureBrokerScenario): string[] {
  if (scenario === "partial") return ["cashBalances", "holdings.costBasis"];
  if (scenario === "failed") return ["holdings", "cashBalances"];
  return [];
}

function dataQualityFor(scenario: FixtureBrokerScenario): string[] {
  if (scenario === "partial") return ["fixture-partial", "missing-cash", "missing-cost-basis"];
  if (scenario === "failed") return ["fixture-failed-sync"];
  return [];
}
