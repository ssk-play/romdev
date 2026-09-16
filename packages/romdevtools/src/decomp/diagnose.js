// diagnose.js — residual diagnosis that names the COMPILER MECHANISM.
//
// The reporter's complaint (2026-09-15 §5) was precise: classifying a word as
// "a register difference" or "an instruction difference" does not tell you what
// experiment to run. They had to reconstruct the owner TU by hand, recover its
// compile invocation, recompile with `-Wa,-R`, find the relevant nodes in an
// 11,000-line trace, map source lines to nodes, and reason about scheduling
// priorities — for a handful of mismatches.
//
// So this module does three things the per-word classifier does not:
//
//   1. GROUPS residuals that share one cause, instead of listing every affected
//      word as an independent problem. Eleven words of s5/s6/s7 substitution
//      are ONE allocation decision, not eleven.
//   2. Names the MECHANISM per group (scheduling permutation, branch lowering,
//      register assignment, frame layout, instruction-count change, relocation
//      spelling, unclassified) with the evidence that supports it.
//   3. Proposes DISCRIMINATING experiments — each with a prediction and, more
//      importantly, what would REFUTE the hypothesis.
//
// Two rules this file will not break, both stated in the report:
//
//   - "An as1 trace alone must not be claimed to explain uopt decisions."
//     Trace evidence is labelled with the phase it can actually speak for.
//     as1 schedules; it does not choose which expressions exist.
//   - "Report unknown keys rather than fabricating them." A trace field this
//     parser does not understand is surfaced as unknown, never guessed.

/** Branch mnemonics, for telling a branch-lowering residual from an ALU one. */
const BRANCH_RE = /^(b|beq|bne|blez|bgtz|bltz|bgez|beql|bnel|blezl|bgtzl|bltzl|bgezl|bc1t|bc1f|bc1tl|bc1fl)$/;
const REG_RE = /\$?\b(zero|at|v[01]|a[0-3]|t[0-9]|s[0-7]|k[01]|gp|sp|fp|ra|f[0-9]+)\b/g;

const regsOf = (ops) => (String(ops ?? "").match(REG_RE) ?? []);
const relocSpelling = (i) => (i?.reloc == null ? "" : typeof i.reloc === "string" ? i.reloc : JSON.stringify(i.reloc));

/**
 * Did the two instructions exchange their register operands, rather than
 * substitute one? `bne t4,a1` vs `bne a1,t4` is a swap (the comparison was
 * written the other way round); `bne s1,s7` vs `bne s1,s6` is a substitution
 * (the allocator chose a different home for the same value).
 *
 * The difference decides which experiment the caller runs, so it is computed
 * from the operands rather than assumed from the mnemonic.
 */
export function isOperandSwap(a, b) {
  const ra = regsOf(a?.operands), rb = regsOf(b?.operands);
  if (ra.length !== rb.length || ra.length < 2) return false;
  // Identical multiset, different order: the same registers, rearranged.
  const sa = [...ra].sort().join(","), sb = [...rb].sort().join(",");
  if (sa !== sb) return false;
  return ra.some((r, i) => r !== rb[i]);
}
const opsNoRegs = (ops) => String(ops ?? "").replace(REG_RE, "%r");

/**
 * Parse an as1 `-Wa,-R` trace into schedulable nodes and the picking order.
 *
 * Format (observed, not assumed — see the fixture at
 * docs/research/parallel-candidates/i3-init5800-300/as1-trace.log):
 *
 *   Node  11: inst 24e7000c, relocation 62, lineno 43
 *   	before 0, aftercycles 0, maxhazard 0
 *   	afternodes: 2/1 8/1
 *   Picking node 0 (INST 7), at 10, best_addr = 8
 *
 * `afternodes: a/w` are successors with an edge weight. `before` is the
 * predecessor count, `aftercycles` the scheduling priority as1 maximises.
 *
 * @param {string} text
 */
