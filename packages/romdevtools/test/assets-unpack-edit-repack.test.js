// Item 8 of the black-box audit: "the public schema exposes no repack action ...
// This is useful format identification, not the requested unpack/edit/repack
// byte-exact round trip."
//
// The encoder alone did not close that. A caller could see a SHA of the decoded
// payload and never obtain the BYTES, so there was nothing to edit and nothing
// to hand back. What follows drives the loop the audit asked for, and the
// schema-shape test exists because the first version of the handler was written
// against a parameter (`outputPath`) that the tool did not declare -- the module
// worked and every public call returned HTTP 400.
import { test } from "node:test";
import assert from "node:assert/strict";
import { encodeMio0, decodeMio0Container } from "../src/decomp/assets.js";
import { readFile } from "node:fs/promises";

const payload = (n) => {
  // Compressible, but not trivially so: runs an RLE-ish encoder handles plus
  // incompressible noise. A payload of all zeroes proves nothing.
  const b = Buffer.alloc(n);
  for (let i = 0; i < n; i++) b[i] = i % 97 < 40 ? 0xAA : (i * 2654435761) & 0xff;
  return b;
};

test("unpack -> repack reproduces the payload byte for byte", () => {
  for (const n of [1, 2, 17, 255, 256, 4096, 65537]) {
    const src = payload(n);
    const container = encodeMio0(src);
    const back = decodeMio0Container(container);
    assert.ok(back, `n=${n}: the container we just built did not decode`);
    assert.equal(Buffer.compare(Buffer.from(back), src), 0, `n=${n}: payload not byte-identical`);
  }
});

test("unpack -> EDIT -> repack yields the EDITED payload, not the original", () => {
  const src = payload(8192);
  const edited = Buffer.from(src);
  edited[0] ^= 0xff;
  edited[edited.length >> 1] ^= 0x5a;
  edited[edited.length - 1] ^= 0x0f;

  const back = Buffer.from(decodeMio0Container(encodeMio0(edited)));
  assert.equal(Buffer.compare(back, edited), 0, "repack did not reproduce the edited payload");
  // The control that must fail: if this passed, the test would be asserting
  // nothing -- an encoder that ignored its input would satisfy the line above
  // only if the edit never reached the container.
  assert.notEqual(Buffer.compare(back, src), 0, "the edit did not survive into the container");
});

test("the assets unpack/repack actions are reachable through the declared schema", async () => {
  const srcText = await readFile(new URL("../src/mcp/tools/decomp.js", import.meta.url), "utf8");
  // Both must be in the action enum...
  for (const a of ["unpack", "repack"]) {
    assert.ok(new RegExp(`"${a}"`).test(srcText), `action '${a}' missing from the enum`);
  }
  // ...AND named in action's own description, because the per-op scope checker
  // reads that description to decide whether `action` applies to op:'assets'.
  // Omitting it made the checker refuse romdev's own new action.
  const desc = srcText.match(/"op:'job' — status \(default\)[\s\S]*?\)\;/)?.[0] ?? "";
  assert.match(desc, /op:'assets'/, "action's description does not list op:'assets' — the scope checker will refuse it");
  assert.match(desc, /op:'artifacts' — status \(default\), prune, restore/, "artifacts restore missing from the description");
  // outputPath must be declared, or every unpack call is a 400.
  assert.match(srcText, /outputPath: z\.string\(\)/, "outputPath is used by the handler but not declared");
});
