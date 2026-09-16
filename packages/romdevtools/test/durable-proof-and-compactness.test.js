// Report 2026-09-15 §11: durable proof, restart recovery and concise output.
//
//   "Keep build logs under immutable per-integration paths rather than relying
//    only on `last-build.log`. Successful recovery should not become
//    unverifiable when another build runs."
//   "callers should be able to discover live versus terminal jobs from
//    authoritative process/job state"
//   "Default compare responses should be compact, with optional detail ...
//    Keep all raw details available by reference."
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const read = (p) => readFile(new URL(p, import.meta.url), "utf8");

test("each build writes its own immutable log, not only last-build.log", async () => {
  const s = await read("../src/decomp/integrate.js");
  assert.match(s, /builds/, "no per-build log directory");
  assert.match(s, /build-\$\{stamp\}\.log/, "the log path must be unique per build");
  assert.match(s, /logIsImmutable: true/);
  // The convenience pointer stays, so existing callers do not break.
  assert.match(s, /last-build\.log/);
});

test("an integration writes a proof bundle with the fields the report listed", async () => {
  const s = await read("../src/decomp/integrate.js");
  const bundle = s.match(/const bundle = \{[\s\S]*?\n    \};/)?.[0] ?? "";
  assert.ok(bundle, "no proof bundle");
  for (const field of [
    "symbol", "segment", "va", "tu", "object", "romOffset",     // exact target identity
    "patch", "preIntegrationOwner", "ownerSha256Before",          // source + ancestry
    "candidateSha256", "compiler", "buildCommand",                // toolchain fingerprints
    "baseSha1", "builtSha1", "byteExact", "log",                  // build + ROM evidence
  ]) {
    assert.match(bundle, new RegExp(field), `the proof bundle omits '${field}'`);
  }
});

test("the proof bundle separates this operation's contribution from project totals", async () => {
  const s = await read("../src/decomp/integrate.js");
  assert.match(s, /do not read a project-wide percentage as this operation's contribution/i);
});

test("byte-exactness is never recorded as source-quality approval", async () => {
  const s = await read("../src/decomp/integrate.js");
  assert.match(s, /byte-exactness is not source-quality approval/i);
});

test("a proof bundle that cannot be written does not fail the integration silently", async () => {
  const s = await read("../src/decomp/integrate.js");
  assert.match(s, /proofError/, "a missing proof must be reported to the caller");
});

test("job liveness comes from the OS, not from a status field a dead process left behind", async () => {
  const s = await read("../src/decomp/jobs.js");
  const block = s.match(/export async function listJobs[\s\S]*?\n\}/)?.[0] ?? "";
  // Assert the BEHAVIOUR, not one spelling of it. This originally required the
  // literal `isAlive(s.pid)` inside listJobs; a later refactor moved the OS
  // check into jobStatus (and added PID-ownership verification on top), so the
  // test failed while the behaviour was intact and better. What must hold is
  // that lifecycle derives from process state, not from the stored status.
  assert.match(s, /function isAlive\(pid\)[\s\S]*?process\.kill\(pid, 0\)/,
    "liveness must ultimately be an OS check");
  assert.match(block, /const live = s\.alive|isAlive\(s\.pid\)/,
    "listJobs must take liveness from the process-derived field, not from rec.status");
  assert.match(block, /lifecycle/);
  assert.match(block, /abandoned/, "a 'running' record with no live process is abandoned, not in progress");
  assert.match(block, /will not make further progress/i);
});

test("the compact compare response omits the bulky fields but keeps the verdict", async () => {
  const s = await read("../src/mcp/tools/decomp.js");
  const block = s.match(/if \(args\.detail !== true\) \{[\s\S]*?\n          \}/)?.[0] ?? "";
  assert.ok(block, "no compact branch in op:'compare'");
  // Bulky fields are destructured OUT.
  for (const f of ["compiler", "diffPreview", "changedRanges"]) {
    assert.match(block, new RegExp(`\\b${f}\\b`), `'${f}' should be handled by the compact branch`);
  }
  // The verdict and artifact pointers must survive.
  assert.match(block, /residuals:/);
  assert.match(block, /detail:/);
  assert.match(block, /nextStep:/);
  assert.match(block, /also on disk at the paths in `artifacts`/,
    "the response must say where the omitted detail lives");
});

test("detail:true is available and defaults to false", async () => {
  const s = await read("../src/mcp/tools/decomp.js");
  assert.match(s, /detail: z\.boolean\(\)\.default\(false\)/);
});
