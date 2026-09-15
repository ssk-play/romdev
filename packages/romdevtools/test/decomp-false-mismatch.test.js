// Four false-negative / stale-evidence defects reported from a real N64
// decompilation campaign. All four turned "I could not check this" or "this is old" into a
// confident wrong answer, which is the failure class the decomp verdict
// contract exists to prevent.
//
// Every fixture here is synthetic: no proprietary ROM data is needed, per the
// reporter's own request.

import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFile, mkdtemp } from "node:fs/promises";
import path from "node:path";
import os from "node:os";

import { parseSplatAsm, loadLinkerMap } from "../src/decomp/splat-map.js";
import { applyRelocations } from "../src/decomp/compile.js";

// ── 1. function bounds stop at the end label, not the end of the file ───────

test("parseSplatAsm: trailing alignment padding is NOT part of the function", async () => {
  // splat emits `endlabel` + `.size`, then the assembler pads to alignment with
  // zero words. Counting those as instructions made a CORRECT candidate look
  // short: a real 0x88 function with 34 instructions was compared against 37
  // words and reported as "missing instructions at indices 34-36".
  const asm = [
    "glabel func_test",
    "/* 001000 802C802C 27BDFFE8 */  addiu $sp, $sp, -0x18",
    "/* 001004 802C8030 AFBF0014 */  sw    $ra, 0x14($sp)",
    "/* 001008 802C8034 8FBF0014 */  lw    $ra, 0x14($sp)",
    "/* 00100C 802C8038 03E00008 */  jr    $ra",
    "/* 001010 802C803C 27BD0018 */   addiu $sp, $sp, 0x18",
    "endlabel func_test",
    ".size func_test, . - func_test",
    "/* 001014 802C8040 00000000 */  nop",
    "/* 001018 802C8044 00000000 */  nop",
    "/* 00101C 802C8048 00000000 */  nop",
  ].join("\n");
  const r = parseSplatAsm(asm);
  assert.equal(r.instructions.length, 5, "only the 5 real instructions belong to the function");
  assert.equal(r.sizeBytes, 0x14, "size is the declared size, not size + padding");
  // Reported, never silently dropped: whole-ROM layout still accounts for them.
  assert.equal(r.trailingPadWords, 3);
});

test("parseSplatAsm: a function with no padding is unchanged", async () => {
  const asm = [
    "glabel func_tight",
    "/* 002000 80001000 03E00008 */  jr    $ra",
    "/* 002004 80001004 00000000 */   nop",
    "endlabel func_tight",
    ".size func_tight, . - func_tight",
  ].join("\n");
  const r = parseSplatAsm(asm);
  assert.equal(r.instructions.length, 2);
  assert.equal(r.sizeBytes, 8);
  assert.equal(r.trailingPadWords, undefined, "no pad field when there is no padding");
});

test("parseSplatAsm: a .section after the end label starts a new region", async () => {
  // rodata following the function must still be collected — the end label ends
  // the TEXT, it does not end the file.
  const asm = [
    "glabel func_with_rodata",
    "/* 003000 80002000 03E00008 */  jr    $ra",
    "/* 003004 80002004 00000000 */   nop",
    "endlabel func_with_rodata",
    ".size func_with_rodata, . - func_with_rodata",
    ".section .rodata",
    "dlabel D_80002100",
    "/* 003100 80002100 3F800000 */ .word 0x3F800000",
  ].join("\n");
  const r = parseSplatAsm(asm);
  assert.equal(r.instructions.length, 2);
  assert.equal(r.data.length, 1, "rodata after the end label is still parsed");
  assert.deepEqual(r.rodataSymbols.map((s) => s.name), ["D_80002100"]);
});

// ── 2. absolute linker-script assignments are real symbols ─────────────────

