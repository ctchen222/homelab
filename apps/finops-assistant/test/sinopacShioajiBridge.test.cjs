const test = require("node:test");
const assert = require("node:assert/strict");
const { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const { createSinoPacShioajiBridgeProvider } = require("../dist/sinopacShioajiBridge.js");

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
