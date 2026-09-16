// Maintainer-only mechanical data regeneration, not an agent/API tool.
// node scripts/generate-z80-cycle-tables.mjs [core/z80/z80.c] [--write]
// Default: verify; --write: replace generated numeric tables after core review.
import { readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import assert from "node:assert/strict";

const source = process.argv.slice(2).find(a => a !== "--write") ?? "build/gpgx/src/core/z80/z80.c";
const output = new URL("../src/analysis/recompile/z80-cycle-tables.json", import.meta.url);
const raw = await readFile(source, "utf8"), clean = raw.replace(/\/\*[\s\S]*?\*\//g, "");
const tables = {};
for (const name of ["op", "cb", "ed", "xy", "xycb", "ex"]) {
  const match = new RegExp(`static const UINT16 cc_${name}\\[0x100\\]\\s*=\\s*\\{([^}]+)\\}`).exec(clean);
  assert.ok(match, `missing cc_${name}; review changed core format`);
  const terms = match[1].split(",").map(s => s.trim()).filter(Boolean);
  assert.equal(terms.length, 256, `cc_${name} length`);
  tables[name] = terms.map(term => {
    const value = /^(\d+)\s*\*\s*15$/.exec(term);
    assert.ok(value, `unexpected cc_${name} term: ${term}; do not silently reinterpret units`);
    return Number(value[1]);
  });
}
const generated = { source: "Genesis Plus GX core/z80/z80.c cc_* tables, bundled romdev build",
  sourceSha256: createHash("sha256").update(raw).digest("hex"),
  unit: "Z80 T-states (core master-clock factors / 15)", tables };
if (process.argv.includes("--write")) await writeFile(output, JSON.stringify(generated, null, 2) + "\n");
else assert.deepEqual(JSON.parse(await readFile(output, "utf8")), generated, "core changed: review then regenerate with --write");
console.log(`${process.argv.includes("--write") ? "Generated" : "Verified"} six 256-entry tables; source SHA256 ${generated.sourceSha256}`);
