// Opt-in real HTTP/IDO contract tests. Never edits the registered checkout.
// ROMDEV_AUDIT_URL=http://127.0.0.1:7332 node --test test/decomp-measurement-live.test.js
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile, writeFile, mkdtemp } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
const url = process.env.ROMDEV_AUDIT_URL;
const project = process.env.ROMDEV_AUDIT_PROJECT ?? "wr64-us-rev1";
const symbol = "func_8004EAA4";
const candidatePath = process.env.ROMDEV_AUDIT_CANDIDATE ?? path.join(os.homedir(), ".romdev/decomp", project,
  "candidates/func_8004EAA4/3d47c0df671e0c1fca69-947be21c958209e6-v2.c");
async function call(args) {
  const response = await fetch(`${url}/tool/decomp`, { method: "POST",
    headers: { "Content-Type": "application/json", "x-romdev-session": "throughput-live-tests", "x-romdev-agent": "throughput-implementation" },
    body: JSON.stringify({ project, symbol, ...args }) });
  const result = await response.json();
  assert.equal(response.ok, true, JSON.stringify(result));
  return result;
}

test("HTTP actual compiler: cache identity, compact evidence, saved owners, variants, and current selection", { skip: !url }, async () => {
  const detailed = await call({ op: "compare", candidatePath, detail: true, noCache: true });
  assert.equal(detailed.compileSucceeded, true);
  assert.equal(detailed.measurementValidity.state, "valid");
  const compact = await call({ op: "compare", candidatePath });
  assert.equal(compact.cacheHit, true);
  assert.equal(compact.residuals.registerSubstitutions, detailed.evidence.registerSubstitutions.count);
  assert.deepEqual(compact.residuals.frame, detailed.evidence.stackFrame);
  assert.deepEqual(compact.residuals.instructionCount, detailed.evidence.instructionCount);

  const declarations = "#error ROMDEV_AUDIT_DECLARATIONS_MUST_BE_COMPILED";
  const rejected = await call({ op: "compare", candidatePath, declarations, detail: true });
  assert.equal(rejected.cacheHit, false);
  assert.equal(rejected.compileSucceeded, false);
  assert.notEqual(rejected.inputIdentity.sha256, detailed.inputIdentity.sha256);
  assert.ok(rejected.diagnostics.some((d) => d.message.includes("ROMDEV_AUDIT_DECLARATIONS")));
  const rejectedFresh = await call({ op: "compare", candidatePath, declarations, detail: true, noCache: true });
  assert.equal(rejectedFresh.compileSucceeded, rejected.compileSucceeded);

  const weak = await call({ op: "compare", candidatePath, verifyTu: false, detail: true });
  assert.equal(weak.verification.translationUnit, "not-run");
  assert.notEqual(weak.verificationIdentity, detailed.verificationIdentity);
  const strong = await call({ op: "compare", candidatePath, verifyTu: true, detail: true });
  assert.notEqual(strong.verification.translationUnit, "not-run");

  const status = await call({ op: "status" });
  const ownerText = await readFile(path.join(status.root, detailed.function.tu), "utf8");
  const tmp = await mkdtemp(path.join(os.tmpdir(), "romdev-owner-replay-"));
  const ownerPath = path.join(tmp, "owner.c");
  await writeFile(ownerPath, ownerText);
  const before = await call({ op: "compare", candidatePath, ownerPath, detail: true });
  // Unique content per run: identical saved-owner contents may legitimately
  // hit an artifact from a previous run, irrespective of its temporary path.
  await writeFile(ownerPath, ownerText + `\n/* saved-owner identity regression ${tmp} */\n`);
  const after = await call({ op: "compare", candidatePath, ownerPath, detail: true });
  assert.equal(after.cacheHit, false);
  assert.notEqual(before.inputIdentity.sha256, after.inputIdentity.sha256);
  assert.equal(after.inputIdentity.ownerMode, "saved");

  const text = await readFile(candidatePath, "utf8");
  const batch = await call({ op: "variants", candidatePath, threads: 2,
    variants: [
      { id: "comment-only", lever: "comment-control", hypothesis: "control: a trailing comment should preserve instructions", candidateText: text + "\n/* comment only */\n" },
      { id: "extern-order", lever: "declaration-order", hypothesis: "test only the order of these two extern declarations", find: "extern s32 D_80192494;\nextern s32 D_800D4724;", replace: "extern s32 D_800D4724;\nextern s32 D_80192494;" },
    ] });
  assert.equal(batch.snapshotStable, true);
  assert.equal(batch.threads, 2);
  assert.equal(batch.dependencySnapshot, detailed.compiler.dependencyHash);
  assert.equal(batch.rows[1].instructionIdenticalTo, "baseline");
  assert.ok(batch.experiment.id);
  const diagnosis = await call({ op: "diagnose" });
  assert.equal(diagnosis.selection.freshness, "current");
  assert.equal(diagnosis.selection.candidate.dependencyHash, detailed.compiler.dependencyHash);
  const pinned = await call({ op: "diagnose", artifactId: detailed.artifacts.diff });
  const lever = pinned.groups.flatMap(g => g.experiments).find(e => e.id === "declaration-order");
  assert.equal(lever.historyState, "previously-tested-inputs-exist");
  assert.ok(lever.priorOutcomes.some(p => p.outcome === "tested-unchanged"));
  const workbench = await call({ op: "workbench", wbGroup: "object", wbCommand: "diagnose", artifactId: detailed.artifacts.diff });
  assert.equal(workbench.ok, true, JSON.stringify(workbench));
  assert.equal(workbench.artifactProvenance.outputIdentity.sha256, detailed.outputIdentity.sha256);

  const planArgs = { op: "plan", tu: detailed.function.tu, cooldownBatches: 1, objective: "function-count", limit: 500 };
  const cooled = (await call(planArgs)).queue.find(r => r.symbol === symbol);
  assert.ok(cooled, "measured unfinished target must appear in the live plan");
  assert.equal(cooled.evidenceFreshness, "current");
  assert.equal(cooled.cooldown.active, true, JSON.stringify(cooled.cooldown));
  const override = (await call({ ...planArgs, ignoreCooldown: true })).queue.find(r => r.symbol === symbol);
  assert.equal(override.cooldown.active, false);
  assert.equal(override.objectiveScore, cooled.objectiveScore * 10);
  const novel = (await call({ ...planArgs, proposedLever: `public-regression-new-lever-${tmp}` })).queue.find(r => r.symbol === symbol);
  assert.equal(novel.cooldown.active, false);
  assert.match(novel.cooldown.reason, /new proposed lever/);
});