export function parseAs1Trace(text) {
  // NODE NUMBERS ARE NOT UNIQUE. as1 renumbers from 0 in every scheduling
  // region, so one 11k-line trace declared 1,731 nodes using only 101 distinct
  // numbers. Keying a map by node number kept the LAST declaration of each and
  // silently discarded 94% of the trace — including every node the reporter
  // cited. Nodes are kept as a list; `region` records which block each came
  // from, and lookups match on the instruction WORD, which is what a caller
  // actually has.
  /** @type {Array<any>} */
  const nodes = [];
  const picks = [];
  let region = 0;
  let lastNodeNum = -1;
  const unknownKeys = new Set();
  const lines = String(text ?? "").split("\n");
  let cur = null;

  for (const line of lines) {
    let m;
    if ((m = /^Node\s+(\d+):\s*inst\s+([0-9a-fA-F]+),\s*relocation\s+(\d+),\s*lineno\s+(\d+)/.exec(line))) {
      const num = Number(m[1]);
      // A node number that does not continue the descending run starts a new
      // region. as1 prints a region's nodes highest-first.
      if (num > lastNodeNum) region++;
      lastNodeNum = num;
      cur = { node: num, region, word: parseInt(m[2], 16) >>> 0, relocation: Number(m[3]), lineno: Number(m[4]), after: [] };
      nodes.push(cur);
      continue;
    }
    if (cur && (m = /^\s+before\s+(\d+),\s*aftercycles\s+(\d+),\s*maxhazard\s+(\d+)\s*$/.exec(line))) {
      cur.before = Number(m[1]); cur.aftercycles = Number(m[2]); cur.maxhazard = Number(m[3]);
      continue;
    }
    if (cur && (m = /^\s+afternodes:\s*(.*)$/.exec(line))) {
      for (const e of (m[1].match(/\d+\/\d+/g) ?? [])) {
        const [to, w] = e.split("/").map(Number);
        cur.after.push({ to, weight: w });
      }
      continue;
    }
    if ((m = /^Picking node\s+(\d+)\s*\(INST\s+(\d+)\),\s*at\s+(\d+)(?:,\s*best_addr\s*=\s*(\d+))?/.exec(line))) {
      picks.push({ node: Number(m[1]), inst: Number(m[2]), at: Number(m[3]), bestAddr: m[4] != null ? Number(m[4]) : null });
      continue;
    }
    // A `  node N (INST i), time = ..., aftercycles = ..., latency = ...` line:
    // the candidates as1 considered before each pick.
    if ((m = /^\s+node\s+(\d+)\s*\(INST\s+(\d+)\),\s*(.*)$/.exec(line))) {
      const fields = {};
      for (const f of m[3].matchAll(/(\w+)\s*=\s*(-?\d+)/g)) fields[f[1]] = Number(f[2]);
      for (const k of Object.keys(fields)) if (!["time", "aftercycles", "latency", "besttime"].includes(k)) unknownKeys.add(k);
      (picks.length ? (picks[picks.length - 1].considered ??= []) : []).push?.({ node: Number(m[1]), inst: Number(m[2]), ...fields });
      continue;
    }
  }
  return { nodes, picks, unknownKeys: [...unknownKeys], nodeCount: nodes.length,
    regionCount: region, pickCount: picks.length };
}

/**
 * A word with the fields the ASSEMBLER still patches masked out.
 *
 * An as1 trace prints each instruction as it stands DURING scheduling, before
 * branch displacements and relocated immediates are filled in, so a branch's
 * traced word almost never equals its final word. Comparing raw words made a
 * correct trace look 81% covered, with the shortfall landing entirely on
 * branches and stores — which would have rejected every real trace.
 *
 * Masking the low 16 bits compares the opcode and register fields, which
 * scheduling does fix, and ignores the displacement/immediate, which it does
 * not.
 */
export function maskPatchable(word) {
  const op = (word >>> 26) & 0x3f;
  // I-type: opcode + rs + rt are stable; the 16-bit immediate is not.
  // J-type (2, 3): only the opcode is stable.
  if (op === 2 || op === 3) return op << 26;
  if (op === 0) return word >>> 0;            // R-type: no immediate to patch
  return (word & 0xffff0000) >>> 0;
}

/**
 * Which source lines produced a set of instruction words, from a trace.
 * Returns null when the trace does not cover them — an ABSENT answer, never a
 * guessed one.
 */
