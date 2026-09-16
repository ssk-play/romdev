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
  // into bank 1 — the byte pattern the client reported from a commercial cart.
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
  assert.equal(m.truncatedTailBytes, undefined);
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
