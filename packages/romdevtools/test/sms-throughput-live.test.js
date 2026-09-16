// Public-handler verification against an explicitly selected development server.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
const url = process.env.ROMDEV_AUDIT_URL;
const session = "sms-throughput-live-tests";
async function call(tool, args) {
  const r = await fetch(`${url}/tool/${tool}`, { method: "POST", headers: {
    "Content-Type": "application/json", "x-romdev-session": session, "x-romdev-agent": "throughput-implementation",
  }, body: JSON.stringify(args) });
  return { ok: r.ok, result: await r.json() };
}
test("HTTP SMS whole-homebrew IR, error telemetry, and actual WASM slot B", { skip: !url }, async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "sms-throughput-http-"));
  // No shipped default: a path under someone's home directory is not a test
  // fixture. The test skips unless the operator names a ROM.
  const rom = process.env.ROMDEV_SMS_ROM;
  if (!rom) return;
  const exported = await call("disasm", { target: "recompile", platform: "sms", path: rom,
    allOffsets: true, emit: "ir", outputPath: path.join(tmp, "waimanu.jsonl") });
  assert.equal(exported.ok, true, JSON.stringify(exported.result));
  assert.equal(exported.result.coveredBytes, (await readFile(rom)).length);
  assert.equal(exported.result.banks.length, 8);
  assert.equal(exported.result.mainAsm, undefined);
  assert.ok(JSON.stringify(exported.result).length < 4096);
  const mapped = await call("disasm", { target: "rom", platform: "sms", path: rom,
    startAddress: 0x4000, length: 6, bank: 7, mapper: "codemasters" });
  assert.equal(mapped.ok, true, JSON.stringify(mapped.result));
  for (let i = 0; i < 20; i++) await call("disasm", { target: "recompile", platform: "sms", length: 262144 });
  const status = await call("catalog", { op: "status" });
  const stats = status.result.serverHealth.requestTelemetry.sessions.find(s => s.session.includes(session));
  assert.ok(stats, JSON.stringify(status.result));
  assert.ok(stats.errors >= 20);
  assert.ok(stats.warning);
  assert.equal(stats.lastErrors.at(-1).phase, "validation");

  const a = await call("loadMedia", { path: rom, platform: "sms" });
  assert.equal(a.ok, true, JSON.stringify(a.result));
  const b = await call("loadMedia", { path: new URL("./fixtures/dbghello.wasc", import.meta.url).pathname, platform: "wasmcart", slot: "b" });
  assert.equal(b.ok, true, JSON.stringify(b.result));
  const opts = { op: "findDiverge", region: "system_ram", regionB: "linear_memory", offsetA: 0, offsetB: 0, compareLength: 16, maxFrames: 3 };
  const protectedRun = await call("frame", opts);
  assert.equal(protectedRun.ok, false, "unsnapshotable WASM must not advance without explicit restore:false");
  const result = await call("frame", { ...opts, restore: false });
  assert.equal(result.ok, true, JSON.stringify(result.result));
  assert.ok(["diverged", "no-observed-divergence", "inconclusive-no-observed-memory-activity"].includes(result.result.conclusion));
  // The unrelated debug cart is an interoperability test, NOT SMS equivalence.
});