export function sourceLinesFor(trace, words) {
  if (!trace?.nodes?.length) return null;
  const byWord = new Map();
  for (const n of trace.nodes) {
    if (!byWord.has(n.word)) byWord.set(n.word, []);
    byWord.get(n.word).push(n);
  }
  const out = [];
  for (const w of words) {
    const hits = byWord.get(w >>> 0);
    if (!hits?.length) { out.push({ word: w, lineno: null, note: "no node in the trace carries this word" }); continue; }
    const lines = [...new Set(hits.map((h) => h.lineno))];
    out.push({ word: w, lineno: lines.length === 1 ? lines[0] : null, candidateLines: lines.length > 1 ? lines : undefined,
      aftercycles: hits[0].aftercycles ?? null, node: hits[0].node });
  }
  return out;
}

/**
 * Group contiguous-or-related mismatches into INDEPENDENT residual groups.
 *
 * "Independent" is the operative word. The report's i15 case had 11 linked
 * differences that were all one s5/s6/s7 allocation decision; presenting them
 * as 11 problems is what made the tooling unhelpful. Grouping rules:
 *
 *   - adjacency: mismatches within `gap` instructions of each other are one
 *     region (a scheduling permutation moves a contiguous run);
 *   - a register substitution that repeats the SAME mapping joins the group
 *     that mapping already owns, however far away it is, because one allocator
 *     decision produces all of them.
 *
 * @param {Array} target normalized target stream
 * @param {Array} candidate normalized candidate stream
 * @param {{mismatches:Array}} strict
 */
export function groupResiduals(target, candidate, strict, { gap = 3 } = {}) {
  const groups = [];
  /** @type {Map<string, any>} */
  const byRegMapping = new Map();

  for (const mm of strict.mismatches ?? []) {
    const a = target[mm.index], b = candidate[mm.index];
    // A pure register substitution: same mnemonic, same operand shape, only
    // the register names differ. Its "mapping" identifies the allocator choice.
    // A branch whose operands are SWAPPED is a comparison shape (lowering).
    // A branch whose register is SUBSTITUTED, in the same position with the
    // same sense and displacement, is the allocator — the reporter's case:
    //   169  addiu s7,zero,128  ->  addiu s6,zero,128
    //   294  bne   s1,s7,420    ->  bne   s1,s6,420
    // Excluding every branch from register grouping split that one decision in
    // two and sent the caller off rewriting a condition that was never wrong.
    let mapping = null;
    if (a && b && a.mnemonic === b.mnemonic && opsNoRegs(a.operands) === opsNoRegs(b.operands)
        && !(BRANCH_RE.test(a.mnemonic) && isOperandSwap(a, b))) {
      const ra = regsOf(a.operands), rb = regsOf(b.operands);
      if (ra.length === rb.length && ra.some((r, i) => r !== rb[i])) {
        // DEDUPLICATE. One instruction that uses a mapping twice
        // (`addiu s6,s6,0` -> `addiu s5,s5,0`) yields "s6->s5,s6->s5", which
        // is a different STRING from "s6->s5" and so opened a second group for
        // the same allocator decision. Repeating a substitution inside one
        // instruction is not evidence of a second choice.
        const pairs = ra.map((r, i) => `${r}->${rb[i]}`).filter((x) => x.split("->")[0] !== x.split("->")[1]);
        mapping = [...new Set(pairs)].sort().join(",");
      }
    }
    if (mapping && byRegMapping.has(mapping)) {
      const g = byRegMapping.get(mapping);
      g.indices.push(mm.index);
      g.end = Math.max(g.end, mm.index);
      continue;
    }
    const last = groups[groups.length - 1];
    if (!mapping && last && mm.index - last.end <= gap) {
      last.indices.push(mm.index);
      last.end = mm.index;
      continue;
    }
    const g = { start: mm.index, end: mm.index, indices: [mm.index], mapping };
    groups.push(g);
    if (mapping) byRegMapping.set(mapping, g);
  }
  return groups;
}

/**
 * Classify ONE group's mechanism, with the evidence that supports it.
 *
 * Every verdict carries a confidence and the reason, because "scheduling" and
 * "register allocation" call for completely different experiments and a
 * confident wrong label costs more than an honest "unclassified".
 */
