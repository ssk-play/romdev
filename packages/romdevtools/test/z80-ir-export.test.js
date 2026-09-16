import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile, writeFile, mkdtemp, symlink, link } from "node:fs/promises";
import { existsSync, createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";
import tables from "../src/analysis/recompile/z80-cycle-tables.json" with { type: "json" };
import { z80Cycles, z80Flags, z80Control } from "../src/analysis/recompile/z80-metadata.js";
import { exportZ80IR, irWindows } from "../src/analysis/recompile/export-z80-ir.js";

test("cycle tables are mechanically identical to the bundled core's six cc tables", { skip: !existsSync("build/gpgx/src/core/z80/z80.c") }, async () => {
  const raw = await readFile("build/gpgx/src/core/z80/z80.c", "utf8");
  assert.equal(createHash("sha256").update(raw).digest("hex"), tables.sourceSha256, "core changed: regenerate and review cycle provenance");
  const text = raw.replace(/\/\*[\s\S]*?\*\//g, "");
  for (const [name, values] of Object.entries(tables.tables)) {
    const match = new RegExp(`static const UINT16 cc_${name}\\[0x100\\]\\s*=\\s*\\{([^}]+)\\}`).exec(text);
    assert.ok(match);
    assert.deepEqual([...match[1].matchAll(/(\d+)\s*\*\s*15/g)].map((m) => Number(m[1])), values);
  }
});

test("cycle metadata covers base, conditional, CB, ED, index and indexed-CB forms", () => {
  for (const [bytes, expected] of [
    [[0], [4, 4]], [[0x20, 0xfe], [12, 7]], [[0xc4, 0, 0], [17, 10]], [[0xc0], [11, 5]],
    [[0xff], [11, 11]], [[0xcb, 0x46], [12, 12]], [[0xed, 0xa2], [16, 16]],
    [[0xed, 0xb2], [21, 16]], [[0xdd, 0x21, 0, 0], [14, 14]], [[0xdd, 0xcb, 0, 0x46], [20, 20]],
  ]) assert.deepEqual(z80Cycles(bytes), expected, bytes.join(","));
  assert.equal(z80Cycles([0xdd]), null);
});

test("control targets are CPU addresses, calls retain return edges, and flags distinguish 8/16-bit INC", () => {
  assert.deepEqual(z80Control("call", "0xb642", 0x8100, 3), { kind: "call", targets: [0xb642], fallthrough: 0x8103, conditional: false });
  assert.equal(z80Control("jp", "(hl)", 0x8100, 1).kind, "indirect");
  assert.deepEqual(z80Flags("jr", "nz,0x8000").flagsRead, ["Z"]);
  assert.deepEqual(z80Flags("inc", "hl").flagsWritten, []);
  assert.ok(z80Flags("inc", "(hl)").flagsWritten.includes("Z"));
  assert.ok(!z80Flags("inc", "(hl)").flagsWritten.includes("C"));
});

test("whole-cart windows cover 1MB without confusing slot addresses and ROM offsets", () => {
  const windows = irWindows(1024 * 1024, { allOffsets: true });
  assert.equal(windows.length, 64);
  assert.equal(windows.reduce((n, w) => n + w.length, 0), 1024 * 1024);
  assert.deepEqual(windows[7], { off: 7 * 16384, length: 16384, bank: 7, addr: 0x8000, slot: 2 });
  assert.throws(() => irWindows(1024 * 1024, { startAddress: 0x10000 }), /file offset/);
  assert.equal(irWindows(1024 * 1024, { fileOffset: 7 * 16384, length: 16, slot: 1 })[0].addr, 0x4000);
});

test("bundled decoder exports complete zero runs, prefixes, targets and actual lifted nodes to JSONL", async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "romdev-ir-"));
  const romPath = path.join(tmp, "sample.sms"), outputPath = path.join(tmp, "sample.jsonl");
  const rom = Buffer.from([0, 0, 0, 0x20, 0xfe, 0xcd, 0x34, 0x12, 0xdd, 0xcb, 0xfe, 0x46, 0xed, 0xb2, 0xc9]);
  await writeFile(romPath, rom);
  const manifest = await exportZ80IR({ path: romPath, outputPath, platform: "sms", allOffsets: true });
  const records = (await readFile(outputPath, "utf8")).trim().split("\n").map(JSON.parse);
  assert.equal(manifest.coveredBytes, rom.length);
  assert.equal(manifest.instrCount, 8);
  assert.equal(manifest.mainAsm, undefined);
  assert.equal(Buffer.concat(records.map((r) => Buffer.from(r.bytes))).equals(rom), true);
  assert.deepEqual(records[3].targets, [3]);
  assert.deepEqual(records[4].targets, [0x1234]);
  assert.ok(records[4].lifted.some((n) => n.op === "call"));
  assert.deepEqual(records[6].cycles, [21, 16]);
  await assert.rejects(exportZ80IR({ path: romPath, platform: "sms" }), /outputPath/);
  await assert.rejects(exportZ80IR({ path: romPath, outputPath: romPath, platform: "sms" }), /overwrite/);
  const alias = path.join(tmp, "alias.sms"), parentAlias = path.join(tmp, "alias-dir");
  await link(romPath, alias);
  await symlink(tmp, parentAlias);
  for (const outputPath of [alias, path.join(parentAlias, "sample.sms")]) {
    await assert.rejects(exportZ80IR({ path: romPath, outputPath, platform: "sms" }), /aliases/);
  }
  assert.deepEqual(await readFile(romPath), rom);
});

test("128KB physical cart export is one manifest with eight banks and unchanged absolute targets", async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "romdev-ir-banked-"));
  const romPath = path.join(tmp, "banks.sms"), outputPath = path.join(tmp, "banks.jsonl");
  const rom = Buffer.alloc(128 * 1024, 0);
  // Three-byte instructions keep the fixture/output compact. Each bank ends
  // with NOP; no instruction is manufactured across a bank boundary.
  for (let bank = 0; bank < 8; bank++) for (let off = bank * 16384; off + 3 <= (bank + 1) * 16384; off += 3) rom.set([0xc3, 0x42, 0xb6], off);
  await writeFile(romPath, rom);
  const manifest = await exportZ80IR({ path: romPath, outputPath, platform: "sms", allOffsets: true });
  assert.equal(manifest.coveredBytes, rom.length);
  assert.deepEqual(manifest.banks, [0, 1, 2, 3, 4, 5, 6, 7]);
  let cursor = 0;
  for await (const line of createInterface({ input: createReadStream(outputPath), crlfDelay: Infinity })) {
    const r = JSON.parse(line);
    assert.equal(r.off, cursor); cursor += r.len;
    if (r.mnemonic === "jp") assert.deepEqual(r.targets, [0xb642]);
    if (r.bank === 7) assert.ok(r.addr >= 0x8000 && r.addr < 0xc000);
  }
  assert.equal(cursor, rom.length);
});
