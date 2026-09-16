// Client report 2026-09-16: `emit:'ir'` refused 4 of 7 commercial SMS carts with
// "decoder did not cover the complete bank window ending at N" -- including both
// carts they needed. Cause: the decoder was handed exactly one bank's bytes, so
// an instruction whose operands continue past the bank edge was truncated by
// objdump, the decode came up short, and the completeness check refused the
// whole cart.
//
// The window is a SLICING artifact, not a decode limit. A bank ending
// mid-instruction is normal: 4 of 7 shipped Sega titles do it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { exportZ80IR } from "../src/analysis/recompile/export-z80-ir.js";
import { mkdtemp, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

/** A 32KB ROM with the client's exact reported byte pattern at a bank edge. */
async function romWith(bytesAt) {
  const dir = await mkdtemp(path.join(tmpdir(), "romdev-straddle-"));
  const b = Buffer.alloc(32768);
  for (const [off, vals] of Object.entries(bytesAt)) {
    for (let i = 0; i < vals.length; i++) b[Number(off) + i] = vals[i];
  }
  const rom = path.join(dir, "t.sms");
  await writeFile(rom, b);
  return { rom, out: path.join(dir, "ir.jsonl") };
}

const run = (rom, out) => exportZ80IR({ platform: "sms", path: rom, outputPath: out, emit: "ir", allOffsets: true });

test("an instruction straddling the bank edge no longer refuses the cart", async () => {
  // @16381: c1 c8 dc -> pop bc; ret z; call c,nn -- the call's operands run
  // into bank 1 - the byte pattern the client reported from a commercial cart.
  const { rom, out } = await romWith({ 16381: [0xC1, 0xC8, 0xDC], 16384: [0x34, 0x12] });
  const m = await run(rom, out);
  assert.equal(m.coveredBytes, m.romBytes, "coveredBytes must equal romBytes -- the client's acceptance check");
  assert.equal(m.straddleCount, 1);
});

test("the straddling record is MARKED, not silently normal", async () => {
  const { rom, out } = await romWith({ 16381: [0xC1, 0xC8, 0xDC], 16384: [0x34, 0x12] });
  await run(rom, out);
  const rec = (await readFile(out, "utf8")).split("\n").filter(Boolean)
    .map((l) => JSON.parse(l)).find((r) => r.off === 16383);
  assert.ok(rec, "no record at the straddling offset");
  assert.equal(rec.straddlesWindow, true);
  assert.equal(rec.bytesBeyondWindow, 2);
  assert.equal(rec.len, 3, "the instruction must be emitted with its TRUE length");
  assert.match(rec.straddleNote, /next physical bank/i);
});

test("each byte is counted exactly once across the straddle", async () => {
  // A straddling instruction's trailing bytes live in the NEXT bank and are
  // counted there; double-counting would make coveredBytes exceed romBytes and
  // quietly break the completeness guarantee the client relies on.
  const { rom, out } = await romWith({ 16381: [0xC1, 0xC8, 0xDC], 16384: [0x34, 0x12] });
  const m = await run(rom, out);
  assert.equal(m.coveredBytes, 32768);
  assert.ok(m.coveredBytes <= m.romBytes, "bytes were counted twice");
});

test("an opcode in the ROM's final bytes is retained, not refused", async () => {
  // Found by probing: an opcode as the LAST byte has no operands to read and
  // no next bank to take them from. That is undecodable tail data, and
  // refusing the export would block a cart over its last byte.
  const { rom, out } = await romWith({ 32765: [0xC1, 0xC8, 0xDC] });
  const m = await run(rom, out);
  assert.equal(m.coveredBytes, m.romBytes);
  assert.equal(m.truncatedTailBytes, 1);
  const last = (await readFile(out, "utf8")).split("\n").filter(Boolean)
    .map((l) => JSON.parse(l)).at(-1);
  assert.equal(last.decodeStatus, "truncated-at-rom-end");
  assert.deepEqual(last.bytes, [0xDC], "the bytes must be retained, not dropped");
  assert.deepEqual(last.lifted, [], "undecodable tail must not be lifted");
});

test("a ROM whose banks end cleanly is unchanged", async () => {
  // The regression control: the three carts that passed before must still
  // pass, with no straddle records invented.
  const { rom, out } = await romWith({});
  const m = await run(rom, out);
  assert.equal(m.coveredBytes, m.romBytes);
  assert.equal(m.straddleCount, 0);
  // Was `undefined` - which encoded the omit-at-zero bug this suite now
  // forbids. A clean ROM reports zero truncated tail bytes; it does not omit
  // the count.
  assert.equal(m.truncatedTailBytes, 0);
});

test("a genuine decode gap is still refused", async () => {
  // The control that must fail: the completeness check has to keep its teeth.
  // Reaching in below the public API because a real gap cannot be produced
  // through it -- which is the point of the check.
  const { decodedIR } = await import("../src/analysis/recompile/export-z80-ir.js");
  const rom = Buffer.alloc(32768);
  assert.throws(
    () => decodedIR({ addr: 99999, bytes: "00", mnem: "nop", ops: "" },
      { off: 0, length: 16384, addr: 0, bank: 0, slot: 0 }, rom),
    /byte\/offset mismatch/,
    "an instruction starting outside the window must still be rejected");
});

// ── alignments:'all' (client report 2026-09-16) ──────────────────────────────
//
// `allOffsets:true` gives a single linear tiling: every byte owned once. A
// static recompiler needs the decode STARTING at every offset, because a
// computed jump (jp (hl), an rst table, a RAM-built dispatch) can land
// mid-instruction. Their measurement: 95,166 IR records vs 130,341 from their
// own k=0..7 sweep on a 128KB cart; the difference is entry points, and every
// miss cost one disasm call, making the IR path SLOWER than what it replaced.

test("alignments:'all' emits a record at EVERY byte offset", async () => {
  // Interleaved code and data: multi-byte instructions leave offsets that the
  // linear tiling never starts on.
  const dir = await mkdtemp(path.join(tmpdir(), "romdev-align-"));
  const b = Buffer.alloc(16384);
  for (let i = 0; i < 600; i += 3) { b[i] = 0x21; b[i + 1] = i & 0xff; b[i + 2] = 0xc0; } // ld hl,nn
  const rom = path.join(dir, "t.sms"), out = path.join(dir, "ir.jsonl");
  await writeFile(rom, b);
  const m = await exportZ80IR({ platform: "sms", path: rom, outputPath: out, emit: "ir", allOffsets: true, alignments: "all" });
  assert.equal(m.offsetsWithRecord, m.offsetsTotal, "every offset must carry a record");
  assert.equal(m.offsetsTotal, 16384);
  assert.ok(m.secondaryCount > 0, "a tiling of 3-byte instructions must leave secondary offsets");

  const offs = new Set((await readFile(out, "utf8")).split("\n").filter(Boolean).map((l) => JSON.parse(l).off));
  assert.equal(offs.size, 16384, "no offset may be missing");
});

test("secondary records are MARKED and their bytes are the ROM's", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "romdev-align2-"));
  const b = Buffer.alloc(16384);
  for (let i = 0; i < 600; i += 3) { b[i] = 0x21; b[i + 1] = i & 0xff; b[i + 2] = 0xc0; }
  const rom = path.join(dir, "t.sms"), out = path.join(dir, "ir.jsonl");
  await writeFile(rom, b);
  await exportZ80IR({ platform: "sms", path: rom, outputPath: out, emit: "ir", allOffsets: true, alignments: "all" });

  const recs = (await readFile(out, "utf8")).split("\n").filter(Boolean).map((l) => JSON.parse(l));
  const sec = recs.filter((r) => r.alignment === "secondary");
  assert.ok(sec.length, "no secondary records emitted");
  assert.ok(recs.some((r) => r.alignment === "primary"), "primary records must still be labelled");
  for (const r of sec.slice(0, 50)) {
    for (let i = 0; i < r.bytes.length; i++) {
      assert.equal(r.bytes[i], b[r.off + i], `secondary record at ${r.off} does not carry the ROM's bytes`);
    }
  }
});