export function classifyGroup(group, target, candidate) {
  const idx = group.indices;
  const ta = idx.map((i) => target[i]).filter(Boolean);
  const ca = idx.map((i) => candidate[i]).filter(Boolean);
  const ev = {};

  // A relocation spelling difference: identical words AND identical decoded
  // text, differing only in how the relocation is named. Testing the word
  // alone was wrong: two instructions can share a word while their operands
  // differ (and a stream without word data would classify EVERYTHING as a
  // spelling difference), which would hide a real residual behind
  // "no action needed".
  if (ta.length && ta.every((a, k) => ca[k] && a.word === ca[k].word
      && a.mnemonic === ca[k].mnemonic && a.operands === ca[k].operands
      && relocSpelling(a) !== relocSpelling(ca[k]))) {
    return { mechanism: "relocation-spelling", confidence: "high",
      why: "every word in this group is byte-identical; only the relocation's spelling differs, so the linker produces the same bytes",
      evidence: { words: ta.length }, impact: "none once linked" };
  }

  // A permutation: the same multiset of instructions in a different order.
  const key = (i) => `${i.mnemonic} ${i.operands}`;
  if (ta.length === ca.length && ta.length > 1) {
    const sa = ta.map(key).sort().join("|"), sb = ca.map(key).sort().join("|");
    if (sa === sb) {
      return { mechanism: "scheduling-permutation", confidence: "high",
        why: "the group contains exactly the same instructions in a different order: the instruction selection agrees and only the SCHEDULE differs",
        evidence: { words: ta.length, targetOrder: ta.map(key), candidateOrder: ca.map(key) },
        phase: "as1 (instruction scheduling)" };
    }
  }

  // BRANCHES ARE CHECKED BEFORE REGISTER ALLOCATION.
  //
  // `bne t4,a1` vs `bne a1,t4` looks exactly like a register substitution to a
  // shape-based test: same mnemonic, same operand shape, different register
  // names. It is not one. Swapping a branch's two source registers changes the
  // COMPARISON's operand order, which comes from how the condition was written
  // in C -- the reporter's i3 case, where declaration-order experiments would
  // have been the wrong lever entirely.
  // ONLY a branch whose operands were exchanged is lowering. A branch that
  // reads a different register in the SAME position, with the same sense and
  // the same displacement, is the allocator's choice and belongs with the
  // other uses of that mapping — classifying it as lowering sent the caller to
  // rewrite a condition that was never wrong.
  const allBranch = ta.length > 0 && ta.every((a) => BRANCH_RE.test(a.mnemonic));
  const everySwapped = allBranch && ta.every((a, k) => ca[k] && isOperandSwap(a, ca[k]));
  const senseChanged = allBranch && ta.some((a, k) => ca[k] && a.mnemonic !== ca[k].mnemonic);
  const targetChanged = allBranch && ta.some((a, k) => {
    const da = /(-?\d+|0x[0-9a-fA-F]+)\s*$/.exec(String(a.operands ?? ""))?.[1];
    const db = /(-?\d+|0x[0-9a-fA-F]+)\s*$/.exec(String(ca[k]?.operands ?? ""))?.[1];
    return da !== db;
  });
  if (allBranch && (everySwapped || senseChanged || targetChanged)) {
    const swapped = everySwapped;
    return { mechanism: "branch-lowering", confidence: swapped ? "high" : "medium",
      why: swapped
        ? "the branch compares the same two registers in the OPPOSITE order. This is NOT a register-allocation difference even though it looks like one: the operand order follows the shape of the condition in source"
        : senseChanged
          ? "the branch's SENSE changed (a different branch mnemonic), which follows from how the condition is written in source"
          : "the branch's DESTINATION changed, so the control-flow shape differs rather than the registers",
      evidence: { swapped, senseChanged, targetChanged, target: ta.map(key), candidate: ca.map(key) },
      phase: "uopt (expression lowering) — an as1 trace cannot decide this" };
  }

  // A repeated register mapping: one allocator decision.
  if (group.mapping) {
    return { mechanism: "register-assignment", confidence: "high",
      why: `the same register substitution (${group.mapping}) appears at ${idx.length} site(s): this is ONE allocation decision, not ${idx.length} independent differences`,
      evidence: { mapping: group.mapping, sites: idx.length },
      phase: "uopt/as1 (register allocation)" };
  }

  // Frame size.
  const isFrame = (i) => i.mnemonic === "addiu" && /^sp,sp,/.test(i.operands);
  if (ta.some(isFrame) || ca.some(isFrame)) {
    return { mechanism: "frame-layout", confidence: "high",
      why: "the stack adjustment differs: the frame's size or the set of homes in it is not the same",
      evidence: { target: ta.filter(isFrame).map(key), candidate: ca.filter(isFrame).map(key) },
      phase: "uopt (storage allocation)" };
  }

  if (ta.length !== ca.length) {
    return { mechanism: "instruction-count", confidence: "high",
      why: `the group holds ${ta.length} target instruction(s) against ${ca.length} candidate: the candidate computes something the target does not, or vice versa`,
      evidence: { target: ta.map(key), candidate: ca.map(key) } };
  }

  return { mechanism: "unclassified", confidence: "low",
    why: "the words differ in a way this classifier does not recognise. Reported as unknown rather than forced into a category that would suggest the wrong experiment",
    evidence: { target: ta.map(key), candidate: ca.map(key) } };
}