test("HTTP bounded search: prior-scope refusal, explicit rerun, active cancellation and durable report", { skip: !url, timeout: 30_000 }, async () => {
  const seed = String(Date.now() % 0xffffffff);
  const args = { op: "search", candidatePath, purpose: "public restart regression: bounded declaration-order hypothesis",
    family: "declaration-order", mutationPasses: ["perm_reorder_decls"], threads: 1, timeLimitS: 10, noImprovementS: 1, seed };
  const first = await call(args);
  const terminal = async jobId => {
    const until = Date.now() + 15_000;
    let status;
    do {
      await new Promise(resolve => setTimeout(resolve, 100));
      status = await call({ op: "job", jobId });
    } while (status.alive && Date.now() < until);
    assert.equal(status.alive, false, JSON.stringify(status));
    return status;
  };
  try {
    const done = await terminal(first.jobId);
    assert.equal(done.status, "complete-no-progress");
    assert.equal(done.improvements, 0);
    const unchanged = await call({ op: "job", action: "cancel", jobId: first.jobId });
    assert.equal(unchanged.status, done.status);
    const refused = await fetch(`${url}/tool/decomp`, { method: "POST",
      headers: { "Content-Type": "application/json", "x-romdev-session": "throughput-live-tests" },
      body: JSON.stringify({ project, symbol, ...args }) });
    const error = await refused.json();
    assert.equal(refused.ok, false, JSON.stringify(error));
    assert.match(JSON.stringify(error), /already made no improvement/);
    const active = await call({ ...args, repeatSearch: true, noImprovementS: 10 });
    try {
      assert.equal((await call({ op: "job", jobId: active.jobId })).alive, true);
      await call({ op: "job", action: "cancel", jobId: active.jobId });
      assert.equal((await terminal(active.jobId)).status, "cancelled");
      const report = await call({ op: "job", action: "report", jobId: active.jobId, maxFunctions: 1 });
      assert.equal(report.accounting.terminationReason, "cancelled");
      assert.ok((await readFile(path.join(path.dirname(active.permuterDir), "base.c"), "utf8")).length);
    } finally { await call({ op: "job", action: "cancel", jobId: active.jobId }); }
  } finally { await call({ op: "job", action: "cancel", jobId: first.jobId }); }
});
