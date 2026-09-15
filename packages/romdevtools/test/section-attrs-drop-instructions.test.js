// `.section .text, "ax"` parsed as section name `.text,` (comma included), so
// every instruction in such a file was silently discarded. `resolve` then
// reported a REAL symbol with sizeBytes 0, and `knownSource` fingerprinted an
// empty body and returned `siblingHits: []` -- which reads exactly like an
// honest "searched, found nothing".
//
// This is the audit's recurring class: not an error, a confident wrong answer.
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseSplatAsm } from "../src/decomp/splat-map.js";

const BODY = `
/* Handwritten function */
nonmatching bcopy, 0x304

glabel bcopy
    /* 86280 800CBA80 10C0001A */  beqz       $a2, .L800CBAEC
    /* 86284 800CBA84 00A03825 */   or        $a3, $a1, $zero
    /* 86288 800CBA88 10850018 */  beq        $a0, $a1, .L800CBAEC
`;

test("a .section with attributes still parses as .text", () => {
  const withAttrs = `.section .text, "ax"\n${BODY}`;
  const r = parseSplatAsm(withAttrs);
  assert.equal(r.name, "bcopy");
  assert.equal(r.instructions.length, 3, "instructions were dropped by the attribute form");
  assert.equal(r.sizeBytes, 12);
});

test("the bare .section form parses identically", () => {
  const bare = `.section .text\n${BODY}`;
  const withAttrs = `.section .text, "ax"\n${BODY}`;
  assert.deepEqual(
    parseSplatAsm(bare).instructions.map((i) => i.word),
    parseSplatAsm(withAttrs).instructions.map((i) => i.word),
    "the two spellings of the same directive disagree",
  );
});

test("other sections keep their names and stay out of .text", () => {
  const r = parseSplatAsm(`.section .rodata, "a"\ndlabel D_800A\n${BODY}`);
  // The rodata symbol is recorded against .rodata, not .rodata,
  assert.ok(r.rodataSymbols.some((s) => s.section === ".rodata"),
    `rodata symbol carried section ${JSON.stringify(r.rodataSymbols[0]?.section)}`);
});