test("loadLinkerMap: `NAME = 0xADDR` absolute assignments resolve", async () => {
  // ld prints a linker-script assignment with the value on BOTH sides, and the
  // symbol belongs to no input object. The old parser rejected it twice over,
  // so the comparator substituted zero into every relocation against it and
  // reported the fabricated words as byte MISMATCHES.
  const map = [
    "Linker script and memory map",
    "",
    " .text          0x80000400      0x20 build/src/main.o",
    "                0x80000400                func_main",
    "                0x802c8e90                        D_802C8E90 = 0x802c8e90",
    "                0x802c8e94                        D_802C8E94 = 0x802c8e94",
    "                0x802c8e98                        D_802C8E98 = 0x802c8e98",
  ].join("\n");
  const dir = await mkdtemp(path.join(os.tmpdir(), "ldmap-"));
  const p = path.join(dir, "test.map");
  await writeFile(p, map);
  const ld = await loadLinkerMap(p);

  for (const n of ["D_802C8E90", "D_802C8E94", "D_802C8E98"]) {
    const s = ld.symbols.get(n);
    assert.ok(s, `${n} must resolve — it is a real address in the map`);
    assert.equal(s.absolute, true);
    assert.equal(s.size, 0, "an absolute assignment is an address, not a sized object");
  }
  // The ordinary object symbol must be unaffected.
  assert.equal(ld.symbols.get("func_main")?.va, 0x80000400);
  assert.ok(!ld.symbols.get("func_main").absolute);
});

test("loadLinkerMap: absolute symbols do not corrupt neighbouring sizes", async () => {
  // They carry no object and no section, so letting them into the size
  // adjacency scan would truncate a real symbol's size.
  const withAbs = [
    " .text          0x80000400      0x40 build/src/main.o",
    "                0x80000400                func_a",
    "                0x802c8e90                        D_ABS = 0x802c8e90",
    "                0x80000420                func_b",
  ].join("\n");
  const withoutAbs = [
    " .text          0x80000400      0x40 build/src/main.o",
    "                0x80000400                func_a",
    "                0x80000420                func_b",
  ].join("\n");
  const dir = await mkdtemp(path.join(os.tmpdir(), "ldmap2-"));
  const a = path.join(dir, "a.map"); await writeFile(a, withAbs);
  const b = path.join(dir, "b.map"); await writeFile(b, withoutAbs);
  const la = await loadLinkerMap(a), lb = await loadLinkerMap(b);
  assert.equal(la.symbols.get("func_a").size, lb.symbols.get("func_a").size,
    "an absolute assignment between two functions must not change either size");
  assert.equal(la.symbols.get("func_a").size, 0x20);
});

// ── 3. an unresolved relocation is UNCHECKABLE, not a wrong byte ───────────

test("applyRelocations: an unresolved symbol marks the word instead of faking it", () => {
  const stream = [
    { word: 0x0c000000, reloc: { type: "R_MIPS_26", symbol: "known_fn", addend: 0 } },
    { word: 0x3c020000, reloc: { type: "R_MIPS_HI16", symbol: "UNKNOWN_SYM", addend: 0 } },
    { word: 0x00000000, reloc: null },
  ];
  const symbolVa = (n) => (n === "known_fn" ? 0x80001000 : null);
  const r = applyRelocations(stream, symbolVa, 0x80000000);

  assert.deepEqual(r.unresolved, ["UNKNOWN_SYM"]);
  assert.equal(r.stream[0].unresolvedReloc, undefined, "a resolved reloc is linked normally");
  assert.notEqual(r.stream[0].linkedWord, stream[0].word, "and its word actually changed");
  assert.equal(r.stream[1].unresolvedReloc, "UNKNOWN_SYM",
    "an unresolved reloc must be MARKED so the comparison can exclude it");
  assert.equal(r.stream[2].unresolvedReloc, undefined, "a word with no reloc is untouched");
  assert.equal(r.stream.length, 3, "every input word still yields exactly one output word");
});