test("the default export is UNCHANGED - no new fields, no extra records", async () => {
  // Existing consumers must see exactly what they saw before.
  const dir = await mkdtemp(path.join(tmpdir(), "romdev-align3-"));
  const b = Buffer.alloc(16384);
  for (let i = 0; i < 600; i += 3) { b[i] = 0x21; b[i + 1] = i & 0xff; b[i + 2] = 0xc0; }
  const rom = path.join(dir, "t.sms");
  await writeFile(rom, b);
  const def = await exportZ80IR({ platform: "sms", path: rom, outputPath: path.join(dir, "a.jsonl"), emit: "ir", allOffsets: true });
  assert.equal(def.alignments, undefined, "the default must not advertise an alignments mode");
  assert.equal(def.secondaryCount, undefined);
  const recs = (await readFile(path.join(dir, "a.jsonl"), "utf8")).split("\n").filter(Boolean).map((l) => JSON.parse(l));
  assert.ok(recs.every((r) => r.alignment === undefined), "default records must carry no alignment label");
  assert.equal(def.coveredBytes, def.romBytes);
});

test("secondary records overlap by design and must not be summed as coverage", async () => {
  // The trap this guards: summing every record's len against romBytes would
  // now overcount wildly. coveredBytes counts the PRIMARY tiling only.
  const dir = await mkdtemp(path.join(tmpdir(), "romdev-align4-"));
  const b = Buffer.alloc(16384);
  for (let i = 0; i < 600; i += 3) { b[i] = 0x21; b[i + 1] = i & 0xff; b[i + 2] = 0xc0; }
  const rom = path.join(dir, "t.sms");
  await writeFile(rom, b);
  const m = await exportZ80IR({ platform: "sms", path: rom, outputPath: path.join(dir, "a.jsonl"), emit: "ir", allOffsets: true, alignments: "all" });
  assert.equal(m.coveredBytes, m.romBytes, "coveredBytes must still be the primary tiling, not the sum of all records");
  assert.match(m.alignmentNote, /do NOT sum their lengths/i);
});