/**
 * Discriminating experiments for a mechanism.
 *
 * Each carries what would REFUTE it, because an experiment whose every outcome
 * confirms the hypothesis tests nothing. The report was explicit that "try
 * reordering statements" is too weak to be useful.
 */
export function experimentsFor(cls, group, ctx = {}) {
  const lines = ctx.sourceLines?.filter((s) => s.lineno != null).map((s) => s.lineno) ?? [];
  const distinct = [...new Set(lines)].sort((a, b) => a - b);

  switch (cls.mechanism) {
    case "scheduling-permutation":
      return [{
        id: "equalize-statement-lines",
        do: distinct.length > 1
          ? `write the statements on source lines ${distinct.join(", ")} as ONE line, so the ready-list tie is not broken by lineno`
          : "group the statements that produce these instructions onto a single source line",
        predict: "the group's instructions reorder to the target's order and the other groups are untouched",
        refutes: "if the order does not change, lineno is not the tie-break here; if OTHER groups move, the statements were not independent and this lever is too coarse",
        evidence: distinct.length ? `trace lineno values for this group: ${distinct.join(", ")}` : "no trace supplied: line attribution unknown",
      }, {
        id: "split-statement-lines",
        do: "the inverse: put each statement on its own line",
        predict: "the schedule moves further from the target",
        refutes: "if it moves TOWARDS the target, the direction of the lineno effect is opposite to the hypothesis",
      }];
    case "branch-lowering":
      return [{
        id: "reshape-condition",
        do: "rewrite the condition so the intended operand is the left-hand side (e.g. `a == b` vs `b == a`, or a named local holding one side)",
        predict: "the branch operands swap to the target's order with NO change elsewhere",
        refutes: "if the temporary allocation elsewhere shifts too, the rewrite changed more than the comparison and is not the minimal lever",
        caution: "the report's own trials: reversed literal equality did NOT fix it; subtraction fixed the direction but disturbed later allocation (50 linked differences). A fix that moves other groups is not a fix",
      }, {
        id: "named-local",
        do: "introduce a named local for one operand and compare against it",
        predict: "the branch lowers with the target's operand order while later temporaries keep their homes",
        refutes: "if later allocation changes, the local consumed a register the original did not",
      }];
    case "register-assignment":
      return [{
        id: "declaration-order",
        do: "move the declaration of the variable(s) that live in these registers relative to its neighbours",
        predict: `the ${group.mapping} mapping resolves at all ${group.indices.length} sites at once, since they are one decision`,
        refutes: "if only SOME sites change, the group was not a single allocation decision and needs splitting",
      }, {
        id: "lifetime-shortening",
        do: "narrow the live range: compute the value nearer its use",
        predict: "the allocator reuses the target's register",
        refutes: "if the frame size changes, the edit spilled instead of reallocating",
      }];
    case "frame-layout":
      return [{
        id: "declared-types",
        do: "check declared types and array-ness of the locals homed in the frame (the report's case: Mtx vs Mtx_t restored the SIZE but left two homes four bytes high)",
        predict: "the frame size matches and the homes land on the original offsets",
        refutes: "if size matches but offsets do not, the ORDER of declarations is the remaining variable",
        caution: "never add padding or dummy locals to move an offset: that is a claimed slot, not a recovery",
      }, {
        id: "declaration-position",
        do: "move a real object's declaration between the existing ones",
        predict: "all offsets shift into place together",
        refutes: "if only some do, more than one object is misplaced",
      }];
    case "relocation-spelling":
      return [{ id: "none-needed", do: "nothing: the linked bytes are identical",
        predict: "the ROM-linked comparison is exact for these words",
        refutes: "if the ROM-linked check disagrees, the spelling is NOT equivalent and this classification is wrong" }];
    case "instruction-count":
      return [{ id: "expression-shape",
        do: "compare the source expressions that produce this region; an extra or missing instruction is a computation difference, not a codegen one",
        predict: "matching the expression shape removes the count difference",
        refutes: "if the count persists with identical expressions, an intrinsic or macro is expanding differently" }];
    default:
      return [{ id: "isolate",
        do: "compile this group's statements alone in a scratch function and compare the emitted words",
        predict: "the same difference reproduces in isolation, making it debuggable without the rest of the function",
        refutes: "if it does NOT reproduce, the cause is interaction with surrounding code, not these statements" }];
  }
}

