// Report 2026-09-15 §4.1: the gate should flag "suspicious padding, empty
// branches, self-assignments, synthetic one-element locals, ABI-changing casts
// and new global writes WITHOUT pretending all such patterns are automatically
// wrong."
//
// The last clause is the hard part. Real source declares [1] arrays and casts
// pointers; a gate that calls those defects trains the caller to ignore it.
// So these three are `review`, and the negatives below are as load-bearing as
// the positives.
import { test } from "node:test";
import assert from "node:assert/strict";
import { semanticGate } from "../src/decomp/semantic-gate.js";

const ids = (r) => r.findings.map((f) => f.id);

test("a synthetic one-element local is flagged for review, not condemned", () => {
  const r = semanticGate({ candidateText: "void f(void){ Mtx sp48[1]; use(sp48); }" });
  assert.ok(ids(r).includes("one-element-array"));
  const f = r.findings.find((x) => x.id === "one-element-array");
  assert.equal(f.severity, "review", "a [1] array is legitimate in real source; it must not be 'artificial'");
});

test("a pointer cast is flagged as a possible ABI change", () => {
  const r = semanticGate({ candidateText: "void f(void){ guMtxIdent((Mtx_t *)&sp48); }" });
  const f = r.findings.find((x) => x.id === "pointer-cast");
  assert.ok(f, "pointer cast not detected");
  assert.equal(f.severity, "review");
  assert.match(f.message, /callee/, "the message should point at the callee's declared parameter");
});

test("ordinary source trips neither new check", () => {
  const r = semanticGate({ candidateText: "void f(s32 n){ s32 i; for (i = 0; i < n; i++) { g(i); } }" });
  for (const bad of ["one-element-array", "pointer-cast", "global-write-added"]) {
    assert.ok(!ids(r).includes(bad), `false positive: ${bad}`);
  }
});

test("a global WRITE the baseline never made is flagged", () => {
  const r = semanticGate({
    baselineText: "void f(void){ s32 t; t = D_801C2938[0].unk338; use(t); }",
    candidateText: "void f(void){ s32 t; D_801C2C70 = 0; t = D_801C2938[0].unk338; use(t); }",
  });
  const f = r.findings.find((x) => x.id === "global-write-added");
  assert.ok(f, "new global write not detected");
  assert.match(f.message, /D_801C2C70/);
});

test("reading a global more often is NOT a global write", () => {
  // The distinction the report asks for: a store changes what others read; a
  // load does not. Conflating them would flag most real refactors.
  const r = semanticGate({
    baselineText: "void f(void){ use(D_801C2938[0]); }",
    candidateText: "void f(void){ use(D_801C2938[0]); use(D_801C2938[1]); }",
  });
  assert.ok(!ids(r).includes("global-write-added"), "a read was reported as a write");
});

test("a global the baseline ALSO wrote is not 'new'", () => {
  const r = semanticGate({
    baselineText: "void f(void){ D_801C2C70 = 1; }",
    candidateText: "void f(void){ D_801C2C70 = 2; }",
  });
  assert.ok(!ids(r).includes("global-write-added"));
});

test("exactness is never overwritten by source quality", () => {
  const r = semanticGate({ candidateText: "void f(void){ Mtx sp48[1]; }", exactFunctionMatch: true, functionLocal: "exact" });
  assert.equal(r.exactFunctionMatch, true, "the gate must not erase the exactness result");
  assert.match(r.classification, /byte-exact/);
});
