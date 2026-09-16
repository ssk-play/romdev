// CFG call edges + static reachability.
//
// THE BUG THIS PINS. A call ends a basic block conceptually, but the CFG
// emitted neither the CALLEE (no node, no edge - the called function was
// invisible) nor typed the RETURN SITE (where execution resumes once the
// callee returns). For a recompiler that is fatal: `ret` pops an address that
// has no compiled block, and execution traps on the first returned-to
// instruction. It was reported on four CPU families at once (6502 jsr, Z80
// call, 68000 jsr, SM83 call), because it was one behaviour in the shared
// builder rather than four per-platform bugs.
//
// THE SECOND HALF, found while verifying the first fix on a real ROM: rizin
// does not end a basic block at a call on every architecture. On Z80 it treats
// `call` as straight-line code, so a real SMS function had FOUR consecutive
// calls sitting INSIDE one 31-byte block whose last instruction was a plain
// `ld`. Reading only each block's terminator therefore found no calls at all -
// the fix looked right on synthetic input and did nothing on real code. Calls
// must be collected at every instruction, not just the block's last.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile, writeFile, mkdtemp } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";

import { buildForPlatform } from "../src/toolchains/index.js";
import { analyzeFunctions, analyzeCfg, analyzeReachable } from "../src/analysis/analyze.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** Build the NES example and return its ROM path. */
async function buildNesRom() {
  const src = await readFile(path.join(__dirname, "..", "examples", "nes", "main.c"), "utf8");
  const b = await buildForPlatform({ platform: "nes", source: src, sourceName: "main.c", language: "c" });
  assert.ok(b.binary, "nes build failed");
  const dir = await mkdtemp(path.join(os.tmpdir(), "cfg-call-test-"));
  const rom = path.join(dir, "cfgtest.nes");
  await writeFile(rom, b.binary);
  return rom;
}

/** All functions, tolerating either response key (`functions` or `functionsPage`). */
const fnList = (res) => res?.functions ?? res?.functionsPage ?? [];

test("a call emits BOTH a call edge to the callee and a typed call_return edge", async () => {
  const rom = await buildNesRom();
  const fns = await analyzeFunctions(rom, "nes");
  const all = fnList(fns);
  assert.ok(all.length > 0, "need functions to graph");

  // Find a function that actually contains a call.
  let withCalls = null;
  for (const f of all.slice(0, 40)) {
    const cfg = await analyzeCfg(rom, f.address, "nes");
    if ((cfg.edges ?? []).some((e) => e.type === "call")) { withCalls = cfg; break; }
  }
  assert.ok(withCalls, "expected at least one call-bearing function in the example ROM");

  const calls = withCalls.edges.filter((e) => e.type === "call");
  const returns = withCalls.edges.filter((e) => e.type === "call_return");
  assert.ok(calls.length > 0, "the callee edge must exist - otherwise the callee is invisible");
  assert.ok(returns.length > 0, "the return site must be emitted - otherwise `ret` has no compiled block");

  // Every call site must have a matching return site: the two halves of a call.
  for (const c of calls) {
    assert.ok(returns.some((r) => r.from === c.from),
      `call at 0x${c.from.toString(16)} has no call_return - the return address would never be compiled`);
  }

  // callTargets summarises the callees, which is what makes the call graph walkable.
  assert.ok(Array.isArray(withCalls.callTargets) && withCalls.callTargets.length > 0);
  for (const t of withCalls.callTargets) {
    assert.ok(calls.some((c) => c.to === t), "every callTarget is backed by a call edge");
  }
});

test("the return site is the address AFTER the call instruction, not the callee", async () => {
  const rom = await buildNesRom();
  const fns = await analyzeFunctions(rom, "nes");

  for (const f of fnList(fns).slice(0, 40)) {
    const cfg = await analyzeCfg(rom, f.address, "nes");
    const calls = (cfg.edges ?? []).filter((e) => e.type === "call");
    if (!calls.length) continue;
    for (const c of calls) {
      const ret = cfg.edges.find((e) => e.type === "call_return" && e.from === c.from);
      if (!ret) continue;
      // 6502 `jsr abs` is 3 bytes, so the return address is the call site + 3.
      assert.equal(ret.to, c.from + 3,
        `jsr at 0x${c.from.toString(16)} must return to 0x${(c.from + 3).toString(16)}`);
      assert.notEqual(ret.to, c.to, "the return site is not the callee");
    }
    return; // one call-bearing function is enough to pin the arithmetic
  }
  assert.fail("no call-bearing function found");
});

test("a block's nodes carry a terminator classification", async () => {
  const rom = await buildNesRom();
  const fns = await analyzeFunctions(rom, "nes");
  const cfg = await analyzeCfg(rom, fnList(fns)[0].address, "nes");
  const kinds = new Set(cfg.nodes.map((n) => n.terminator).filter(Boolean));
  for (const k of kinds) {
    assert.ok(["call", "ret", "jump", "branch"].includes(k), `unexpected terminator kind '${k}'`);
  }
});

