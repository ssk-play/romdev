import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, mkdir, readdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { startSearch, searchLogProgress, searchBaseline, jobStatus, cancelJob, jobReport } from "../src/decomp/jobs.js";
import { Project, sha256Text } from "../src/decomp/project.js";
import { compileAndCompare } from "../src/decomp/compile.js";

test("search refuses unidentified baselines and unstated purpose before creating a job", async () => {
  const args = { project: {}, fn: { symbol: "f" }, baseCandidateText: "void f() {}" };
  await assert.rejects(startSearch(args), e => e.code === "PREFLIGHT_REQUIRED");
  await assert.rejects(startSearch({ ...args, preflight: { compileSucceeded: true, measurementValidity: { state: "valid" },
    inputIdentity: { sha256: "identity", candidateSha256: sha256Text(args.baseCandidateText) } } }), e => e.code === "SEARCH_PURPOSE_REQUIRED");
});

test("normalized zero/nonexact is classified as a scorer blind spot, never exactness", async () => {
  assert.equal(searchLogProgress("base score = 0\nFound zero score!", { exactFunctionMatch: false }).normalizedZeroNonExact, true);
  const ws = await mkdtemp(path.join(os.tmpdir(), "romdev-search-zero-")), dir = path.join(ws, "jobs", "fixture");
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, "permuter.log"), "base score = 0\nFound zero score!\n");
  await writeFile(path.join(dir, "job.json"), JSON.stringify({ status: "running", startedAt: new Date().toISOString(),
    log: path.join(dir, "permuter.log"), permuterDir: dir, preflight: { exactFunctionMatch: false } }));
  const s = await jobStatus({ ws }, "fixture");
  assert.equal(s.status, "complete-scorer-blind-spot");
  assert.equal(s.normalizedZeroNonExact, true);
  assert.equal(s.exactFunctionMatch, undefined);
});

test("actual search baseline rejects stale headers/environment, wrong context, and edit-restore during preparation", {
  skip: process.env.ROMDEV_DECOMP_INTEGRATION !== "1", timeout: 30_000,
}, async () => {
  const project = await Project.open("wr64-us-rev1"), originalWs = project.ws;
  Object.defineProperty(project, "ws", { value: await mkdtemp(path.join(os.tmpdir(), "romdev-search-freshness-")) });
  const fn = await project.resolveFunction({ symbol: "func_8004EAA4" });
  const header = path.join(project.ws, "search-header.h");
  const headerText = "/* stable search fixture */\n";
  await writeFile(header, headerText);
  const text = `#include "${header}"\n` + await readFile(path.join(originalWs,
    "candidates/func_8004EAA4/3d47c0df671e0c1fca69-947be21c958209e6-v2.c"), "utf8");
  const baseline = await compileAndCompare(project, fn, { candidateText: text, noCache: true });
  assert.equal(baseline.compileSucceeded, true);
  const request = { project, fn, baseCandidateText: text, preflight: searchBaseline(baseline),
    purpose: "test search freshness before spending budget", timeLimitS: 2, threads: 1 };
  await assert.rejects(startSearch({ ...request, fn: { ...fn, segment: "wrong-overlay" } }),
    e => e.code === "PREFLIGHT_CONTEXT_MISMATCH");
  await writeFile(header, "/* changed header */\n");
  await assert.rejects(startSearch(request), e => e.code === "PREFLIGHT_STALE");
  await writeFile(header, headerText);
  const priorEnv = project.env;
  try {
    Object.defineProperty(project, "env", { configurable: true, value: { ...priorEnv, ROMDEV_SEARCH_FRESHNESS_FIXTURE: "changed" } });
    await assert.rejects(startSearch(request), e => e.code === "PREFLIGHT_STALE");
  } finally { delete project.env; }
  const ownerPath = path.join(project.ws, "saved-owner.c");
  await writeFile(ownerPath, await readFile(project.abs(fn.source.tu), "utf8"));
  const saved = await compileAndCompare(project, fn, { candidateText: text, ownerPath, noCache: true });
  await assert.rejects(startSearch({ ...request, preflight: searchBaseline(saved) }),
    e => e.code === "PREFLIGHT_CONTEXT_MISMATCH");
  assert.deepEqual(await readdir(path.join(project.ws, "jobs")).catch(() => []), []);
  const invocation = project.compileInvocation.bind(project);
  let calls = 0;
  project.compileInvocation = async (...args) => {
    // Validation resolves the invocation twice (dependency + complete identity).
    // The third invocation belongs to preparing the actual search input.
    if (++calls === 3) {
      await writeFile(header, "/* transient mutation */\n");
      await writeFile(header, headerText);
    }
    return invocation(...args);
  };
  await assert.rejects(startSearch(request), e => e.code === "PREFLIGHT_STALE");
  const jobs = await readdir(path.join(project.ws, "jobs"));
  assert.equal(jobs.length, 1);
  const marker = JSON.parse(await readFile(path.join(project.ws, "jobs", jobs[0], "preparation-invalid.json"), "utf8"));
  assert.equal(marker.spawned, false);
  assert.ok(!(await readdir(path.join(project.ws, "jobs", jobs[0]))).includes("job.json"));
});

