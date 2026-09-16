// Client report 2026-09-16 (optional ask): "For a banked cart, `pc` alone does
// not identify an instruction: $8000 in bank 3 and $8000 in bank 7 are
// different code. My whole block identity is (bank, addr)." They were reading
// $FFFC-$FFFF in a SEPARATE call that is not synchronized to the traced
// instruction -- so the bank they read may not be the bank that executed.
//
// These pin the shape and, more importantly, the refusal: an unbanked cart
// leaves the slot registers at power-on RAM values, and reporting 0xF0 as
// "bank 240" would be a confident wrong answer.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const src = () => readFile(new URL("../src/mcp/tools/watch-memory.js", import.meta.url), "utf8");

test("the mapper is read PER STEP, not once for the run", async () => {
  // A bank switch mid-trace is exactly what a caller chasing a mapper bug
  // needs to see; hoisting the read out of the loop would hide it.
  const s = await src();
  const loop = s.match(/const trace = \[\];[\s\S]*?trace\.push\(entry\);/)?.[0] ?? "";
  assert.match(loop, /readMapper\(\)/, "readMapper must be called inside the per-step loop");
});

test("an uninitialised mapper is flagged, not reported as a bank", async () => {
  const s = await src();
  assert.match(s, /uninitialised: true/);
  assert.match(s, /power-on RAM bytes, not bank selections/i);
  // And the bank must be withheld in that case.
  assert.match(s, /const bank = m\.uninitialised \? null : bankForPc\(pc, m\)/,
    "a bank must not be derived from uninitialised registers");
});

test("plausibility is checked against the ROM's actual bank count", async () => {
  // 0xF0 is not a bank on a 2-bank ROM. Without the bank count there is no way
  // to tell an uninitialised byte from a real selection.
  const s = await src();
  assert.match(s, /romBankCount = Math\.ceil\(raw\.length \/ 0x4000\)/);
  assert.match(s, /banks == null \|\| v < banks/);
});

test("the slot a PC maps to follows the Sega window layout", async () => {
  const s = await src();
  const fn = s.match(/const bankForPc = \(pc, m\) => \{[\s\S]*?\n  \};/)?.[0] ?? "";
  assert.ok(fn, "no bankForPc");
  assert.match(fn, /pc < 0x4000.*return 0/s, "slot 0 is fixed");
  assert.match(fn, /pc < 0x8000.*slot1/s);
  assert.match(fn, /pc < 0xc000.*slot2/s);
  assert.match(fn, /return null;\s*\/\/ RAM/, "RAM is not banked ROM and must not claim a bank");
});

test("blockId is the (bank, addr) identity the client asked for", async () => {
  const s = await src();
  assert.match(s, /entry\.blockId = `\$\{bank\}:\$\{entry\.pc\}`/);
});

test("only banked platforms pay for this", async () => {
  // A per-step extra memory read on every platform would be a tax on cores
  // that have no mapper to report.
  const s = await src();
  assert.match(s, /const BANKED = \{ sms: true, gg: true \}/);
  assert.match(s, /if \(BANKED\[plat\]\) \{/);
});
