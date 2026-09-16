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
  assert.match(s.interpretation, /every case carries its expectation/i);
});

test("a missing fixture is skipped, never counted as a pass", () => {
  const s = summarize([{ id: "x", passed: false, skipped: true, ms: 1 }]);
  assert.equal(s.passed, 0);
  assert.equal(s.skipped, 1);
  assert.equal(s.failed, 0);
});
