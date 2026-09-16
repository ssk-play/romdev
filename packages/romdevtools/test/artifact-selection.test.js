// Client reply 2026-09-15: a symbol-only `diagnose` call silently analysed an
// older, worse candidate -- 13 linked mismatches when the caller had already
// produced one with 11 and corrected stack homes. Both shared a dependency
// hash, so this was a bad DEFAULT, not stale evidence.
//
// The old default was "newest file", which records when a comparison was last
// RUN, not how good it is -- a developer re-running an old candidate while
// testing something else promotes it to "newest". That is exactly what
// happened.
import { test } from "node:test";
import assert from "node:assert/strict";
import { selectArtifact, SELECTION_POLICIES } from "../src/decomp/artifact-select.js";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { sha256Text } from "../src/decomp/project.js";
import { currentMeasurement } from "./helpers/current-measurement.js";
import { VERIFIER_VERSION } from "../src/decomp/verdict.js";

async function fixture(cands) {
  const ws = await mkdtemp(path.join(tmpdir(), "romdev-sel-"));
  const dir = path.join(ws, "candidates", "f");
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, "owner.c"), "owner");
  const project = { ws, resolveFunction: async () => ({ source: { tu: "x.c" } }),
    compileInvocation: async () => ({ compile: [], post: [], fingerprint: "test" }),
    tuDependencies: async () => ({ deps: [], ok: true }),
    abs: () => path.join(dir, "owner.c") };
  const measured = await currentMeasurement(project, "x.c");
  for (const c of cands) {
    const base = `dep-${c.sha}-v2`;
    await writeFile(path.join(dir, `${base}.diff.json`), "{}");
    await writeFile(path.join(dir, `${base}.result.json`), JSON.stringify({
      compileSucceeded: c.compiled !== false,
      strictMismatches: c.strict, romLinked: { status: "mismatch", mismatches: c.linked },
      exactFunctionMatch: !!c.exact,
      candidate: { sha256: c.sha }, compiler: { dependencyHash: sha256Text("testowner").slice(0, 20) },
      ...measured, verifierVersion: VERIFIER_VERSION,
    }));
    // Stagger mtimes so "newest" is deterministic.
    const t = new Date(Date.now() - (c.ageMs ?? 0));
    const { utimes } = await import("node:fs/promises");
    for (const ext of [".diff.json", ".result.json"]) await utimes(path.join(dir, base + ext), t, t);
  }
  return project;
}

test("the default picks the smallest residual, not the newest file", async () => {
  // The reported case: the worse candidate was compiled most recently.
  const project = await fixture([
    { sha: "better", linked: 11, strict: 13, ageMs: 60_000 },
    { sha: "worse", linked: 13, strict: 15, ageMs: 0 },
  ]);
  const sel = await selectArtifact(project, "f");
  assert.match(sel.path, /better/, "the newest-but-worse candidate was chosen again");
  assert.equal(sel.policy, "best");
  assert.equal(sel.candidate.linkedMismatches, 11);
});

test("the selection is always explained, with the alternatives", async () => {
  const project = await fixture([
    { sha: "a", linked: 11, strict: 13, ageMs: 60_000 },
    { sha: "b", linked: 13, strict: 15, ageMs: 0 },
  ]);
  const sel = await selectArtifact(project, "f");
  assert.match(sel.why, /fewest ROM-linked mismatches/);
  assert.equal(sel.totalArtifacts, 2);
  assert.ok(sel.alternatives?.length, "the caller must be able to see what else existed");
  assert.match(sel.note, /does NOT automatically describe your latest candidate/i);
});

test("prefer:'newest' follows the last experiment and DISCLOSES a better one", async () => {
  const project = await fixture([
    { sha: "better", linked: 11, strict: 13, ageMs: 60_000 },
    { sha: "newest", linked: 13, strict: 15, ageMs: 0 },
  ]);
  const sel = await selectArtifact(project, "f", { prefer: "newest" });
  assert.match(sel.path, /newest/);
  assert.ok(sel.betterCandidateNotChosen, "a better candidate passed over must be disclosed");
  assert.equal(sel.betterCandidateNotChosen.linkedMismatches, 11);
});

test("a failed compile never outranks a candidate that built", async () => {
  const project = await fixture([
    { sha: "broken", linked: null, strict: null, compiled: false, ageMs: 0 },
    { sha: "built", linked: 20, strict: 22, ageMs: 60_000 },
  ]);
  assert.match((await selectArtifact(project, "f")).path, /built/);
});

test("ties break by recency, and the tie is visible in alternatives", async () => {
  const project = await fixture([
    { sha: "older", linked: 11, strict: 13, ageMs: 60_000 },
    { sha: "newer", linked: 11, strict: 13, ageMs: 0 },
  ]);
  const sel = await selectArtifact(project, "f");
  assert.match(sel.path, /newer/);
  assert.ok(sel.alternatives.some((a) => /older/.test(a.artifact) && a.linkedMismatches === 11),
    "an equally good candidate must be listed so the caller can pick it");
});

test("an unknown preference is refused rather than silently defaulted", async () => {
  const project = await fixture([{ sha: "a", linked: 1, strict: 1 }]);
  await assert.rejects(() => selectArtifact(project, "f", { prefer: "whatever" }), (e) => {
    assert.equal(e.code, "BAD_ARGS");
    return true;
  });
});

test("no stored comparison is an actionable error", async () => {
  const project = await fixture([]);
  await assert.rejects(() => selectArtifact(project, "f"), (e) => {
    assert.equal(e.code, "NO_ARTIFACT");
    assert.match(e.message, /Run decomp\(\{op:'compare'/);
    return true;
  });
});

test("both policies are documented", () => {
  for (const k of ["best", "newest"]) assert.ok(SELECTION_POLICIES[k]?.length > 20);
});