test("real backend honors restricted passes and a bounded search policy; cancellation preserves artifacts", {
  skip: process.env.ROMDEV_DECOMP_INTEGRATION !== "1", timeout: 30_000,
}, async () => {
  const project = await Project.open("wr64-us-rev1"), originalWs = project.ws;
  Object.defineProperty(project, "ws", { value: await mkdtemp(path.join(os.tmpdir(), "romdev-search-policy-")) });
  const fn = await project.resolveFunction({ symbol: "func_8004EAA4" });
  const text = await readFile(path.join(originalWs, "candidates/func_8004EAA4/3d47c0df671e0c1fca69-947be21c958209e6-v2.c"), "utf8");
  const baseline = await compileAndCompare(project, fn, { candidateText: text, noCache: true });
  const request = { project, fn, baseCandidateText: text, preflight: searchBaseline(baseline),
    purpose: "regression: bounded declaration-order mutation policy on a measured allocation residue",
    family: "declaration-order", mutationPasses: ["perm_reorder_decls"], seed: "73", threads: 1, timeLimitS: 10, noImprovementS: 2 };
  const j = await startSearch(request);
  try {
    const settings = await readFile(path.join(j.permuterDir, "settings.toml"), "utf8");
    assert.match(settings, /perm_reorder_decls = 1\.0/);
    assert.match(settings, /perm_sameline = 0\.0/);
    let status;
    const deadline = Date.now() + 15_000;
    do {
      await new Promise(resolve => setTimeout(resolve, 250));
      status = await jobStatus(project, j.jobId);
    } while (status.alive && Date.now() < deadline);
    assert.equal(status.alive, false, JSON.stringify(status));
    assert.notEqual(status.status, "failed", JSON.stringify(status));
    assert.ok(["complete-no-progress", "complete-scorer-blind-spot", "complete-budget", "complete-zero"].includes(status.status));
    const report = await jobReport(project, j.jobId, { maxOutputs: 2 });
    assert.deepEqual(report.accounting.mutationFamilies.enabledExclusively, ["perm_reorder_decls"]);
    assert.ok(report.purpose);
    const cancelled = await cancelJob(project, j.jobId);
    assert.equal(cancelled.status, status.status, "a completed search must retain its termination reason");
    assert.equal(cancelled.cancellationRequested, false);
    if (["complete-no-progress", "complete-budget"].includes(status.status) && !status.improvements) {
      await assert.rejects(startSearch(request), e => e.code === "SEARCH_SCOPE_ALREADY_TESTED");
    }
    assert.ok((await readFile(j.log, "utf8")).length);
    const active = await startSearch({ ...request, repeatSearch: true, timeLimitS: 15, noImprovementS: 10 });
    try {
      assert.equal((await jobStatus(project, active.jobId)).alive, true);
      await cancelJob(project, active.jobId);
      let stopped;
      const until = Date.now() + 3000;
      do { await new Promise(resolve => setTimeout(resolve, 50)); stopped = await jobStatus(project, active.jobId); }
      while (stopped.alive && Date.now() < until);
      assert.equal(stopped.alive, false);
      assert.equal(stopped.status, "cancelled");
      assert.equal(await readFile(path.join(active.dir, "base.c"), "utf8"), text);
    } finally { await cancelJob(project, active.jobId); }
  } finally { await cancelJob(project, j.jobId); }
});
