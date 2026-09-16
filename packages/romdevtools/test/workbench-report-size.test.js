import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { compactWorkbenchReport } from "../src/decomp/workbench.js";

test("oversized existing workbench reports retain complete disk evidence and bounded inline projection", async () => {
  const project = { ws: await mkdtemp(path.join(os.tmpdir(), "romdev-workbench-size-")) };
  const original = { report: { schema: "fixture", allocator_webs: Array.from({ length: 30 }, (_, web) => ({ web, proc: 3, explanation: "selected color" })),
    events: Array.from({ length: 3000 }, (_, i) => ({ i, raw: "x".repeat(100) })) }, ok: true };
  const small = await compactWorkbenchReport(project, original);
  assert.equal(small.report.compact, true);
  assert.equal(small.report.allocator_webs.length, 10);
  assert.equal(small.report.arrayCounts.events, 3000);
  assert.ok(JSON.stringify(small).length < 4000);
  assert.deepEqual(JSON.parse(await readFile(small.reportArtifact.path, "utf8")), original.report);
  assert.equal(await compactWorkbenchReport(project, original, { detail: true }), original);
});
