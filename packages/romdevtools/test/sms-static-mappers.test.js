import { test } from "node:test";
import assert from "node:assert/strict";
import { smsWindow, smsWindows } from "../src/analysis/sms-mapping.js";
import { mapSmsAddress } from "../src/mcp/tools/disasm.js";
import { irWindows } from "../src/analysis/recompile/export-z80-ir.js";

const size = 128 * 1024;
test("Sega pages all three slots but pins its first 1KB", () => {
  assert.equal(smsWindow(size, 0x200, { bank: 7 }).off, 0x200);
  assert.equal(smsWindow(size, 0x400, { bank: 7 }).off, 7 * 16384 + 0x400);
  assert.equal(smsWindow(size, 0x4000, { bank: 7 }).off, 7 * 16384);
  assert.equal(smsWindows(size, 0, 16384).length, 1);
  const windows = smsWindows(size, 0x3fe, 4, { bank: 7 });
  assert.deepEqual(windows.map(w => [w.off, w.length]), [[0x3fe, 2], [7 * 16384 + 0x400, 2]]);
});

test("Codemasters pages slot0 including vectors and rejects enabled cartridge RAM", () => {
  assert.equal(smsWindow(size, 0, { mapper: "codemasters", bank: 7 }).off, 7 * 16384);
  assert.throws(() => smsWindow(size, 0xa000, { mapper: "codemasters", mapperState: { pages: [0, 1, 2], ramEnabled: true } }), /RAM/);
  assert.throws(() => smsWindow(size, 0x8000, { mapperState: { pages: [0, 1, 2], control: 8 } }), /RAM/);
});

test("Korean A000 and 16K-v2 are separate explicitly scoped boards", () => {
  assert.equal(smsWindow(size, 0x9000, { mapper: "korean", bank: 6 }).off, 6 * 16384 + 0x1000);
  assert.throws(() => smsWindow(size, 0x4000, { mapper: "korean", bank: 6 }), /fixed slot/);
  assert.equal(smsWindow(size, 0x4000, { mapper: "korean-16k-v2", bank: 6 }).off, 6 * 16384);
  assert.throws(() => smsWindow(size, 0, { mapper: "korean-16k-v2", bank: 6 }), /fixed slot/);
  assert.throws(() => smsWindow(size, 0, { mapper: "korean-8k" }), /Unsupported/);
});

test("ROM and IR consumers use the same explicit CPU mapping, never rebase operands", () => {
  const rom = Buffer.alloc(size);
  rom.set([0xc3, 0x42, 0xb6], 7 * 16384);
  const mapped = mapSmsAddress(rom, 0x4000, 3, 7, { mapper: "codemasters" });
  assert.deepEqual([...mapped.bytes], [0xc3, 0x42, 0xb6]);
  assert.equal(mapped.fileOffset, 7 * 16384);
  const windows = irWindows(size, { startAddress: 0x4000, length: 3, bank: 7, mapper: "codemasters" });
  assert.equal(windows[0].off, mapped.fileOffset);
  assert.throws(() => mapSmsAddress(rom, 0x3fe, 4, 7), /non-contiguous/);
  assert.throws(() => irWindows(size, { allOffsets: true, mapperState: { pages: [0, 1, 2] } }), /physical/);
});
