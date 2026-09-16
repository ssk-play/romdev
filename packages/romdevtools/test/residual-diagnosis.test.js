// Report 2026-09-15 §5: "Merely classifying a word as a register or
// instruction difference did not answer what experiment to run."
//
// The acceptance fixtures name two mechanisms in ONE function that must come
// out as SEPARATE groups: a five-word scheduling permutation traced to source
// lines 43/44/45, and a reversed branch operand pair at instruction 56.
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseAs1Trace, maskPatchable, groupResiduals, classifyGroup, diagnoseResiduals, experimentsFor } from "../src/decomp/diagnose.js";

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

// --- Client reply 2026-09-15: branch-vs-register classification ---
//
// The first shipped version called this branch-lowering and proposed rewriting
// the condition:
//
//   169  addiu s7,zero,128  ->  addiu s6,zero,128
//   294  bne   s1,s7,420    ->  bne   s1,s6,420
//
// The operands did not exchange positions, the sense did not change, and the
// displacement did not change. It is the SAME s7->s6 substitution already
// found in the constant setup -- evidence for the register-allocation
// explanation, not a reason to burn experiments reshaping a correct condition.

test("a branch whose register is SUBSTITUTED joins its allocation group", () => {
  const target = [ins("addiu", "s7,zero,128"), ins("bne", "s1,s7,420")];
  const candidate = [ins("addiu", "s6,zero,128"), ins("bne", "s1,s6,420")];
  const groups = groupResiduals(target, candidate, strictOf([0, 1]));
  assert.equal(groups.length, 1, `the constant and its branch consumer were split into ${groups.length} groups`);
  const cls = classifyGroup(groups[0], target, candidate);
  assert.equal(cls.mechanism, "register-assignment",
    "a same-position register substitution in a branch is the allocator, not condition lowering");
  assert.equal(cls.evidence.mapping, "s7->s6");
});

test("a branch whose operands are SWAPPED is still branch-lowering", () => {
  // The control for the fix above: it must not swing the other way.
  const target = [ins("bne", "t4,a1,fc")];
  const candidate = [ins("bne", "a1,t4,fc")];
  const cls = classifyGroup(groupResiduals(target, candidate, strictOf([0]))[0], target, candidate);
  assert.equal(cls.mechanism, "branch-lowering");
  assert.equal(cls.evidence.swapped, true);
});

test("a branch whose SENSE changed is branch-lowering", () => {
  const target = [ins("beq", "s1,s7,420")];
  const candidate = [ins("bne", "s1,s7,420")];
  const cls = classifyGroup(groupResiduals(target, candidate, strictOf([0]))[0], target, candidate);
  assert.equal(cls.mechanism, "branch-lowering");
  assert.equal(cls.evidence.senseChanged, true);
});

test("a branch whose DESTINATION changed is branch-lowering, not allocation", () => {
  const target = [ins("bne", "s1,s7,420")];
  const candidate = [ins("bne", "s1,s7,424")];
  const cls = classifyGroup(groupResiduals(target, candidate, strictOf([0]))[0], target, candidate);
  assert.equal(cls.mechanism, "branch-lowering");
  assert.equal(cls.evidence.targetChanged, true);
});

test("a mapping repeated inside ONE instruction is not a second decision", () => {
  // `addiu s6,s6,0` -> `addiu s5,s5,0` produced the mapping string
  // "s6->s5,s6->s5", which differed from "s6->s5" and opened a second group
  // for the same allocator choice.
  const target = [ins("lw", "t0,0(s6)"), ins("addiu", "s6,s6,0")];
  const candidate = [ins("lw", "t0,0(s5)"), ins("addiu", "s5,s5,0")];
  const groups = groupResiduals(target, candidate, strictOf([0, 1]));
  assert.equal(groups.length, 1, `repeated mapping opened ${groups.length} groups`);
  assert.equal(groups[0].mapping, "s6->s5", "the mapping must be deduplicated");
});

