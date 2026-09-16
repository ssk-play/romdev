// Report 2026-09-15 §4.1: "one operation-specific schema shared by validator,
// dispatcher, documentation and skill generation. Do not infer parameter
// applicability from prose descriptions."
//
// Inferring from prose refused a call the handler REQUIRES, twice in one week:
// `action` on op:'assets', and `candidatePath` on op:'gate' -- whose handler
// calls candidateSource() and cannot run without it. These tests pin the
// declarative contract and prove it stays anchored to reality.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const srcOf = (f) => readFile(new URL(`../src/mcp/tools/${f}`, import.meta.url), "utf8");

test("every op named in DECLARED_SCOPE is a real op in the tool's enum", async () => {
  const util = await readFile(new URL("../src/mcp/util.js", import.meta.url), "utf8");
  const block = util.match(/const DECLARED_SCOPE = \{[\s\S]*?\n  \};/)?.[0];
  assert.ok(block, "DECLARED_SCOPE not found");

  const decomp = await srcOf("decomp.js");
  const enumBlock = decomp.match(/op: z\.enum\(\[([\s\S]*?)\]\)/)?.[1];
  assert.ok(enumBlock, "decomp op enum not found");
  const realOps = new Set([...enumBlock.matchAll(/"([a-zA-Z]+)"/g)].map((m) => m[1]));

  const entries = [...block.matchAll(/(\w+): \[([^\]]+)\]/g)];
  assert.ok(entries.length >= 6, "expected the decomp entries to be present");
  for (const [, param, list] of entries) {
    for (const op of [...list.matchAll(/"([a-zA-Z]+)"/g)].map((m) => m[1])) {
      assert.ok(realOps.has(op),
        `DECLARED_SCOPE names op:'${op}' for '${param}', which is not in the op enum`);
    }
  }
});

test("a handler that reads a parameter has that parameter in scope for its op", async () => {
  // The gate handler calls candidateSource(), so both candidate forms must be
  // declared for op:'gate' or the validator rejects the call before it runs.
  const decomp = await srcOf("decomp.js");
  const gate = decomp.match(/case "gate": \{[\s\S]*?\n        \}/)?.[0] ?? "";
  assert.match(gate, /candidateSource\(\)/, "gate no longer reads a candidate; update this test");

  const util = await readFile(new URL("../src/mcp/util.js", import.meta.url), "utf8");
  const block = util.match(/const DECLARED_SCOPE = \{[\s\S]*?\n  \};/)?.[0] ?? "";
  for (const p of ["candidatePath", "candidateText"]) {
    const line = block.match(new RegExp(`${p}: \\[([^\\]]+)\\]`))?.[1] ?? "";
    assert.match(line, /"gate"/, `${p} must be in scope for op:'gate' -- the handler requires it`);
  }
});

test("the description text agrees with the declared scope", async () => {
  // Docs and skill generation read the description; the validator reads the
  // map. If they disagree, one of them is lying to a caller.
  const decomp = await srcOf("decomp.js");
  for (const p of ["candidatePath", "candidateText"]) {
    const desc = decomp.match(new RegExp(`${p}: z\\.string\\(\\)\\.optional\\(\\)\\.describe\\("([^"]+)"`))?.[1] ?? "";
    assert.match(desc, /'gate'/, `${p}'s description does not mention gate, but the contract allows it`);
  }
});