/**
 * Full diagnosis for one compare result.
 *
 * @param {{target:Array, candidate:Array, strict:{mismatches:Array}, trace?:string|null,
 *          traceProvenance?:object|null, sourceText?:string|null}} a
 */
export function diagnoseResiduals({ target, candidate, strict, trace = null, traceProvenance = null }) {
  const parsed = trace ? parseAs1Trace(trace) : null;
  const groups = groupResiduals(target, candidate, strict);

  const out = groups.map((g, i) => {
    const cls = classifyGroup(g, target, candidate);
    const words = g.indices.map((k) => target[k]?.word).filter((w) => w != null);
    const sourceLines = parsed ? sourceLinesFor(parsed, words) : null;
    return {
      group: i + 1,
      instructions: { count: g.indices.length, indices: g.indices, range: `${g.start}..${g.end}` },
      targetRange: { startInstruction: g.start, endInstruction: g.end, bytes: (g.end - g.start + 1) * 4 },
      mechanism: cls.mechanism,
      confidence: cls.confidence,
      why: cls.why,
      ...(cls.phase ? { earliestPhase: cls.phase } : {}),
      evidence: cls.evidence,
      ...(sourceLines ? { sourceLines } : { sourceLines: null, sourceLinesNote: "no as1 trace supplied: pass one to attribute these words to source statements" }),
      experiments: experimentsFor(cls, g, { sourceLines }),
    };
  });

  return {
    schema: "romdev-decomp-residual-diagnosis-v1",
    groupCount: out.length,
    totalMismatches: strict.mismatches?.length ?? 0,
    groups: out,
    trace: parsed
      ? { supplied: true, nodes: parsed.nodeCount, regions: parsed.regionCount, picks: parsed.pickCount,
          ...(parsed.unknownKeys.length ? { unknownTraceKeys: parsed.unknownKeys, unknownNote: "keys this parser does not interpret, reported rather than guessed at" } : {}),
          provenance: traceProvenance,
          limits: "an as1 trace explains SCHEDULING. It cannot explain which expressions exist or which registers uopt chose — those decisions precede it." }
      : { supplied: false, limits: "without a trace, source-line attribution and scheduling priorities are unavailable; mechanisms are inferred from the instruction streams alone" },
    policy: "groups are INDEPENDENT residuals, not individual words: one allocator or scheduling decision is reported once. A mechanism this classifier does not recognise is reported as 'unclassified' rather than forced into a category, because a confident wrong label sends the next experiment in the wrong direction.",
  };
}