test("genuinely different mappings stay separate groups", () => {
  // The control: deduplication must not merge two real allocator decisions.
  const target = [ins("lw", "t0,0(s5)"), ins("lw", "t1,0(s6)")];
  const candidate = [ins("lw", "t0,0(s7)"), ins("lw", "t1,0(s5)")];
  const groups = groupResiduals(target, candidate, strictOf([0, 1]));
  const mappings = new Set(groups.map((g) => g.mapping));
  assert.ok(mappings.has("s5->s7") && mappings.has("s6->s5"),
    `two distinct mappings were merged: ${[...mappings].join(" | ")}`);
});

test("an unconditional jump whose destination changed is control flow, not 'unclassified'", () => {
  // Found by probing after the branch fix: `j`/`jal` carry no registers, so
  // they fell outside the branch reasoning entirely and returned a shrug.
  for (const [t, c] of [
    [ins("j", "0x420"), ins("j", "0x424")],
    [ins("jal", "func_A"), ins("jal", "func_B")],
  ]) {
    const cls = classifyGroup(groupResiduals([t], [c], strictOf([0]))[0], [t], [c]);
    assert.equal(cls.mechanism, "branch-lowering", `${t.mnemonic} was classified ${cls.mechanism}`);
    assert.equal(cls.evidence.targetChanged, true);
    assert.match(cls.why, /never an allocation choice/i);
  }
});

test("single-register and zero-compare branches follow the same substitution rule", () => {
  // bgez/beq-to-zero have one meaningful register, so the two-operand swap
  // test does not apply to them; they must still read as allocation.
  for (const [t, c] of [
    [ins("bgez", "s7,420"), ins("bgez", "s6,420")],
    [ins("beq", "s7,zero,420"), ins("beq", "s6,zero,420")],
  ]) {
    const cls = classifyGroup(groupResiduals([t], [c], strictOf([0]))[0], [t], [c]);
    assert.equal(cls.mechanism, "register-assignment", `${t.mnemonic} was classified ${cls.mechanism}`);
  }
});

test("a HI16/LO16 pair naming different symbols is data-ownership, not 'unclassified'", () => {
  // On the client's own artifact this sat in `unclassified` -- a shrug where a
  // specific answer exists: the target loads from a named symbol while the
  // candidate materialises its own anonymous literal. The linked bytes can
  // match while the DECLARATION the original had is missing.
  const reloc = (type, symbol) => ({ type, symbol, addend: 0 });
  const target = [
    { mnemonic: "lui", operands: "at,0x0", word: 1, reloc: reloc("R_MIPS_HI16", "D_i15_802C6E34") },
    { mnemonic: "lwc1", operands: "ft2,0(at)", word: 2, reloc: reloc("R_MIPS_LO16", "D_i15_802C6E34") },
  ];
  const candidate = [
    { mnemonic: "lui", operands: "at,0x0", word: 1, reloc: reloc("R_MIPS_HI16", ".rodata") },
    { mnemonic: "lwc1", operands: "ft2,20(at)", word: 3, reloc: reloc("R_MIPS_LO16", ".rodata") },
  ];
  const cls = classifyGroup(groupResiduals(target, candidate, strictOf([0, 1]))[0], target, candidate);
  assert.equal(cls.mechanism, "data-ownership");
  assert.match(cls.why, /D_i15_802C6E34/);
  assert.match(cls.why, /DECLARATION/);
  // The experiment must not tell the caller to invent a new symbol.
  assert.match(cls.evidence.targetSymbols.join(","), /D_i15_802C6E34/);
});

test("the data-ownership experiment refuses to invent a second name for the same bytes", () => {
  const reloc = (t, s) => ({ type: t, symbol: s, addend: 0 });
  const target = [{ mnemonic: "lui", operands: "at,0x0", word: 1, reloc: reloc("R_MIPS_HI16", "D_REAL") }];
  const candidate = [{ mnemonic: "lui", operands: "at,0x0", word: 1, reloc: reloc("R_MIPS_HI16", ".rodata") }];
  const g = groupResiduals(target, candidate, strictOf([0]))[0];
  const cls = classifyGroup(g, target, candidate);
  const exp = experimentsFor(cls, g)[0];
  assert.match(exp.caution, /second name for bytes that already have one/i);
  assert.doesNotMatch(exp.do, /D_REAL, D_REAL/, "the symbol list must be deduplicated");
});