test("reachable: the walk follows call edges and closes over the callees", async () => {
  const rom = await buildNesRom();
  const fns = await analyzeFunctions(rom, "nes");
  const all = fnList(fns);

  // Start from a function that calls others; the walk must reach more
  // functions than the one it started from.
  let entry = null;
  for (const f of all.slice(0, 40)) {
    const cfg = await analyzeCfg(rom, f.address, "nes");
    if ((cfg.callTargets ?? []).length > 0) { entry = f.address; break; }
  }
  assert.ok(entry != null, "need a calling function to test the walk");

  const r = await analyzeReachable(rom, [entry], "nes");
  assert.equal(r.platform, "nes");
  assert.ok(r.blockCount > 0, "the walk reaches blocks");
  assert.ok(r.functionCount > 1, `the walk must expand callees, got ${r.functionCount} function(s)`);
  assert.ok(r.byteSize > 0, "reached blocks have a byte size");
  // Blocks are unique and sorted - a set, not a list with repeats.
  const addrs = r.blocks.map((b) => b.address);
  assert.deepEqual(addrs, [...new Set(addrs)].sort((a, b) => a - b), "blocks are a sorted unique set");
  // The honest limit must be stated, because no static walk can follow a
  // computed jump and a caller has to know that before trusting the closure.
  assert.match(r.note, /computed|indirect/i);
  assert.match(r.note, /jumptable/);
});

test("reachable: more entries can only grow the closure, never shrink it", async () => {
  const rom = await buildNesRom();
  const fns = await analyzeFunctions(rom, "nes");
  const all = fnList(fns);
  const a = all[0].address;
  const b = all[Math.min(1, all.length - 1)].address;

  const one = await analyzeReachable(rom, [a], "nes");
  const two = await analyzeReachable(rom, [a, b], "nes");
  assert.ok(two.blockCount >= one.blockCount,
    "adding an entry must not lose blocks");
  const oneSet = new Set(one.blocks.map((x) => x.address));
  for (const addr of oneSet) {
    assert.ok(two.blocks.some((x) => x.address === addr),
      `block 0x${addr.toString(16)} disappeared when an entry was added`);
  }
});

test("reachable: requires entries, and reports maxBlocks truncation honestly", async () => {
  const rom = await buildNesRom();
  await assert.rejects(() => analyzeReachable(rom, [], "nes"), /entries required/i);

  const fns = await analyzeFunctions(rom, "nes");
  const capped = await analyzeReachable(rom, [fnList(fns)[0].address], "nes", { maxBlocks: 1 });
  assert.equal(capped.blockCount, 1);
  assert.equal(capped.truncated, true, "a capped walk must say so");
  assert.match(capped.hint, /maxBlocks/);
});

test("functions: the default returns everything, and a cap renames the array", async () => {
  const rom = await buildNesRom();

  // Default: no cap, and the array is named `functions`.
  const all = await analyzeFunctions(rom, "nes");
  assert.ok(Array.isArray(all.functions), "an untruncated response uses `functions`");
  assert.equal(all.functionsPage, undefined);
  assert.equal(all.truncated, undefined, "the default must not truncate");
  assert.equal(all.functions.length, all.count);

  // Capped: renamed to `functionsPage` so a partial list cannot be misread as
  // the whole set - the failure that scaled with ROM size (25 of 406 on Genesis).
  if (all.count > 1) {
    const page = await analyzeFunctions(rom, "nes", { topN: 1 });
    assert.equal(page.truncated, true);
    assert.ok(Array.isArray(page.functionsPage), "a truncated response uses `functionsPage`");
    assert.equal(page.functions, undefined, "and must NOT also present it as `functions`");
    assert.equal(page.total, all.count, "total reports the real size");
  }
});

// ── target:'bytes' is 6502-family only, and says so ─────────────────────────

test("disasm target:'bytes' REFUSES a non-6502 platform instead of decoding it wrong", async () => {
  const { z } = await import("zod");
  const { registerDisasmTools } = await import("../src/mcp/tools/disasm.js");
  let handler;
  registerDisasmTools({ tool(name, _d, _s, h) { if (name === "disasm") handler = h; } }, z);

  // `dd 7e 05` is Z80 `ld a,(ix+5)`. Fed to da65 it came back as `cmp $057E,x`
  // -- a real instruction, from the wrong CPU, with nothing to signal the
  // mistake. `platform` was simply ignored on this path.
  const res = await handler({
    target: "bytes",
    base64: Buffer.from([0xdd, 0x7e, 0x05]).toString("base64"),
    platform: "sms",
    inline: true,
  });
  assert.equal(res.isError, true, "a Z80 platform must not silently decode as 6502");
  const msg = res.content.map((c) => c.text).join(" ");
  assert.match(msg, /Z80/);
  assert.match(msg, /target:'rom'/, "the refusal must name the op that does work");

  // A 6502-family platform still works.
  const ok = await handler({
    target: "bytes",
    base64: Buffer.from([0xa9, 0x42]).toString("base64"),
    platform: "nes",
    inline: true,
  });
  assert.notEqual(ok.isError, true, "nes is 6502 and must still disassemble");
});
