// Report 2026-09-15 §4.5: func_1B1FB0_802C5800 has a 932-byte/233-word target,
// but a 1,212-byte candidate reported `romLinked.romWords: 303` and a
// different `romBytesSha1` -- the linked read extended to CANDIDATE length, so
// the field names claimed the original boundary while describing a region that
// includes the following function.
//
// Acceptance: "short, equal-sized and long candidates retain the same original
// target length/hash. A long candidate cannot silently redefine the target to
// include following code."
//
// compareAgainstRom is module-private and needs a real ROM + linker map, so
// the behaviour is pinned here at the source level; the live HTTP proof is in
// the response (233 words / sha1 48a0c47b for BOTH a 2-word and a 2896-word
// candidate).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const src = async () => readFile(new URL("../src/decomp/compile.js", import.meta.url), "utf8");

test("the ROM slice is taken at the TARGET's size, never max(candidate, target)", async () => {
  const s = await src();
  assert.ok(!/romSlice\(fn\.romOffset,\s*Math\.max\(/.test(s),
    "the ROM read still widens to the candidate's length");
  assert.match(s, /const targetBytes = fn\.sizeBytes \?\? size;/);
  assert.match(s, /romSlice\(fn\.romOffset,\s*targetBytes\)/,
    "the target region must be fixed at the declared function size");
});

test("overflow bytes are reported separately and excluded from the target", async () => {
  const s = await src();
  const block = s.match(/if \(size > targetBytes\) \{[\s\S]*?\n  \}/)?.[0] ?? "";
  assert.ok(block, "no overflow branch");
  assert.match(block, /romSlice\(fn\.romOffset \+ targetBytes/,
    "overflow context must start AFTER the function, not re-read it");
  assert.match(block, /NOT part of the target's extent/i);
});

test("the response carries an explicit immutable target extent", async () => {
  const s = await src();
  assert.match(s, /target: \{ bytes: targetBytes, words: romWords\.length, romOffset: fn\.romOffsetHex, sha1: rom\.sha1 \}/,
    "romLinked must state the original extent independently of candidate size");
});

test("a size difference is reported as its own fact, not folded into mismatches", async () => {
  const s = await src();
  assert.match(s, /const sizeDelta = linked\.stream\.length - romWords\.length;/);
  assert.match(s, /POSITIONAL/, "the mismatch count must be labelled positional when sizes differ");
  assert.match(s, /upper bound/, "a positional count over shifted words is an upper bound; say so");
});
