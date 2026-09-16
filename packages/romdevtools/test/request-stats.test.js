import { test } from "node:test";
import assert from "node:assert/strict";
import { RequestStats, requestStats } from "../src/observer/request-stats.js";
import { runTool } from "../src/http/tool-registry.js";
import { z } from "zod";

test("error storm is visible after the livestream ring would have rolled over", () => {
  let now = 100_000;
  const stats = new RequestStats({ now: () => now });
  for (let i = 0; i < 2000; i++) stats.record({ type: "call", sessionKey: "sms", tool: "disasm", ok: false, phase: "validation", error: "CPU address is not a file offset", durationMs: 1 });
  let s = stats.snapshot().sessions[0];
  assert.equal(s.calls, 2000); assert.equal(s.errors, 2000); assert.equal(s.consecutiveErrors, 2000);
  assert.equal(s.recentCalls, 2000); assert.equal(s.lastErrors.length, 5); assert.ok(s.warning);
  now += 61_000;
  s = stats.snapshot().sessions[0]; assert.equal(s.recentCalls, 0); assert.equal(s.errors, 2000);
  stats.record({ type: "call", sessionKey: "sms", tool: "catalog", ok: true });
  assert.equal(stats.snapshot().sessions[0].consecutiveErrors, 0);
});

test("session retention is bounded and isolated", () => {
  const stats = new RequestStats({ maxSessions: 2 });
  for (const sessionKey of ["a", "b", "a", "c"]) stats.record({ type: "call", sessionKey, tool: "catalog", ok: true });
  assert.deepEqual(stats.snapshot().sessions.map((s) => [s.session, s.calls]), [["a", 2], ["c", 1]]);
});

test("real HTTP execution path accounts for schema errors and handler errors separately", async () => {
  const key = "telemetry-regression";
  const tool = { name: "disasm", inputSchema: z.object({ length: z.number().max(4) }),
    handler: async () => { throw new Error("not ROM"); } };
  await runTool(tool, { length: 20 }, key);
  await runTool(tool, { length: 1 }, key);
  const s = requestStats.snapshot().sessions.find((s) => s.session === key);
  assert.equal(s.calls, 2); assert.equal(s.errors, 2);
  assert.deepEqual(s.lastErrors.map((e) => e.phase), ["validation", "execution"]);
});
