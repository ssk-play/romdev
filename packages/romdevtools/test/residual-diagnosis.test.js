// Report 2026-09-15 §5: "Merely classifying a word as a register or
// instruction difference did not answer what experiment to run."
//
// The acceptance fixtures name two mechanisms in ONE function that must come
// out as SEPARATE groups: a five-word scheduling permutation traced to source
// lines 43/44/45, and a reversed branch operand pair at instruction 56.
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseAs1Trace, maskPatchable, groupResiduals, classifyGroup, diagnoseResiduals } from "../src/decomp/diagnose.js";

const ins = (mnemonic, operands, word = 0, reloc = null) => ({ mnemonic, operands, word, reloc });
const strictOf = (idx) => ({ mismatches: idx.map((i) => ({ index: i, kind: "instruction" })) });

test("as1 node numbers repeat per region and every declaration is kept", () => {
  // as1 renumbers from 0 in each scheduling region. Keying by node number kept
  // only the last declaration of each and discarded 94% of a real trace.
  const t = parseAs1Trace([
    "Node   1: inst aaaaaaaa, relocation 0, lineno 10",
    "\tbefore 0, aftercycles 1, maxhazard 0",
    "\tafternodes: 0/1",
    "Node   0: inst bbbbbbbb, relocation 0, lineno 11",
    "\tbefore 1, aftercycles 0, maxhazard 0",
    "\tafternodes:",
    "Node   1: inst cccccccc, relocation 0, lineno 20",   // new region
    "\tbefore 0, aftercycles 2, maxhazard 0",
    "\tafternodes:",
  ].join("\n"));
  assert.equal(t.nodeCount, 3, "a repeated node number overwrote an earlier node");
  assert.equal(t.regionCount, 2);
  assert.deepEqual(t.nodes.map((n) => n.lineno), [10, 11, 20]);
});

test("the trace parser reports unknown keys rather than inventing meaning", () => {
  const t = parseAs1Trace([
    "Picking node 0 (INST 7), at 10, best_addr = 8",
    "  node 1 (INST 6), time = 5, aftercycles = 0, latency = 0, wobble = 3",
  ].join("\n"));
  assert.ok(t.unknownKeys.includes("wobble"), "an unrecognised trace key must be surfaced, not dropped");
});

test("assembler-patched fields are masked when checking trace provenance", () => {
  // A trace prints instructions before branch displacements are filled in, so
  // raw-word comparison rejected correct traces (81% coverage, the shortfall
  // entirely branches and stores).
  const beforePatch = 0x11c00000, afterPatch = 0x11c000a2;
  assert.equal(maskPatchable(beforePatch), maskPatchable(afterPatch));
  // R-type has no immediate to patch, so it compares whole.
  assert.equal(maskPatchable(0x00097900), 0x00097900);
});

test("a five-word permutation is ONE scheduling group, not five problems", () => {
  const target = [ins("lui", "t7,0"), ins("addiu", "a3,a3,12"), ins("sll", "t7,t1,4"), ins("lw", "t8,0(t7)"), ins("addu", "t9,t8,t1")];
  const candidate = [ins("addiu", "a3,a3,12"), ins("lui", "t7,0"), ins("addu", "t9,t8,t1"), ins("sll", "t7,t1,4"), ins("lw", "t8,0(t7)")];
  const groups = groupResiduals(target, candidate, strictOf([0, 1, 2, 3, 4]));
  assert.equal(groups.length, 1, `expected one group, got ${groups.length}`);
  const cls = classifyGroup(groups[0], target, candidate);
  assert.equal(cls.mechanism, "scheduling-permutation");
  assert.equal(cls.confidence, "high");
});

test("a reversed branch pair is branch-lowering, NOT register allocation", () => {
  // This is the trap: same mnemonic, same operand shape, different register
  // names -- indistinguishable from a register substitution by shape alone.
  // Misfiling it sends the caller to declaration-order experiments, which the
  // report's own trials show do not fix it.
  const target = [ins("bne", "t4,a1,fc")];
  const candidate = [ins("bne", "a1,t4,fc")];
  const groups = groupResiduals(target, candidate, strictOf([0]));
  const cls = classifyGroup(groups[0], target, candidate);
  assert.equal(cls.mechanism, "branch-lowering", "a swapped branch pair was misfiled");
  assert.equal(cls.evidence.swapped, true);
  assert.match(cls.phase, /uopt/, "branch lowering precedes as1; the phase must say so");
});

test("one repeated register mapping is one allocation decision", () => {
  const target = [ins("addu", "s5,a0,a1"), ins("lw", "s6,0(s5)"), ins("sw", "s7,4(s5)")];
  const candidate = [ins("addu", "s6,a0,a1"), ins("lw", "s6,0(s6)"), ins("sw", "s7,4(s6)")];
  const groups = groupResiduals(target, candidate, strictOf([0, 1, 2]));
  const sched = groups.map((g) => classifyGroup(g, target, candidate));
  assert.ok(sched.some((c) => c.mechanism === "register-assignment"),
    `expected a register-assignment group, got ${sched.map((c) => c.mechanism).join(", ")}`);
});

test("every experiment states what would REFUTE it", () => {
  const target = [ins("bne", "t4,a1,fc")];
  const candidate = [ins("bne", "a1,t4,fc")];
  const d = diagnoseResiduals({ target, candidate, strict: strictOf([0]) });
  assert.ok(d.groups[0].experiments.length > 0);
  for (const e of d.groups[0].experiments) {
    assert.ok(e.refutes && e.refutes.length > 10,
      `experiment '${e.id}' has no refutation condition: an experiment whose every outcome confirms the hypothesis tests nothing`);
    assert.ok(e.predict, `experiment '${e.id}' has no prediction`);
  }
});

test("without a trace, source attribution is absent rather than guessed", () => {
  const target = [ins("bne", "t4,a1,fc")];
  const candidate = [ins("bne", "a1,t4,fc")];
  const d = diagnoseResiduals({ target, candidate, strict: strictOf([0]) });
  assert.equal(d.groups[0].sourceLines, null);
  assert.match(d.groups[0].sourceLinesNote, /no as1 trace/i);
  assert.equal(d.trace.supplied, false);
  assert.match(d.trace.limits, /without a trace/i);
});

test("the trace's limits are stated: as1 schedules, it does not choose expressions", () => {
  const d = diagnoseResiduals({ target: [ins("nop", "")], candidate: [ins("nop", "")], strict: strictOf([]), trace: "Node   0: inst 00000000, relocation 0, lineno 1" });
  assert.match(d.trace.limits, /cannot explain which expressions exist/i,
    "an as1 trace must not be claimed to explain uopt decisions");
});
