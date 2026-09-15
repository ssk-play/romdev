// Round-2 defects: three silent wrong answers and one class of silent drop.
//
// What links them is the shape, not the subsystem: each returned a
// SUCCESS-SHAPED response that was wrong, so a caller had no signal to
// distrust it. A banked walk reporting `unresolved: 0`, an empty memory read
// on a host with no memory, and a parameter accepted then ignored are all the
// same failure — the tool answered a question it had not actually been asked.

import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFile, mkdtemp } from "node:fs/promises";
import path from "node:path";
import os from "node:os";

// ── 2. reachability must be bank-aware on a banked cart ────────────────────

/** A minimal Sega-mapper SMS image with DIFFERENT bytes in each 16KB bank. */
async function bankedFixture(banks = 4) {
  const rom = Buffer.alloc(0x4000 * banks, 0xc9);         // ret everywhere
  for (let b = 0; b < banks; b++) {
    // Each bank gets a distinct, decodable routine at its $8000 window start.
    const at = b * 0x4000;
    // ld a,<bank> ; ret  — different immediate per bank, so the bytes differ.
    rom[at] = 0x3e; rom[at + 1] = b; rom[at + 2] = 0xc9;
  }
  Buffer.from("TMR SEGA", "ascii").copy(rom, 0x7ff0);
  const dir = await mkdtemp(path.join(os.tmpdir(), "banked-"));
  const p = path.join(dir, "banked.sms");
  await writeFile(p, rom);
  return p;
}

test("reachable: the same paged address in two banks is TWO blocks, not one", async () => {
  // On a Sega-mapper cart $8000-$BFFF means different code per bank. Keying a
  // block by address alone collapsed all eight banks of a real 128KB cart onto
  // one arm per address — 880 paged blocks over exactly 880 distinct addresses
  // — while reporting `unresolved: 0`.
  const { analyzeReachable } = await import("../src/analysis/analyze.js");
  const rom = await bankedFixture(4);

  const a = await analyzeReachable(rom, [[0x8000, 1]], "sms");
  const b = await analyzeReachable(rom, [[0x8000, 3]], "sms");

  // Every paged block must carry the bank it was walked in.
  const pagedA = a.blocks.filter((x) => x.address >= 0x8000 && x.address < 0xc000);
  const pagedB = b.blocks.filter((x) => x.address >= 0x8000 && x.address < 0xc000);
  assert.ok(pagedA.every((x) => x.bank === 1), "bank 1 blocks must be tagged bank 1");
  assert.ok(pagedB.every((x) => x.bank === 3), "bank 3 blocks must be tagged bank 3");
  assert.deepEqual(a.banking.banksSeen, [1]);
  assert.deepEqual(b.banking.banksSeen, [3]);
});

