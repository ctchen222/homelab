const test = require("node:test");
const assert = require("node:assert/strict");
const { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const { createSinoPacShioajiBridgeProvider } = require("../dist/sinopacShioajiBridge.js");
const { createSinoPacShioajiLiveConnector } = require("../dist/sinopacShioaji.js");

test("SinoPac Shioaji bridge requests stock positions in share units", () => {
  const script = readFileSync(join(__dirname, "../scripts/sinopac_shioaji_snapshot.py"), "utf8");
  assert.match(script, /fetch_contract=True/);
  assert.match(script, /api\.list_positions\(account,\s*unit=sj\.Unit\.Share\)/);
  assert.match(script, /normalize_position\(position,\s*requested_at,\s*api\.Contracts\)/);
  assert.match(script, /read_attr\(contract,\s*"name"\)/);
});

test("SinoPac Shioaji bridge parses JSON after Shioaji session logs", async (t) => {
  const tempDir = mkdtempSync(join(tmpdir(), "finops-sinopac-bridge-"));
  t.after(() => rmSync(tempDir, { recursive: true, force: true }));

  const caPath = join(tempDir, "sinopac.pfx");
  const commandPath = join(tempDir, "mock-bridge.sh");
  writeFileSync(caPath, "fake-ca");
  writeFileSync(
    commandPath,
    [
      "#!/usr/bin/env bash",
      "echo \"Response Code: 0 | Event Code: 0 | Info: Session up\"",
      "echo '{\"positions\":[{\"code\":\"2330\",\"quantity\":\"1\",\"asOf\":\"2026-06-08T02:00:00.000Z\"}],\"cashBalances\":[{\"currency\":\"TWD\",\"amount\":\"100\",\"asOf\":\"2026-06-08T02:00:00.000Z\"}]}'"
    ].join("\n")
  );
  chmodSync(commandPath, 0o755);

  const provider = createSinoPacShioajiBridgeProvider({
    apiKey: "api-key",
    secretKey: "secret-key",
    caPath,
    caPassword: "ca-password",
    command: commandPath
  });
  const request = {
    accountAlias: "sinopac-main",
    mode: "live-read",
    requestedAt: "2026-06-08T02:00:00.000Z"
  };

  const positions = await provider.readStockPositions(request);
  const cashBalances = await provider.readCashBalances(request);

  assert.equal(positions[0].code, "2330");
  assert.equal(cashBalances[0].amount, "100");
});

test("SinoPac Shioaji bridge re-reads payload for each sync request on the same provider instance", async (t) => {
  const tempDir = mkdtempSync(join(tmpdir(), "finops-sinopac-bridge-"));
  t.after(() => rmSync(tempDir, { recursive: true, force: true }));

  const caPath = join(tempDir, "sinopac.pfx");
  const commandPath = join(tempDir, "mock-bridge.sh");
  writeFileSync(caPath, "fake-ca");
  writeFileSync(
    commandPath,
    [
      "#!/usr/bin/env bash",
      "if [ \"$SINOPAC_REQUESTED_AT\" = \"2026-06-09T01:10:00.000Z\" ]; then",
      "  echo '{\"positions\":[{\"code\":\"2330\",\"quantity\":\"1\",\"asOf\":\"2026-06-09T01:10:00.000Z\"}],\"cashBalances\":[{\"currency\":\"TWD\",\"amount\":\"100\",\"asOf\":\"2026-06-09T01:10:00.000Z\"}]}'",
      "else",
      "  echo '{\"positions\":[{\"code\":\"2492\",\"quantity\":\"3\",\"asOf\":\"2026-06-09T01:40:00.000Z\"}],\"cashBalances\":[{\"currency\":\"TWD\",\"amount\":\"200\",\"asOf\":\"2026-06-09T01:40:00.000Z\"}]}'",
      "fi"
    ].join("\n")
  );
  chmodSync(commandPath, 0o755);

  const provider = createSinoPacShioajiBridgeProvider({
    apiKey: "api-key",
    secretKey: "secret-key",
    caPath,
    caPassword: "ca-password",
    command: commandPath
  });

  const first = await provider.readStockPositions({
    accountAlias: "sinopac-main",
    mode: "live-read",
    requestedAt: "2026-06-09T01:10:00.000Z"
  });
  const second = await provider.readStockPositions({
    accountAlias: "sinopac-main",
    mode: "live-read",
    requestedAt: "2026-06-09T01:40:00.000Z"
  });

  assert.equal(first[0].code, "2330");
  assert.equal(second[0].code, "2492");
  assert.equal(first[0].asOf, "2026-06-09T01:10:00.000Z");
  assert.equal(second[0].asOf, "2026-06-09T01:40:00.000Z");
});

test("SinoPac live sync uses fresh bridge payload and fresh source timestamp per request", async (t) => {
  const tempDir = mkdtempSync(join(tmpdir(), "finops-sinopac-bridge-sync-"));
  t.after(() => rmSync(tempDir, { recursive: true, force: true }));

  const caPath = join(tempDir, "sinopac.pfx");
  const commandPath = join(tempDir, "mock-bridge.sh");
  writeFileSync(caPath, "fake-ca");
  writeFileSync(
    commandPath,
    [
      "#!/usr/bin/env bash",
      "if [ \"$SINOPAC_REQUESTED_AT\" = \"2026-06-09T01:10:00.000Z\" ]; then",
      "  echo '{\"positions\":[{\"code\":\"2330\",\"quantity\":\"1\",\"asOf\":\"2026-06-09T01:10:00.000Z\"}],\"cashBalances\":[{\"currency\":\"TWD\",\"amount\":\"100\",\"asOf\":\"2026-06-09T01:10:00.000Z\"}]}'",
      "else",
      "  echo '{\"positions\":[{\"code\":\"2492\",\"quantity\":\"3\",\"asOf\":\"2026-06-09T01:40:00.000Z\"}],\"cashBalances\":[{\"currency\":\"TWD\",\"amount\":\"200\",\"asOf\":\"2026-06-09T01:40:00.000Z\"}]}'",
      "fi"
    ].join("\n")
  );
  chmodSync(commandPath, 0o755);

  const connector = createSinoPacShioajiLiveConnector({
    ...createSinoPacShioajiBridgeProvider({
      apiKey: "api-key",
      secretKey: "secret-key",
      caPath,
      caPassword: "ca-password",
      command: commandPath
    })
  });

  const first = await connector.syncSnapshot({
    accountAlias: "sinopac-main",
    mode: "live-read",
    requestedAt: "2026-06-09T01:10:00.000Z"
  });
  const second = await connector.syncSnapshot({
    accountAlias: "sinopac-main",
    mode: "live-read",
    requestedAt: "2026-06-09T01:40:00.000Z"
  });

  assert.equal(first.sourceFreshness.sourceTimestamp, "2026-06-09T01:10:00.000Z");
  assert.equal(second.sourceFreshness.sourceTimestamp, "2026-06-09T01:40:00.000Z");
  assert.equal(first.holdings[0].asOf, "2026-06-09T01:10:00.000Z");
  assert.equal(second.holdings[0].asOf, "2026-06-09T01:40:00.000Z");
  assert.equal(first.holdings[0].symbol, "2330");
  assert.equal(second.holdings[0].symbol, "2492");
});