test("applyRelocations: an unhandled relocation TYPE is marked the same way", () => {
  const stream = [{ word: 0x8c420000, reloc: { type: "R_MIPS_GPREL16", symbol: "gp_thing", addend: 0 } }];
  const r = applyRelocations(stream, () => 0x80001000, 0x80000000);
  assert.equal(r.stream[0].unresolvedReloc, "R_MIPS_GPREL16:gp_thing");
  assert.ok(r.unresolved.some((u) => u.includes("R_MIPS_GPREL16")));
});

// ── 4. ranking evidence must match the CURRENT source tree ────────────────

test("loadCandidateEvidence: a better score from an OLD dependency hash cannot rank the queue", async () => {
  // compile.js keys every result file `<dependencyHash>-<candidateSha>-v<verifier>`,
  // so the identity is already recorded — the planner simply ignored it, took
  // the global minimum distance across every result ever written, and set
  // `lastCompile` by directory iteration order. On a real campaign workspace
  // that spanned 258 dependency hashes over 2609 result files, and ranked
  // func_801EB4F4 at distance 6.8 when the current tree gives 82.45: a 12x
  // misranking that sends a permuter budget at a function that is not close.
  const { loadCandidateEvidence } = await import("../src/decomp/plan.js");
  const { VERIFIER_VERSION } = await import("../src/decomp/verdict.js");
  const { mkdir } = await import("node:fs/promises");

  const ws = await mkdtemp(path.join(os.tmpdir(), "cand-"));
  const dir = path.join(ws, "candidates", "func_x");
  await mkdir(dir, { recursive: true });

  const OLD = "a".repeat(20), CUR = "b".repeat(20);
  const write = async (dep, cand, distance, compileSucceeded) =>
    writeFile(path.join(dir, `${dep}-${cand}-v${VERIFIER_VERSION}.result.json`),
      JSON.stringify({ distance: { value: distance }, compileSucceeded, verifierVersion: VERIFIER_VERSION }));

  await write(OLD, "1".repeat(16), 6.8, true);     // great, but a different tree
  await write(CUR, "2".repeat(16), 82.45, true);   // what the current tree gives

  const project = { ws };
  const ev = await loadCandidateEvidence(project, { currentDependencyHashes: new Set([CUR]) });
  const e = ev.func_x;

  assert.equal(e.lastDistance, 82.45, "ranking must use the CURRENT tree's score");
  assert.equal(e.dependencyHash, CUR);
  assert.equal(e.attempts, 1, "attempts counts current-tree attempts only");
  // The old evidence is preserved and visible, just not rankable.
  assert.equal(e.historicalBestDistance, 6.8);
  assert.equal(e.historicalAttempts, 1);
  assert.match(e.staleEvidenceWarning, /different source tree/i);
});

test("loadCandidateEvidence: restoring the exact dependency identity makes evidence reusable", async () => {
  const { loadCandidateEvidence } = await import("../src/decomp/plan.js");
  const { VERIFIER_VERSION } = await import("../src/decomp/verdict.js");
  const { mkdir } = await import("node:fs/promises");
  const ws = await mkdtemp(path.join(os.tmpdir(), "cand2-"));
  const dir = path.join(ws, "candidates", "func_y");
  await mkdir(dir, { recursive: true });
  const DEP = "c".repeat(20);
  await writeFile(path.join(dir, `${DEP}-${"3".repeat(16)}-v${VERIFIER_VERSION}.result.json`),
    JSON.stringify({ distance: { value: 12.5 }, compileSucceeded: true, verifierVersion: VERIFIER_VERSION }));

  const ev = await loadCandidateEvidence({ ws }, { currentDependencyHashes: new Set([DEP]) });
  assert.equal(ev.func_y.lastDistance, 12.5, "the same tree makes prior evidence current again");
  assert.equal(ev.func_y.staleEvidenceWarning, undefined);
  assert.equal(ev.func_y.historicalAttempts, 0);
});

