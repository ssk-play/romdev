import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { compilationIdentity, instructionIdentity, residualSummary, batchSnapshot, measurementSnapshot, fileIdentities } from "../src/decomp/measurement.js";
import { runVariantBatch } from "../src/decomp/variants.js";
import { loadCandidateEvidence } from "../src/decomp/plan.js";
import { selectArtifact } from "../src/decomp/artifact-select.js";
import { currentMeasurement } from "./helpers/current-measurement.js";
import { VERIFIER_VERSION } from "../src/decomp/verdict.js";

test("compilation identity covers declarations, owner contents, dependencies, flags, and tools", () => {
  const base = { symbol: "f", segment: "s", tu: "f.c", dependencyHash: "dep", candidateText: "void f() {}",
    declarations: "", ownerText: "owner", invocation: ["cc"], toolchain: "compiler", env: {}, candidateDependencies: "headers" };
  const id = compilationIdentity(base);
  assert.equal(compilationIdentity({ ...base }).sha256, id.sha256);
  for (const key of ["declarations", "ownerText", "dependencyHash", "candidateText", "invocation", "toolchain", "candidateDependencies", "segment"]) {
    assert.notEqual(compilationIdentity({ ...base, [key]: "changed" }).sha256, id.sha256, key);
  }
  assert.notEqual(compilationIdentity({ ...base, savedOwner: true }).sha256, id.sha256);
});

test("compact residual projection preserves real evidence and unknown is not zero", () => {
  const evidence = { registerSubstitutions: { count: 9 }, branchTargetDifferences: { count: 2 },
    stackFrame: { target: "-24", candidate: "-32" }, instructionCount: { target: 6, candidate: 8 }, reordered: true };
  const r = { evidence, strictMismatches: 9, romLinked: { status: "mismatch", mismatches: 9 } };
  const s = residualSummary(r);
  assert.equal(s.registerSubstitutions, 9);
  assert.deepEqual(s.frame, evidence.stackFrame);
  assert.deepEqual(s.instructionCount, evidence.instructionCount);
  assert.equal(s.scheduling, true);
  assert.equal(residualSummary({ compileSucceeded: false }).registerSubstitutions, null);
  assert.equal(residualSummary({ evidence: { registerSubstitutions: { count: 0 } } }).registerSubstitutions, 0);
});

const result = (word, dep = "current") => ({ compileSucceeded: true, compiler: { dependencyHash: dep, fingerprint: "compiler" },
  inputIdentity: { ownerMode: "live", ownerSha256: "owner", toolchain: [], env: {} }, referenceHash: "reference",
  strictMismatches: 1, romLinked: { status: "mismatch", mismatches: 1 }, candidateBytes: 4, differenceKinds: ["register-allocation"],
  evidence: { registerSubstitutions: { count: 1 } }, measurementValidity: { state: "valid" },
  outputIdentity: instructionIdentity([{ word }]), artifacts: {} });

test("equal scores with different actual instruction bytes are not identical", async () => {
  let n = 0;
  const out = await runVariantBatch({}, { symbol: "f" }, { baselineText: "base",
    variants: [{ id: "a", candidateText: "a" }, { id: "b", candidateText: "b" }], compare: async () => result(++n) });
  assert.equal(out.instructionIdentical, 0);
  assert.equal(out.uniqueInstructionOutputs, 3);
  assert.equal(out.snapshotStable, true);
  assert.ok(out.rows.every((r) => !r.byteIdenticalTo));
});

test("instruction identity includes relocations and explicitly excludes rodata", () => {
  const a = instructionIdentity([{ word: 0, reloc: { type: "R_MIPS_26", symbol: "a" } }]);
  const b = instructionIdentity([{ word: 0, reloc: { type: "R_MIPS_26", symbol: "b" } }]);
  assert.notEqual(a.sha256, b.sha256);
  assert.equal(a.scope, "function-instructions-and-relocations");
  assert.equal(instructionIdentity([{ mnemonic: "nop" }]), null);
});

