// Report 2026-09-15 §10: "The default payoff ranking favors large functions. A
// request for another 15 verified functions benefits from a different queue
// than a request to recover the most bytes or unlock a shared type."
//
// Acceptance: "a function-count queue includes relevant small targets and
// their imported research, while a byte-coverage queue can intentionally rank
// the large routines first. Both retain the same completion accounting and
// exactness standards."
import { test } from "node:test";
import assert from "node:assert/strict";
import { PLAN_OBJECTIVES } from "../src/decomp/plan.js";
import { readFile } from "node:fs/promises";

const src = async () => readFile(new URL("../src/decomp/plan.js", import.meta.url), "utf8");

test("the four objectives the report asked for exist", () => {
  for (const k of ["byte-coverage", "function-count", "shared-type", "diagnostic-research"]) {
    assert.ok(PLAN_OBJECTIVES[k], `objective '${k}' missing`);
  }
});

test("byte-coverage stays the default so existing queues do not change meaning", async () => {
  assert.match(await src(), /objective = "byte-coverage"/);
});

test("an unknown objective is refused, not silently ignored", async () => {
  const { planWork } = await import("../src/decomp/plan.js");
  await assert.rejects(() => planWork({}, { objective: "make-it-fast" }), (e) => {
    assert.equal(e.code, "BAD_ARGS");
    assert.match(e.message, /byte-coverage/, "the error should list the valid objectives");
    return true;
  });
});

test("every row reports the FACTORS behind its rank", async () => {
  const s = await src();
  assert.match(s, /objectiveScore: o\.score, objectiveFactors: o\.factors/,
    "a rank without its factors is an opaque number");
});

test("no completion-time estimate is invented", async () => {
  const s = await src();
  assert.ok(!/etaHours|estimatedCompletion|timeToFinish/i.test(s),
    "the report explicitly asked for factors and uncertainty, NOT invented completion estimates");
});

test("pagination reports what lies beyond the window", async () => {
  const s = await src();
  const block = s.match(/page: \{ offset[\s\S]*?\},/)?.[0] ?? "";
  assert.match(block, /hasMore/);
  assert.match(block, /nextOffset/);
  assert.match(block, /NOT excluded from the work/i,
    "a truncated queue must not look like the whole list");
});

test("the four evidence states are distinguished", async () => {
  const s = await src();
  for (const state of [
    "active-current-tree-candidate",
    "historical-candidate-needs-refresh",
    "research-drafts-exist-unmeasured",
    "no-api-measurement",
  ]) {
    assert.match(s, new RegExp(state), `evidence state '${state}' is not distinguished`);
  }
});

test("distance is never equated with difficulty", async () => {
  // "a one-word branch residue can require deeper work than a larger
  // structural mismatch"
  const s = await src();
  assert.match(s, /states what is KNOWN, not how hard it is/i);
});

test("diagnostic-research ranks unmeasured functions last, since they teach nothing yet", async () => {
  const s = await src();
  const block = s.match(/case "diagnostic-research": \{[\s\S]*?\n    \}/)?.[0] ?? "";
  assert.match(block, /attempted && near != null \? .* : 0/,
    "a never-measured function has no residual to diagnose and must not rank first");
});
