// Report 2026-09-15 §12: "Build a small, public-API replay suite from
// preserved candidates ... Do not mutate the production checkout or treat
// already-integrated current C as the original assembly fixture."
//
// And on measurement: "Report p50/p95 request timings only after collecting
// enough runs; do not extrapolate from a single compare."
import { test } from "node:test";
import assert from "node:assert/strict";
import { defaultCases, checkExpectations, timings, summarize } from "../src/decomp/replay.js";

const cases = () => defaultCases({ researchRoot: "/r", workspace: "/w" });

test("the evaluation set covers the cases the report enumerated", () => {
  const ids = cases().map((c) => c.id);
  for (const needle of ["i2-exact", "i3-five-word", "i3-reversed-branch", "i15-ceremony", "two-overlays", "stale-near-match", "semantically-wrong"]) {
    assert.ok(ids.some((id) => id.includes(needle)), `no case for '${needle}'`);
  }
});

test("an integrated function replays against its PRE-INTEGRATION owner", () => {
  // The accepted source is already in the current tree, so re-splicing it
  // yields `redeclaration of ...` -- a compile failure that looks like the
  // candidate's fault.
  const i2 = cases().find((c) => c.id.startsWith("i2-exact"));
  assert.ok(i2.ownerPathHint, "the integrated case must name a pre-integration owner");
  assert.match(i2.ownerPathHint, /orig\.c$/);
});

test("EVERY case rejects a wrong result", () => {
  // The control that must fail. A suite whose expectations accept anything
  // reports 7/7 and proves nothing.
  const wrong = {
    compileSucceeded: false, exactFunctionMatch: false, rodataState: "mismatch",
    traceAccepted: false, mechanisms: ["unclassified"], variantDeltaLinked: 99,
    frameDelta: 99, layoutShape: "identical", movedSlots: 0,
    distinctTargets: 1, distinctTus: 1, hasDrafts: false, claimedBestDistance: null, findingIds: [],
  };
  for (const k of cases()) {
    const fails = checkExpectations(k, wrong);
    assert.ok(fails.length > 0, `case '${k.id}' accepted a deliberately wrong result`);
  }
});

test("a correct result passes the same check", () => {
  const k = cases().find((c) => c.id === "semantically-wrong-but-plausible");
  assert.deepEqual(checkExpectations(k, { findingIds: ["pointer-cast", "global-write-added"] }), []);
});

test("percentiles are withheld until there are enough samples", () => {
  const few = timings([10, 20, 30]);
  assert.equal(few.p50, undefined, "p50 must not be reported from 3 samples");
  assert.match(few.note, /NOT reported/);
  const many = timings([1, 2, 3, 4, 5, 6, 7, 8]);
  assert.ok(Number.isFinite(many.p50) && Number.isFinite(many.p95));
});

test("the summary refuses to state a speedup", () => {
  const s = summarize([{ id: "x", passed: true, ms: 5 }]);
  assert.match(s.interpretation, /not a throughput benchmark/i);
  assert.match(s.interpretation, /cannot support a speedup figure/i,
    "the report said plainly that no before/after benchmark was run; inventing one would be the failure this suite exists to catch");
});

test("a case that merely completed is not a case that passed", () => {
  const s = summarize([{ id: "x", passed: false, ms: 5, failures: ["exactFunctionMatch: expected true, got false"] }]);
  assert.equal(s.passed, 0);
  assert.equal(s.failed, 1);
  assert.match(s.interpretation, /every row carries its request/i);
});

test("a missing fixture is skipped, never counted as a pass", () => {
  const s = summarize([{ id: "x", passed: false, skipped: true, ms: 1 }]);
  assert.equal(s.passed, 0);
  assert.equal(s.skipped, 1);
  assert.equal(s.failed, 0);
});

// --- Client reply 2026-09-15: the acceptance matrix ---
//
// "Publish an acceptance matrix with `passed`, `failed`, `partial`, `not run`,
// and `unsupported` where appropriate ... Seven passing cases prove those
// seven cases, not universal closure of the report."
//
// `partial` is the state the first summary lacked, and its absence is what let
// "Nothing is deferred" sit above a list of cases that were not delivered.