test("batch uses compiler hashes; missing and invalid identities never claim stability", () => {
  const row = (r) => ({ metrics: {}, snapshot: measurementSnapshot(r) });
  assert.equal(batchSnapshot([row(result(1)), row(result(2, "changed"))]).snapshotStable, false);
  assert.equal(batchSnapshot([row({})]).snapshotStable, null);
  assert.equal(batchSnapshot([row({ ...result(1), measurementValidity: { state: "invalid" } })]).snapshotStable, false);
  assert.equal(batchSnapshot([row(result(1)), row({ ...result(2), inputIdentity: { ...result(2).inputIdentity, toolchain: ["different binary"] } })]).snapshotStable, false);
  assert.equal(batchSnapshot([row({ ...result(1), referenceHash: undefined })]).snapshotStable, null);
});

async function evidenceFixture() {
  const ws = await mkdtemp(path.join(os.tmpdir(), "romdev-current-evidence-"));
  const dir = path.join(ws, "candidates", "f");
  await mkdir(dir, { recursive: true });
  const project = { ws };
  const r = { ...result(1, "abc"), distance: { value: 1 }, verifierVersion: VERIFIER_VERSION,
    ...await currentMeasurement(project) };
  await writeFile(path.join(dir, "abc-def-v2.result.json"), JSON.stringify(r));
  await writeFile(path.join(dir, "abc-def-v2.diff.json"), "{}");
  return Object.assign(project, { dir, r });
}

test("unmatched or unavailable current identity never promotes historical attempts", async () => {
  const p = await evidenceFixture();
  for (const currentDependencyHashes of [undefined, new Set(["nonexistent"]), new Map([["f", null]])]) {
    const ev = await loadCandidateEvidence(p, { currentDependencyHashes });
    assert.equal(ev.f.attempts, 0);
    assert.equal(ev.f.lastDistance, null);
    assert.equal(ev.f.historicalAttempts, 1);
  }
  assert.equal((await loadCandidateEvidence(p, { currentDependencyHashes: new Map([["f", "abc"]]) })).f.attempts, 1);
});

test("default artifact selection requires current evidence, and excludes saved owners", async () => {
  const p = await evidenceFixture();
  await assert.rejects(selectArtifact(p, "f", { currentDependencyHash: "other" }), { code: "NO_CURRENT_ARTIFACT" });
  assert.equal((await selectArtifact(p, "f", { currentDependencyHash: "abc" })).freshness, "current");
  p.r.inputIdentity.ownerMode = "saved";
  await writeFile(path.join(p.dir, "abc-def-v2.result.json"), JSON.stringify(p.r));
  await assert.rejects(selectArtifact(p, "f", { currentDependencyHash: "abc" }), { code: "NO_CURRENT_ARTIFACT" });
  assert.equal((await loadCandidateEvidence(p, { currentDependencyHashes: new Set(["abc"]) })).f.attempts, 0);
});

test("candidate-only headers and replaced tool binaries invalidate consumers even when owner dependency hash stays equal", async () => {
  const p = await evidenceFixture();
  const header = path.join(p.ws, "candidate-only.h"), compiler = path.join(p.ws, "compiler"), reference = path.join(p.ws, "target.s");
  await writeFile(header, "header-v1"); await writeFile(compiler, "compiler-v1"); await writeFile(reference, "reference-v1");
  p.m.toolchain.compiler = { path: compiler };
  Object.assign(p.r, await currentMeasurement(p));
  p.r.candidateDependencyFiles = await fileIdentities([header]);
  p.r.referenceFiles = await fileIdentities([reference]);
  await writeFile(path.join(p.dir, "abc-def-v2.result.json"), JSON.stringify(p.r));
  for (const [file, original] of [[header, "header-v1"], [compiler, "compiler-v1"], [reference, "reference-v1"]]) {
    assert.equal((await selectArtifact(p, "f", { currentDependencyHash: "abc" })).freshness, "current");
    await writeFile(file, "changed-with-identical-owner-dep");
    await assert.rejects(selectArtifact(p, "f", { currentDependencyHash: "abc" }), { code: "NO_CURRENT_ARTIFACT" });
    const evidence = await loadCandidateEvidence(p, { currentDependencyHashes: new Map([["f", "abc"]]) });
    assert.equal(evidence.f.attempts, 0);
    await writeFile(file, original);
  }
  assert.equal((await selectArtifact(p, "f", { currentDependencyHash: "abc" })).freshness, "current");
});
