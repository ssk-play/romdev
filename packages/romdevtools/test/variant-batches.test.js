// Report 2026-09-15 §7: "We repeatedly wrote ad hoc Node scripts to load a
// candidate, construct three small variants, call compare serially, and print
// only useful fields."
//
// Acceptance: "Repeating a batch gives equivalent outcomes; duplicate variants
// are identified; an intentionally malformed candidate does not abort
// unrelated variants."
import { test } from "node:test";
import assert from "node:assert/strict";
import { applyPatch, metricsOf, runVariantBatch } from "../src/decomp/variants.js";

const BASE = "s32 f(s32 a) {\n    if (a == 1) { return 2; }\n    return 3;\n}\n";
const fn = { symbol: "f", segment: "seg", vaHex: "0x80000000", source: { tu: "src/x.c" } };

// A compare stub shaped like the REAL stored result (flat fields), because
// guessing the shape produced a table of nulls that still looked like it ran.
const fakeResult = (over = {}) => ({
  compileSucceeded: true, strictMismatches: 5, targetBytes: 100, candidateBytes: 100,
  romLinked: { status: "mismatch", mismatches: 2 }, evidence: { registerSubstitutions: { count: 1 }, reordered: false },
  differenceKinds: ["register-allocation"], distance: { value: 5 },
  compiler: { dependencyHash: "hash1", fingerprint: "compiler1" },
  measurementValidity: { state: "valid" },
  inputIdentity: { ownerMode: "live", ownerSha256: "owner", toolchain: [], env: {} }, referenceHash: "reference",
  outputIdentity: { scope: "function-instructions-and-relocations", sha256: "instructions1" },
  artifacts: {}, ...over,
});

test("a patch that does not apply is refused, not silently ignored", () => {
  assert.throws(() => applyPatch(BASE, { find: "NOT PRESENT", replace: "x" }), (e) => {
    assert.equal(e.code, "PATCH_NOT_APPLIED");
    return true;
  });
});

test("a patch matching several sites is refused as ambiguous", () => {
  // A replacement that quietly hits three places is not the experiment the
  // caller described.
  assert.throws(() => applyPatch("a; a; a;", { find: "a", replace: "b" }), (e) => {
    assert.equal(e.code, "PATCH_AMBIGUOUS");
    assert.match(e.message, /matched 3 times/);
    return true;
  });
});

test("metrics are read from the real flat result shape", () => {
  const m = metricsOf(fakeResult());
  assert.equal(m.strictMismatches, 5, "strictMismatches is a top-level field");
  assert.equal(m.linkedMismatches, 2);
  assert.equal(m.targetBytes, 100);
  assert.equal(m.registerSubstitutions, 1);
});

test("a malformed variant fails alone and the batch continues", async () => {
  const seen = [];
  const compare = async ({ candidateText }) => { seen.push(candidateText); return fakeResult(); };
  const out = await runVariantBatch({}, fn, {
    baselineText: BASE, compare,
    variants: [
      { id: "bad", find: "NOT PRESENT", replace: "x" },
      { id: "good", find: "return 3;", replace: "return 4;" },
    ],
  });
  const bad = out.rows.find((r) => r.id === "bad");
  const good = out.rows.find((r) => r.id === "good");
  assert.match(bad.error, /PATCH_NOT_APPLIED/);
  assert.ok(good.metrics?.compiled, "an unrelated variant was aborted by a bad one");
  assert.equal(out.failed, 1);
});

test("duplicate variants are identified and not recompiled", async () => {
  let compiles = 0;
  const compare = async () => { compiles++; return fakeResult(); };
  const out = await runVariantBatch({}, fn, {
    baselineText: BASE, compare,
    variants: [
      { id: "v1", find: "return 3;", replace: "return 4;" },
      { id: "v1-again", find: "return 3;", replace: "return 4;" },
    ],
  });
  const dup = out.rows.find((r) => r.id === "v1-again");
  assert.equal(dup.duplicateOf, "v1");
  assert.equal(out.duplicates, 1);
  assert.equal(compiles, 2, "the duplicate was recompiled instead of being recognised (baseline + v1 = 2)");
});

test("byte-inert variants are reported rather than dropped", async () => {
  // Different source, identical compiled outcome: knowing a lever does nothing
  // is a result that was paid for.
  const compare = async () => fakeResult();
  const out = await runVariantBatch({}, fn, {
    baselineText: BASE, compare,
    variants: [
      { id: "a", find: "return 3;", replace: "return 4;" },
      { id: "b", find: "return 3;", replace: "return  4;" },
    ],
  });
  assert.equal(out.instructionIdentical, 2);
  assert.ok(out.rows.find((r) => r.instructionIdenticalTo === "baseline"));
});

test("a moving dependency hash invalidates the batch instead of mixing trees", async () => {
  let n = 0;
  const compare = async () => fakeResult({ compiler: { dependencyHash: `hash${n++}` } });
  const out = await runVariantBatch({}, fn, {
    baselineText: BASE, compare,
    variants: [{ id: "v1", find: "return 3;", replace: "return 4;" }],
  });
  assert.equal(out.snapshotStable, false);
  assert.match(out.snapshotWarning, /not comparable/i);
});

test("a failed compile stays in the table as a result", async () => {
  const compare = async ({ label }) => label?.includes("v1")
    ? fakeResult({ compileSucceeded: false, strictMismatches: null, diagnostics: [{ severity: "error", message: "boom" }] })
    : fakeResult();
  const out = await runVariantBatch({}, fn, {
    baselineText: BASE, compare,
    variants: [{ id: "v1", find: "return 3;", replace: "return 4;" }],
  });
  const row = out.rows.find((r) => r.id === "v1");
  assert.equal(row.metrics.compiled, false);
  assert.ok(row.diagnostics?.length, "the diagnostics of a failed variant must be retained");
});

test("metrics are never collapsed into one score", async () => {
  const compare = async () => fakeResult();
  const out = await runVariantBatch({}, fn, { baselineText: BASE, compare, variants: [{ id: "v1", find: "return 3;", replace: "return 4;" }] });
  const m = out.rows[1].metrics;
  for (const k of ["strictMismatches", "linkedMismatches", "candidateBytes", "registerSubstitutions", "scheduling"]) {
    assert.ok(k in m, `metric '${k}' must be reported separately`);
  }
  assert.match(out.policy, /never collapsed into one score/i);
});

test("bounded workers keep requested row order and output attribution despite reversed completion", async () => {
  let active = 0, peak = 0;
  const compare = async ({ label }) => {
    active++; peak = Math.max(peak, active);
    await new Promise(resolve => setTimeout(resolve, label === "variant:slow" ? 25 : 1));
    active--; return fakeResult();
  };
  const variants = [
    { id: "slow", candidateText: BASE + "// one" },
    { id: "fast", candidateText: BASE + "// two" },
    { id: "duplicate", candidateText: BASE + "// one" },
  ];
  const parallel = await runVariantBatch({}, fn, { baselineText: BASE, variants, compare, threads: 2 });
  assert.equal(peak, 2);
  assert.deepEqual(parallel.rows.map(r => r.id), ["baseline", "slow", "fast", "duplicate"]);
  assert.equal(parallel.rows[3].duplicateOf, "slow");
  assert.equal(parallel.rows[1].instructionIdenticalTo, "baseline");
  assert.equal(parallel.rows[2].instructionIdenticalTo, "baseline");
  assert.equal(parallel.threads, 2);
  await assert.rejects(runVariantBatch({}, fn, { baselineText: BASE, variants, compare, threads: 3 }), /1 or threads:2/);
});
