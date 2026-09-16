// Report 2026-09-15 §4.2: on func_i2_802C7C50 the compare reported zero strict
// mismatches, exact linked bytes, unchanged siblings -- and
// exactFunctionMatch:false because rodata references were "target 0,
// candidate 1" for D_i2_802C8BD0. Full-ROM integration then succeeded
// byte-exact, proving the verdict wrong.
//
// Root cause: D_i2_802C8BD0 is declared in `.section .data, "wa"` in a
// SEPARATE object (asm/us/rev1/data/overlays/ovl_i2/ovl_1B9440.data.s). In the
// function's own object that symbol is undefined and carries no section, so
// target-side discovery enumerated nothing. The candidate's compiler emitted
// its own literal locally and did get a reference. Missing discovery was being
// converted into a proved semantic mismatch.
//
// §4.2 also demands negative fixtures so the fix does not simply ignore rodata.
import { test } from "node:test";
import assert from "node:assert/strict";
import { rodataState, aggregateVerdict } from "../src/decomp/verdict.js";

const EXACT_TEXT = { exact: true };
const EXACT_LINKED = { status: "exact" };

test("undiscoverable target rodata is a limitation, not a mismatch", () => {
  const rodata = {
    compared: false, applicable: false,
    references: { target: 0, candidate: 1 },
    limitation: "target-rodata-not-discoverable",
    reason: "the target object declares no .rodata references for this function, while the candidate has 1.",
  };
  const st = rodataState(rodata);
  assert.equal(st.state, "not-applicable", `expected not-applicable, got ${st.state}`);
  assert.match(st.reason, /LIMIT OF DISCOVERY|target object declares no/i);
});

test("the i2 shape yields exactFunctionMatch:true, matching the byte-exact integration", () => {
  const v = aggregateVerdict({
    strict: EXACT_TEXT,
    rodata: { compared: false, applicable: false, references: { target: 0, candidate: 1 },
      limitation: "target-rodata-not-discoverable", reason: "…" },
    romLinked: EXACT_LINKED,
  });
  assert.equal(v.functionLocal, "exact");
  assert.equal(v.exactFunctionMatch, true,
    "the verdict still contradicts the byte-exact full-ROM integration");
});

// ---- NEGATIVES: the fix must not blanket-ignore rodata ----

test("a genuinely differing jump table is still a mismatch", () => {
  const v = aggregateVerdict({
    strict: EXACT_TEXT,
    rodata: { compared: true, equal: false, references: { target: 1, candidate: 1 },
      items: [{ index: 0, kind: "jump-table", equal: false }], note: "jump table differs" },
    romLinked: EXACT_LINKED,
  });
  assert.equal(v.functionLocal, "mismatch", "a real jump-table difference was swallowed");
  assert.equal(v.exactFunctionMatch, false);
});

test("a differing literal is still a mismatch", () => {
  const v = aggregateVerdict({
    strict: EXACT_TEXT,
    rodata: { compared: true, equal: false, references: { target: 1, candidate: 1 },
      items: [{ index: 0, kind: "literal", equal: false, targetWords: [1], candidateWords: [2] }] },
    romLinked: EXACT_LINKED,
  });
  assert.equal(v.exactFunctionMatch, false, "a changed literal was swallowed");
});

test("the candidate dropping a reference the target HAS is still compared", () => {
  // The reverse direction is real evidence: the target's own object enumerated
  // a reference, so discovery worked and the candidate is genuinely missing it.
  const v = aggregateVerdict({
    strict: EXACT_TEXT,
    rodata: { compared: true, equal: false, references: { target: 1, candidate: 0 },
      items: [{ index: 0, target: "jtbl@0x0", candidate: null, equal: false }] },
    romLinked: EXACT_LINKED,
  });
  assert.equal(v.exactFunctionMatch, false);
});

test("failure to compare is never equality", () => {
  const st = rodataState({ compared: false, reason: "no .rodata placement in the linker map" });
  assert.equal(st.state, "unknown");
  const v = aggregateVerdict({ strict: EXACT_TEXT, rodata: { compared: false, reason: "x" }, romLinked: EXACT_LINKED });
  assert.equal(v.exactFunctionMatch, false, "an uncomparable check was treated as passing");
});