test("identical reloc symbols are NOT data-ownership", () => {
  // The control: same symbol on both sides is a spelling or offset matter,
  // not an ownership difference.
  const reloc = (t, s) => ({ type: t, symbol: s, addend: 0 });
  const target = [{ mnemonic: "lwc1", operands: "ft2,0(at)", word: 2, reloc: reloc("R_MIPS_LO16", "D_SAME") }];
  const candidate = [{ mnemonic: "lwc1", operands: "ft2,4(at)", word: 3, reloc: reloc("R_MIPS_LO16", "D_SAME") }];
  const cls = classifyGroup(groupResiduals(target, candidate, strictOf([0]))[0], target, candidate);
  assert.notEqual(cls.mechanism, "data-ownership");
});

test("trace provenance states its method, threshold, and what it CANNOT detect", async () => {
  // "It's a heuristic" is a hand-wave. The output has to say how strong the
  // evidence is and where it stops: measured 0.962 on a matching trace and
  // 0.322 on a trace of a different function, both live.
  const { readFile } = await import("node:fs/promises");
  const src = await readFile(new URL("../src/mcp/tools/decomp.js", import.meta.url), "utf8");
  // Match the FULL provenance object (the one carrying `verdict`), not the
  // small object-evidence stub assigned to the same name just above it.
  const block = src.match(/traceProvenance = \{ \.\.\.traceProvenance[\s\S]*?verdict:[\s\S]*?\};/)?.[0] ?? "";
  assert.ok(block, "no trace provenance block");
  for (const field of ["method", "detects", "cannotDetect", "threshold", "uncoveredWords"]) {
    assert.match(block, new RegExp(field), `provenance omits '${field}'`);
  }
  assert.match(block, /necessary evidence of provenance, not sufficient/i,
    "the output must not let word equality read as proof of provenance");
  assert.match(block, /different optimisation flags/i,
    "the one thing it cannot rule out must be named explicitly");
});

test("trace provenance uses the traced OBJECT when it sits beside the trace", async () => {
  // Word coverage cannot separate two builds that emit the same words. A
  // trace bundle usually carries the object from the traced compile; its
  // bytes narrow the blind spot from "same words" to "byte-identical object".
  const { readFile } = await import("node:fs/promises");
  const src = await readFile(new URL("../src/mcp/tools/decomp.js", import.meta.url), "utf8");
  const block = src.match(/const traceDir = path\.dirname[\s\S]*?evidenceStrength:[^,]+,/)?.[0] ?? "";
  assert.ok(block, "no object-evidence branch");
  assert.match(block, /"trace\.o", "target\.o"/, "should look for the traced object beside the trace");
  assert.match(block, /evidenceStrength/);
  // And when there is no object, the weaker claim must be stated, not implied.
  assert.match(src, /instruction-word coverage only \(no trace\.o or target\.o beside the trace\)/,
    "without an object the response must say the evidence is weaker");
  assert.match(src, /byte-identical objects|byte-identical object/,
    "the remaining blind spot must be named precisely");
});

test("the policy does not claim causal independence the analysis cannot prove", () => {
  // The response said this had been fixed while the live text still opened
  // "groups are INDEPENDENT residuals" -- a document describing a fix that did
  // not exist. Grouping establishes shared evidence, not independent causes.
  const d = diagnoseResiduals({ target: [ins("nop", "")], candidate: [ins("nop", "")], strict: strictOf([]) });
  assert.doesNotMatch(d.policy, /groups are INDEPENDENT residuals/,
    "the policy must not assert independence");
  assert.match(d.policy, /correlation, not proved causal independence/i);
  assert.match(d.policy, /CAN still share an upstream cause/i);
});