test("reachable: a BARE address in the paged window is warned about, not silently walked", async () => {
  // The reporter's decisive point: `unresolved` is the field a caller uses to
  // decide whether to trust the closure. Reporting 0 while following whichever
  // bank the flat image happens to hold is worse than refusing.
  const { analyzeReachable } = await import("../src/analysis/analyze.js");
  const rom = await bankedFixture(4);
  const r = await analyzeReachable(rom, [0x8000], "sms");
  assert.ok(r.banking, "a banked platform must report its banking state");
  assert.match(r.banking.window, /8000-.*bfff/i, `window was ${r.banking.window}`);
  assert.match(r.banking.warning, /NO bank/i);
  assert.match(r.banking.warning, /not a reliable answer|different code per bank/i);
  assert.match(r.banking.warning, /entries:\[\[addr, bank\]|bank-keyed/i, "the warning must say how to fix it");
});

test("reachable: an unbanked platform reports no banking section at all", async () => {
  // The walker is correct and useful on unbanked ROMs; it must not grow a
  // warning there.
  const { analyzeReachable } = await import("../src/analysis/analyze.js");
  const rom = await bankedFixture(2);
  const r = await analyzeReachable(rom, [0x100], "sms");
  // $0100 is in the FIXED slot, so no paged block and no warning.
  assert.equal(r.banking?.warning, undefined, "a fixed-slot walk must not warn about banking");
});

test("reachable: an entry with no code says so plainly, not in raw rizin stderr", async () => {
  // The reason carried an ANSI escape, a rizin assertion warning and a header
  // dump claiming the wrong ROM size — which reads as romdev being confused
  // about the ROM. And semantically these are entries with NO CODE, not
  // unresolved indirect jumps, which is what `unresolved` is for.
  const { analyzeReachable } = await import("../src/analysis/analyze.js");
  const rom = await bankedFixture(2);
  const r = await analyzeReachable(rom, [0x10, 0x18], "sms");
  for (const u of r.unresolved ?? []) {
    assert.doesNotMatch(u.reason, /\x1b\[/, "no ANSI escapes in a reason");
    assert.doesNotMatch(u.reason, /assertion|RomSize|Checksum/i, "no rizin internals in a reason");
  }
  // The synthetic fixture is `ret` everywhere, so rizin may legitimately find a
  // one-instruction function at these addresses and report nothing unresolved.
  // What must hold is that ANY entry it does report is clean and typed.
  for (const u of r.unresolved ?? []) {
    // EVERY unresolved entry carries `kind`, not just the ones from one code
    // path. The field was set only where analysis SUCCEEDED and returned no
    // blocks; an unused vector actually arrives via the exception path, so the
    // field was absent from exactly the case a caller hits — and a caller
    // branching on `kind === 'no-code'` instead of string-matching `reason`
    // would have seen undefined.
    assert.ok(u.kind, `every unresolved entry needs a kind (missing on ${u.addressHex})`);
    assert.ok(["no-code", "indirect-jump", "analysis-failed"].includes(u.kind), `unexpected kind '${u.kind}'`);
  }
});

test("reachable: an address with genuinely no code is typed kind:'no-code'", async () => {
  // Past the end of the image there is nothing to find, which is the case an
  // unused RST vector hits on a real ROM. It arrives through the EXCEPTION
  // path, which is the one that was missing `kind`.
  const { analyzeReachable } = await import("../src/analysis/analyze.js");
  const rom = await bankedFixture(2);
  const r = await analyzeReachable(rom, [0x9000], "sms");   // past the image: nothing to find
  assert.ok(r.unresolved?.length, "an entry with no function must be reported");
  for (const u of r.unresolved) {
    assert.ok(u.kind, `every unresolved entry needs a kind (missing on ${u.addressHex})`);
    assert.doesNotMatch(u.reason, /\x1b\[|assertion|RomSize/i, "and a clean reason");
  }
});

// ── 4. per-op parameter validation ─────────────────────────────────────────

test("a parameter valid on a SIBLING op is refused, naming where it belongs", async () => {
  // Three measured drops, one root cause: validation was per-TOOL, so every key
  // valid on ANY op was accepted on EVERY op and quietly ignored. On NES
  // `address` on target:'recompile' was invisible because the reset vector IS
  // $8000 — a plausible result for the wrong address.
  const { z } = await import("zod");
  const { makeScopeChecker } = await import("../src/mcp/util.js");
  const shape = {
    target: z.enum(["rom", "recompile", "cfg"]).describe("what to do"),
    address: z.number().optional().describe("target=cfg: address inside the function to graph."),
    startAddress: z.number().default(0x8000).describe("target=rom/recompile: address of the first byte."),
  };
  const check = makeScopeChecker(shape, "disasm");
  assert.ok(check, "a tool with a discriminator and scoped params gets a checker");

  const bad = check({ target: "recompile", address: 35690 });
  assert.match(bad, /'address' does not apply to target:'recompile'/);
  assert.match(bad, /belongs to target:'cfg'/, "it must say where the parameter DOES apply");
  assert.match(bad, /silently ignored/, "and why refusing is better than accepting");

  assert.equal(check({ target: "cfg", address: 35690 }), null, "the same param on its own op is fine");
  assert.equal(check({ target: "recompile", startAddress: 126 }), null, "a multi-op param works on each");
});

test("a parameter still holding its DECLARED DEFAULT is never flagged", async () => {
  // The SDK applies defaults before the handler runs, so a defaulted value is
  // indistinguishable from one the caller never passed. Flagging those rejected
  // every valid call on the tool.
  const { z } = await import("zod");
  const { makeScopeChecker } = await import("../src/mcp/util.js");
  const shape = {
    target: z.enum(["rom", "bytes"]).describe("what to do"),
    cpu: z.enum(["6502", "65c02"]).default("6502").describe("target=bytes: CPU dialect."),
  };
  const check = makeScopeChecker(shape, "disasm");
  assert.equal(check({ target: "rom", cpu: "6502" }), null, "the default value is not a caller choice");
  assert.match(check({ target: "rom", cpu: "65c02" }), /'cpu' does not apply/, "a NON-default value is");
});

test("shared parameters are exempt, because their descriptions are not exhaustive", async () => {
  // `path` documents some targets and is required by others the text never
  // mentions. Enforcing an incomplete list rejects valid calls, which is worse
  // than the silent drop it was meant to catch.
  const { z } = await import("zod");
  const { makeScopeChecker } = await import("../src/mcp/util.js");
  const shape = {
    target: z.enum(["rom", "recompile"]).describe("what to do"),
    path: z.string().optional().describe("target=rom: ROM file path."),
  };
  // With `path` exempted there is nothing left to enforce, so the checker is
  // null — and a null checker means the handler is never wrapped at all.
  const check = makeScopeChecker(shape, "disasm");
  assert.equal(check, null, "`path` is shared vocabulary, so no scoped params remain");

  // With a genuinely scoped param alongside it, `path` is still allowed while
  // the scoped one is enforced.
  const shape2 = { ...shape, bank: z.number().optional().describe("target=rom: switchable ROM bank.") };
  const check2 = makeScopeChecker(shape2, "disasm");
  assert.equal(check2({ target: "recompile", path: "/x.nes" }), null, "`path` stays exempt");
  assert.match(check2({ target: "recompile", bank: 3 }), /'bank' does not apply/, "a scoped param is still enforced");
});

test("a tool with no op discriminator gets no per-op checker", async () => {
  const { z } = await import("zod");
  const { makeScopeChecker } = await import("../src/mcp/util.js");
  assert.equal(makeScopeChecker({ path: z.string() }, "t"), null);
});

// ── 3. a host with no memory regions must ERROR, not return empty ──────────

/** A fake host that reports the wasmcart capability shape. */
function regionlessHost() {
  return {
    status: { platform: "wasmcart", loaded: true },
    getCapabilities: () => ({ kind: "wasmcart", hasMemoryRegions: false, hasWasmIntrospection: true }),
    readMemory: () => new Uint8Array(0),   // what produced length:0 / hex:""
  };
}

function emulatedHost() {
  return {
    status: { platform: "sms", loaded: true },
    getCapabilities: () => ({ kind: "libretro", hasMemoryRegions: true }),
    readMemory: (_r, _o, n) => new Uint8Array(n ?? 8),
  };
}

test("a read on a host with NO memory regions errors instead of returning empty", async () => {
  // An empty read is indistinguishable from "this region is legitimately all
  // zeroes" — and on a freshly booted cart, zeroes are exactly what a caller
  // expects. One reporter briefly believed they were reading a cart's RAM and
  // getting valid data.
  const { z } = await import("zod");
  const { registerMemoryTools } = await import("../src/mcp/tools/memory.js");
  const { _setHostForTest } = await import("../src/mcp/state.js");
  const key = "regionless-read";
  _setHostForTest(key, regionlessHost());
  let handler;
  registerMemoryTools({ tool(n, _d, _s, h) { if (n === "memory") handler = h; } }, z, key);

  const res = await handler({ op: "read", region: "system_ram", offset: 0, length: 8 });
  assert.equal(res.isError, true, "an empty read must be an error, never a success shape");
  const text = res.content.map((c) => c.text).join(" ");
  assert.match(text, /NO memory regions/i);
  assert.match(text, /hasMemoryRegions:false/, "cite the capability the host itself reports");
  assert.match(text, /wasm\(\{op:'memory'\}\)|linear memory/i, "point at the path that DOES work");
});

test("a foreign region gets no confident platform-specific decode note", async () => {
  // Asking a wasmcart for an NES region returned a 64-sprite layout note
  // alongside an empty payload. A confident wrong note is worse than silence.
  const { z } = await import("zod");
  const { registerMemoryTools } = await import("../src/mcp/tools/memory.js");
  const { _setHostForTest } = await import("../src/mcp/state.js");
  const key = "regionless-foreign";
  _setHostForTest(key, regionlessHost());
  let handler;
  registerMemoryTools({ tool(n, _d, _s, h) { if (n === "memory") handler = h; } }, z, key);

  const res = await handler({ op: "read", region: "nes_oam" });
  assert.equal(res.isError, true);
  const text = res.content.map((c) => c.text).join(" ");
  assert.doesNotMatch(text, /64 sprites/i, "no NES sprite-layout note on a host with no NES");
});

test("op:'regions' says there are none, instead of listing 126 dead ids", async () => {
  // The 126-id dump is the same wall of `nes_*` that hid a real region for a
  // whole project — and its note promised "a read of one this core does not
  // expose returns an error rather than wrong bytes", which was FALSE here.
  const { z } = await import("zod");
  const { registerMemoryTools } = await import("../src/mcp/tools/memory.js");
  const { _setHostForTest } = await import("../src/mcp/state.js");
  const key = "regionless-list";
  _setHostForTest(key, regionlessHost());
  let handler;
  registerMemoryTools({ tool(n, _d, _s, h) { if (n === "memory") handler = h; } }, z, key);

  const res = await handler({ op: "regions" });
  const j = JSON.parse(res.content.find((c) => c.type === "text").text);
  assert.equal(j.count, 0, "no regions, so none are listed");
  assert.equal(j.hasMemoryRegions, false);
  assert.deepEqual(j.regions, []);
  assert.match(j.note, /not emulated machines|no CPU address space/i);
  assert.match(j.note, /WASM exports|linear memory/i, "say what to do instead");
  assert.match(j.reads, /ERRORS/, "and that reads error rather than returning empty");
});

test("an emulated host is completely unaffected", async () => {
  // The SMS path was already right; this fix must not touch it.
  const { z } = await import("zod");
  const { registerMemoryTools } = await import("../src/mcp/tools/memory.js");
  const { _setHostForTest } = await import("../src/mcp/state.js");
  const key = "emulated-ok";
  _setHostForTest(key, emulatedHost());
  let handler;
  registerMemoryTools({ tool(n, _d, _s, h) { if (n === "memory") handler = h; } }, z, key);

  const res = await handler({ op: "read", region: "system_ram", offset: 0, length: 8 });
  assert.notEqual(res.isError, true, "a real emulated host still reads");
  const j = JSON.parse(res.content.find((c) => c.type === "text").text);
  assert.equal(j.length, 8);
});