test("a case with unexercised scope is PARTIAL, never counted as passed", () => {
  const kase = { id: "x", status: "partial", op: "job-accounting", unexercised: "a fresh search launch" };
  const s = summarize([{ id: "x", passed: true, ms: 5, actual: {} }], [kase]);
  assert.equal(s.matrix.partial, 1);
  assert.equal(s.matrix.passed, 0, "a partial case must not be folded into passed");
  assert.match(s.rows[0].unexercised, /fresh search launch/);
});

test("the matrix carries all five states", () => {
  const s = summarize([], []);
  for (const k of ["passed", "partial", "failed", "not run", "unsupported"]) {
    assert.ok(k in s.matrix, `the matrix omits '${k}'`);
  }
});

test("every row ties a claim to its request, assertion and observation", () => {
  const kase = { id: "x", op: "diagnose", symbol: "func_A", segment: "ovl_1",
    candidatePath: "/r/a.c", why: "because", expect: { groupCountAtLeast: 1 } };
  const s = summarize([{ id: "x", passed: true, ms: 5, actual: { groupCount: 2 } }], [kase]);
  const row = s.rows[0];
  assert.equal(row.request.op, "diagnose");
  assert.equal(row.request.symbol, "func_A");
  assert.deepEqual(row.asserted, { groupCountAtLeast: 1 });
  assert.deepEqual(row.observed, { groupCount: 2 });
  assert.equal(row.requirement, "because");
});

test("coverage names the partial cases instead of rounding them up", () => {
  const s = summarize(
    [{ id: "a", passed: true, ms: 1 }, { id: "b", passed: true, ms: 1 }],
    [{ id: "a" }, { id: "b", status: "partial", unexercised: "the other half" }],
  );
  assert.match(s.coverage, /1 PARTIAL/);
  assert.match(s.interpretation, /proves THOSE cases and nothing wider/i);
});

test("a residual that is not merely scheduling must not be described as scheduling", () => {
  // The number-renderer entry-branch case: its one difference is a branch, not
  // a schedule, and an expectation that accepts "all scheduling" would hide it.
  const kase = { id: "n", expect: { mechanismsNotAll: ["scheduling-permutation"] } };
  assert.ok(checkExpectations(kase, { mechanisms: ["scheduling-permutation"] }).length > 0,
    "an all-scheduling diagnosis must fail this case");
  assert.equal(checkExpectations(kase, { mechanisms: ["branch-lowering"] }).length, 0);
});

test("the number-renderer cases are in the set, resolved from nonstandard filenames", () => {
  const ids = defaultCases({ researchRoot: "/r", workspace: "/w" }).map((c) => c.id);
  assert.ok(ids.some((i) => i.startsWith("number-renderer")),
    "§12.4 was skipped for 'no .c fixture' when the drafts sit at the research root under .c.txt names");
});

test("§12.6 is covered by BOTH the accounting and a real bounded launch", () => {
  // It sat at `partial` with "a fresh bounded search launch" unexercised.
  // Re-running the client's 300s search would only re-derive a recorded
  // result, but a 20s launch proves the same path, so the gap is closed by
  // running it rather than by relabelling.
  const cases = defaultCases({ researchRoot: "/r", workspace: "/w" });
  const accounting = cases.find((c) => c.id.startsWith("i5-"));
  const launch = cases.find((c) => c.id === "bounded-search-launch-end-to-end");
  assert.ok(accounting, "§12.6 accounting case missing");
  assert.ok(launch, "§12.6 launch case missing");
  assert.equal(accounting.status, undefined, "the accounting case should no longer be partial");
  assert.ok(launch.timeLimitS <= 30, "the launch case must be cheap enough to run every time");
  for (const k of ["preflightRan", "seedMapped", "terminatedOnBudget", "backendTraceback"]) {
    assert.ok(k in launch.expect, `the launch case does not assert '${k}'`);
  }
});

test("no case is left in a partial state without naming what is unexercised", () => {
  for (const c of defaultCases({ researchRoot: "/r", workspace: "/w" })) {
    if (c.status === "partial") {
      assert.ok(c.unexercised, `case '${c.id}' is partial but does not say what is unexercised`);
    }
  }
});