test("an unknown opcode is refused, never given fabricated semantics", async () => {
  // A downstream static recompiler turns these records into traps, so what
  // `lifted` contains is load-bearing. The manifest used to say unknowns "are
  // not silently lifted", which reads as `lifted: []`; in fact they carry a
  // single {op:'refuse'} marker. Measured on a real cart: 2,095 unknown
  // records, 2,095 refuse nodes, ZERO real operations. The safety property
  // holds - the wording did not describe it.
  const dir = await mkdtemp(path.join(tmpdir(), "romdev-unk-"));
  const b = Buffer.alloc(16384);
  for (let i = 0; i < 400; i += 2) b[i] = 0xFD;   // lone FD prefix -> undecodable
  const rom = path.join(dir, "t.sms"), out = path.join(dir, "ir.jsonl");
  await writeFile(rom, b);
  const m = await exportZ80IR({ platform: "sms", path: rom, outputPath: out, emit: "ir", allOffsets: true });
  assert.ok(m.unknownCount > 0, "fixture produced no unknown records");

  const unknowns = (await readFile(out, "utf8")).split("\n").filter(Boolean)
    .map((l) => JSON.parse(l)).filter((r) => r.decodeStatus === "unknown");
  for (const r of unknowns) {
    assert.ok(r.bytes.length, `unknown record at ${r.off} dropped its bytes`);
    for (const node of r.lifted ?? []) {
      assert.equal(node.op, "refuse",
        `unknown record at ${r.off} carries a real lifted op '${node.op}' - that is fabricated semantics`);
    }
    assert.deepEqual(r.targets, [], "an unknown opcode must not claim control-flow targets");
  }
  assert.match(m.note, /never given fabricated semantics/,
    "the manifest must describe what unknown records actually contain");
});

test("counts a consumer guards on are present AT ZERO, not omitted", async () => {
  // Reported by a client: `unresolvedOffsets` came back absent where it had
  // been 0. The emission was `...(unresolvedOffsets ? {...} : {})`, so the
  // HEALTHY case omitted the field - and an absent field is falsy in the same
  // direction as success. A caller writing `if (!m.unresolvedOffsets)` cannot
  // distinguish "zero unresolved" from "this romdev never reports it", which
  // is exactly the confident-wrong-answer shape.
  //
  // The note even claimed they were "reported rather than silently absent"
  // while the code made them silently absent.
  const dir = await mkdtemp(path.join(tmpdir(), "romdev-counts-"));
  const rom = path.join(dir, "t.sms");
  await writeFile(rom, Buffer.alloc(16384));       // all nop: every count is 0

  const def = await exportZ80IR({ platform: "sms", path: rom, outputPath: path.join(dir, "a.jsonl"), emit: "ir", allOffsets: true });
  for (const f of ["instrCount", "unknownCount", "coveredBytes", "straddleCount", "truncatedTailBytes"]) {
    assert.ok(f in def, `'${f}' is absent at zero - a guard on it cannot tell zero from unsupported`);
  }
  assert.equal(def.truncatedTailBytes, 0);
  // unresolvedOffsets belongs to alignments:'all' only; absent in the default
  // mode is correct, because the mode that produces it did not run.
  assert.ok(!("unresolvedOffsets" in def), "the default mode should not claim an alignment-only count");

  const all = await exportZ80IR({ platform: "sms", path: rom, outputPath: path.join(dir, "b.jsonl"), emit: "ir", allOffsets: true, alignments: "all" });
  for (const f of ["secondaryCount", "unresolvedOffsets", "offsetsWithRecord", "offsetsTotal"]) {
    assert.ok(f in all, `'${f}' is absent at zero under alignments:'all'`);
  }
  assert.equal(all.unresolvedOffsets, 0);
  assert.equal(all.secondaryCount, 0);
});