test("loadCandidateEvidence: an exact function-local verdict still scores 0", async () => {
  const { loadCandidateEvidence } = await import("../src/decomp/plan.js");
  const { VERIFIER_VERSION } = await import("../src/decomp/verdict.js");
  const { mkdir } = await import("node:fs/promises");
  const ws = await mkdtemp(path.join(os.tmpdir(), "cand3-"));
  const dir = path.join(ws, "candidates", "func_z");
  await mkdir(dir, { recursive: true });
  const DEP = "d".repeat(20);
  await writeFile(path.join(dir, `${DEP}-${"4".repeat(16)}-v${VERIFIER_VERSION}.result.json`),
    JSON.stringify({ distance: { value: 40 }, compileSucceeded: true, verifierVersion: VERIFIER_VERSION,
      verdict: { functionLocal: "exact" } }));
  const ev = await loadCandidateEvidence({ ws }, { currentDependencyHashes: new Set([DEP]) });
  assert.equal(ev.func_z.lastDistance, 0, "an exact verdict pins the distance to 0");
});

// ── 5. a finished job's elapsed time stops when the job stops ──────────────

test("jobStatus: a completed job's elapsed time is endedAt - startedAt, not now - startedAt", async () => {
  // This read Date.now() unconditionally, so a finished run's elapsed time kept
  // growing forever: four real jobs that ran 45-210 seconds against
  // minute-scale budgets reported ~9 DAYS, which reads as a runaway permuter
  // rather than a job that completed normally.
  const { jobStatus } = await import("../src/decomp/jobs.js");
  const { mkdir } = await import("node:fs/promises");

  const ws = await mkdtemp(path.join(os.tmpdir(), "jobs-"));
  const jobId = "search-func_done-test";
  const dir = path.join(ws, "jobs", jobId);
  await mkdir(dir, { recursive: true });

  // A job that ran for exactly 135 seconds, a long time ago.
  const startedAt = "2026-01-01T00:00:00.000Z";
  const endedAt = "2026-01-01T00:02:15.000Z";
  await writeFile(path.join(dir, "job.json"), JSON.stringify({
    jobId, project: "p", function: { symbol: "func_done", segment: "seg", va: "0x80000000" },
    status: "complete-budget", pid: 999999, startedAt, endedAt, timeLimitS: 120,
    threads: 2, dir, permuterDir: path.join(dir, "permuter"), log: path.join(dir, "permuter.log"),
  }));
  await writeFile(path.join(dir, "permuter.log"), "base score = 100\n");

  const s = await jobStatus({ ws }, jobId);
  assert.equal(s.elapsedS, 135, "elapsed is the real run duration, not the age of the record");
  assert.ok(s.elapsedS < 10 * 60, "a finished job must never report days of runtime");
});

test("jobStatus: a cancelled job measures to its cancellation, not to now", async () => {
  const { jobStatus } = await import("../src/decomp/jobs.js");
  const { mkdir } = await import("node:fs/promises");
  const ws = await mkdtemp(path.join(os.tmpdir(), "jobs2-"));
  const jobId = "search-func_cancel-test";
  const dir = path.join(ws, "jobs", jobId);
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, "job.json"), JSON.stringify({
    jobId, project: "p", function: { symbol: "func_cancel", segment: "seg", va: "0x80000000" },
    status: "cancelled", pid: 999999,
    startedAt: "2026-01-01T00:00:00.000Z", cancelledAt: "2026-01-01T00:00:20.000Z",
    timeLimitS: 45, threads: 2, dir, permuterDir: path.join(dir, "permuter"), log: path.join(dir, "permuter.log"),
  }));
  await writeFile(path.join(dir, "permuter.log"), "");
  const s = await jobStatus({ ws }, jobId);
  assert.equal(s.status, "cancelled");
  assert.equal(s.elapsedS, 20);
});
