// Client ask (2026-09-16): a game copies routines out of ROM into RAM and jumps
// there, executing 100% of some frames from RAM. A static recompiler with no
// interpreter can compile those ranges a second time at their RAM addresses —
// but only if it knows which ROM range each came from, and a byte scan on the
// client's side cannot find the copy site (the destination arrives in a
// register or through a shared memcpy: cross-bank dataflow).
//
// The dataflow turns out not to be needed. The RAM bytes are VERBATIM ROM, so
// "which ROM offset did these bytes come from" is answered by searching the ROM
// for the bytes. What the tool must NOT do is pick one candidate silently:
// measured on a 256KB cart, ~13% of 32-byte ranges match more than one offset.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const src = () => readFile(new URL("../src/mcp/tools/memory.js", import.meta.url), "utf8");

test("provenance returns ALL candidates and never picks one", async () => {
  const s = await src();
  const fn = s.match(/async function memProvenance\([\s\S]*?\n\}/)?.[0] ?? "";
  assert.ok(fn, "memProvenance not found");
  assert.match(fn, /candidates\.push/, "it must collect candidates, not a single hit");
  assert.match(fn, /does NOT choose between them/i,
    "with several candidates the tool must say it is not choosing");
  assert.match(fn, /not proof of a copy/i,
    "a single hit is a lead, not proof: identical bytes can occur once by coincidence");
});

test("a too-short query is refused rather than answered ambiguously", async () => {
  const s = await src();
  const fn = s.match(/async function memProvenance\([\s\S]*?\n\}/)?.[0] ?? "";
  assert.match(fn, /below minLength/, "short queries must be refused");
  assert.match(fn, /ambiguous about half the time/,
    "the refusal should say WHY, with the measured rate");
});

test("a uniform byte run is not searched at all", async () => {
  // Zero-fill or $FF padding matches thousands of ROM offsets; any "origin"
  // reported for it would be noise dressed as evidence.
  const s = await src();
  const fn = s.match(/async function memProvenance\([\s\S]*?\n\}/)?.[0] ?? "";
  assert.match(fn, /const uniform = needle\.every/);
  assert.match(fn, /no search was run/i);
});

test("the verbatim run is measured past the query, and its cap is disclosed", async () => {
  // A fixed-length query is the wrong shape alone: the caller cannot know the
  // copied run's length. Measured on a real cart, one routine was verbatim for
  // 9 bytes and diverged, so a 20-byte query returned NOTHING while an 8-byte
  // query resolved uniquely — an empty result that is easy to misread as "not
  // from ROM at all".
  const s = await src();
  const fn = s.match(/async function memProvenance\([\s\S]*?\n\}/)?.[0] ?? "";
  assert.match(fn, /c\.verbatimBytes = n;/);
  assert.match(fn, /divergesAt/, "where the copy stops must be reported");
  assert.match(fn, /verbatimAtLeast/, "a capped run must not read as a final length");
  assert.match(fn, /LOWER BOUND/, "the cap note must say the number is a lower bound");
});

test("extending past the region end does not fail the query", async () => {
  // extendBy:4096 on an 8KB region read out of bounds and threw, turning "look
  // further" into "the query fails" — and near the end of a region that is
  // every query.
  const s = await src();
  const fn = s.match(/async function memProvenance\([\s\S]*?\n\}/)?.[0] ?? "";
  assert.match(fn, /CLAMPED to what the region/i);
  assert.match(fn, /region-end/, "hitting the region end must be distinguishable from hitting extendBy");
});

test("the policy refuses the claims this cannot support", async () => {
  const s = await src();
  const fn = s.match(/async function memProvenance\([\s\S]*?\n\}/)?.[0] ?? "";
  assert.match(fn, /does NOT prove a copy happened/i);
  assert.match(fn, /does not identify the copying instruction/i);
  assert.match(fn, /no claim about reachability/i,
    "reachability decisions stay the caller's, as they asked");
});

test("provenance is registered as an op and documented", async () => {
  const s = await src();
  assert.match(s, /"searchNext", "provenance"/, "the op must be in the enum");
  assert.match(s, /case "provenance": return await memProvenance/, "the op must be dispatched");
  assert.match(s, /provenance=which ROM offset holds bytes identical to a RAM range/,
    "the op list description must cover it");
});
