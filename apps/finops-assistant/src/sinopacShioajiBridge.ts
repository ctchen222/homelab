import { existsSync } from "node:fs";
import {
  BrokerSyncRequest,
  classifyBrokerSyncError
} from "./portfolioSync";
import {
  ShioajiCashBalance,
  ShioajiPositionProvider,
  ShioajiStockPosition
} from "./sinopacShioaji";

declare const require: any;
const runExecFile = require("node:child_process").execFile as (
  command: string,
  args: string[],
  options: { env: Record<string, string | undefined>; timeout: number; maxBuffer: number },
  callback: (error: Error | null, stdout: string, stderr: string) => void
) => void;

interface SinoPacBridgePayload {
  positions?: ShioajiStockPosition[];
  cashBalances?: ShioajiCashBalance[];
}

export interface SinoPacShioajiBridgeOptions {
  apiKey?: string;
  secretKey?: string;
  caPath?: string;
  caPassword?: string;
  personId?: string;
  command?: string;
  timeoutMs?: number;
}

export function createSinoPacShioajiBridgeProvider(options: SinoPacShioajiBridgeOptions): ShioajiPositionProvider {
  let cachedPayload: Promise<SinoPacBridgePayload> | undefined;

  async function readPayload(request: BrokerSyncRequest): Promise<SinoPacBridgePayload> {
    if (!cachedPayload) {
      cachedPayload = executeBridge(options, request);
    }

    return cachedPayload;
  }

  return {
    preflight: (request) => {
      try {
        validateBridgeOptions(options);
        return { ok: true, status: "succeeded", sourceTimestamp: request.requestedAt };
      } catch (error) {
        return {
          ok: false,
          status: "rejected",
          errorClass: classifyBrokerSyncError(error),
          reason: error instanceof Error ? error.message : "SinoPac Shioaji bridge preflight failed."
        };
      }
    },
    readStockPositions: async (request) => {
      const payload = await readPayload(request);
      return payload.positions || [];
    },
    readCashBalances: async (request) => {
      const payload = await readPayload(request);
      return payload.cashBalances || [];
    }
  };
}

async function executeBridge(options: SinoPacShioajiBridgeOptions, request: BrokerSyncRequest): Promise<SinoPacBridgePayload> {
  validateBridgeOptions(options);

  const command = options.command || "/app/scripts/sinopac_shioaji_snapshot.py";
  const env = {
    ...process.env,
    SINOPAC_API_KEY: options.apiKey,
    SINOPAC_SECRET_KEY: options.secretKey,
    SINOPAC_CA_PATH: options.caPath,
    SINOPAC_CA_PASSWORD: options.caPassword,
    SINOPAC_PERSON_ID: options.personId || "",
    SINOPAC_ACCOUNT_ALIAS: request.accountAlias,
    SINOPAC_REQUESTED_AT: request.requestedAt,
    SJ_LOG_PATH: "/tmp/shioaji.log"
  };
  const stdout = await execBridge(command, {
    env,
    timeout: options.timeoutMs || 30000,
    maxBuffer: 1024 * 1024
  });

  return parseBridgePayload(stdout);
}

function execBridge(command: string, options: { env: Record<string, string | undefined>; timeout: number; maxBuffer: number }): Promise<string> {
  return new Promise((resolve, reject) => {
    runExecFile(command, [], options, (error, stdout, stderr) => {
      if (error) {
        reject(new Error(stderr || error.message));
        return;
      }
      resolve(stdout);
    });
  });
}

function validateBridgeOptions(options: SinoPacShioajiBridgeOptions): void {
  if (!options.apiKey || !options.secretKey) {
    throw Object.assign(new Error("missing SinoPac Shioaji API credentials"), { errorClass: "missing-credentials" });
  }
  if (!options.caPath) {
    throw Object.assign(new Error("missing SinoPac Shioaji CA path"), { errorClass: "missing-credentials" });
  }
  if (!options.caPassword) {
    throw Object.assign(new Error("missing SinoPac Shioaji CA password"), { errorClass: "missing-credentials" });
  }
  if (!existsSync(options.caPath)) {
    throw Object.assign(new Error("missing SinoPac Shioaji CA file"), { errorClass: "missing-credentials" });
  }
}

function parseBridgePayload(stdout: string): SinoPacBridgePayload {
  try {
    const parsed = JSON.parse(extractBridgeJson(stdout)) as SinoPacBridgePayload;
    if (!parsed || typeof parsed !== "object") {
      throw new Error("SinoPac Shioaji bridge returned a non-object payload");
    }
    return {
      positions: Array.isArray(parsed.positions) ? parsed.positions : [],
      cashBalances: Array.isArray(parsed.cashBalances) ? parsed.cashBalances : []
    };
  } catch (error) {
    throw Object.assign(new Error(`SinoPac Shioaji bridge schema mismatch: ${error instanceof Error ? error.message : String(error)}`), {
      errorClass: classifyBrokerSyncError(new Error("schema mismatch"))
    });
  }
}

function extractBridgeJson(stdout: string): string {
  const trimmed = stdout.trim();
  if (trimmed.startsWith("{")) return trimmed;

  const jsonLine = trimmed
    .split(/\r?\n/)
    .reverse()
    .find((line) => line.trim().startsWith("{"));
  if (!jsonLine) return trimmed;
  return jsonLine.trim();
}
