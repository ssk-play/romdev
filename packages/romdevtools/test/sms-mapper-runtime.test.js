// Synthetic programs, no commercial ROM bytes. Genesis Plus GX selects these
// boards through its CRC database; the four-byte CRC fixup exercises that
// EXISTING runtime path. It is not a new emulator mapper-override feature.
import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveCore } from "../src/cores/registry.js";
import { LibretroHost } from "romdev-core-host/index.js";
import { smsWindow } from "../src/analysis/sms-mapping.js";

const table = Array.from({ length: 256 }, (_, i) => {
  let c = i; for (let j = 0; j < 8; j++) c = c & 1 ? 0xedb88320 ^ c >>> 1 : c >>> 1;
  return c >>> 0;
});
function crc32(bytes) {
  let c = 0xffffffff;
  for (const b of bytes) c = table[(c ^ b) & 255] ^ c >>> 8;
  return (c ^ 0xffffffff) >>> 0;
}
function fixupCRC(rom, desired) {
  const at = rom.length - 4, initial = crc32(rom), basis = new Array(32);
  for (let bit = 0; bit < 32; bit++) {
    rom[at + (bit >> 3)] ^= 1 << (bit & 7);
    let vector = (crc32(rom) ^ initial) >>> 0, mask = (1 << bit) >>> 0;
    rom[at + (bit >> 3)] ^= 1 << (bit & 7);
    while (vector) {
      const pivot = 31 - Math.clz32(vector);
      if (!basis[pivot]) { basis[pivot] = { vector, mask }; break; }
      vector = (vector ^ basis[pivot].vector) >>> 0; mask = (mask ^ basis[pivot].mask) >>> 0;
    }
  }
  let vector = (initial ^ desired) >>> 0, mask = 0;
  while (vector) {
    const b = basis[31 - Math.clz32(vector)]; assert.ok(b);
    vector = (vector ^ b.vector) >>> 0; mask = (mask ^ b.mask) >>> 0;
  }
  for (let bit = 0; bit < 32; bit++) if ((mask >>> bit) & 1) rom[at + (bit >> 3)] ^= 1 << (bit & 7);
  assert.equal(crc32(rom), desired);
}
function fixture(writeAddress, crc) {
  const rom = Buffer.alloc(128 * 1024);
  for (let bank = 0; bank < 8; bank++) rom[bank * 16384 + 8] = 0xa0 + bank;
  // Select bank6; read its signature; publish two observed bytes; spin.
  rom.set([0xf3, 0x31, 0xf0, 0xdf, 0x3e, 6, 0x32, writeAddress & 255, writeAddress >> 8,
    0x3a, 8, 0x80, 0x32, 0, 0xc0, 0x3e, 0x5a, 0x32, 1, 0xc0, 0xc3, 20, 0]);
  Buffer.from("TMR SEGA").copy(rom, 0x7ff0); rom[0x7fff] = 0x4f;
  if (crc != null) fixupCRC(rom, crc);
  return rom;
}

for (const [mapper, address, crc, expected] of [
  ["codemasters", 0x8000, 0x29822980, 0xa6],
  ["korean", 0xa000, 0x89b79e77, 0xa6],
  ["sega-control", 0x8000, null, 0xa2],
]) test(`actual SMS core: ${mapper} bank write selects the expected physical bytes`, async () => {
  const host = new LibretroHost(), core = resolveCore("sms"), rom = fixture(address, crc);
  try {
    await host.loadCore(core.jsPath, core.wasmPath);
    await host.loadMedia({ platform: "sms", bytes: rom });
    host.stepFrames(5);
    const ram = host.readMemory("system_ram", 0, 2);
    assert.deepEqual([...ram], [expected, 0x5a]);
    if (mapper !== "sega-control") assert.equal(rom[smsWindow(rom.length, 0x8008, { mapper, bank: 6 }).off], ram[0]);
  } finally { host.destroy?.(); }
});
