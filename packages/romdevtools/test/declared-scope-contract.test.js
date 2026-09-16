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
  // The op list lives in one exported constant so the schema and the
  // skill-staleness check cannot drift apart.
  const enumBlock = decomp.match(/export const DECOMP_OPS = Object\.freeze\(\[([\s\S]*?)\]\)/)?.[1];
  assert.ok(enumBlock, "DECOMP_OPS not found");
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

test("EVERY op whose handler reads a candidate has it in declared scope", async () => {
  // The narrow version of this test checked only op:'gate' and passed while
  // op:'variants' was refused at the validator -- the same defect, one op
  // over. Derive the list from the dispatch instead of naming ops by hand.
  const decomp = await srcOf("decomp.js");
  const util = await readFile(new URL("../src/mcp/util.js", import.meta.url), "utf8");
  const block = util.match(/const DECLARED_SCOPE = \{[\s\S]*?\n  \};/)?.[0] ?? "";
  const scopeOf = (p) => (block.match(new RegExp(`${p}: \\[([^\\]]+)\\]`))?.[1] ?? "");

  // Every `case "<op>": { ... }` body that calls candidateSource().
  const needs = [];
  for (const m of decomp.matchAll(/case "(\w+)": \{([\s\S]*?)\n        \}/g)) {
    if (/candidateSource\(\)/.test(m[2])) needs.push(m[1]);
  }
  assert.ok(needs.length >= 4, `expected several ops to read a candidate, found ${needs.join(", ")}`);
  for (const op of needs) {
    for (const p of ["candidatePath", "candidateText"]) {
      assert.match(scopeOf(p), new RegExp(`"${op}"`),
        `op:'${op}' reads a candidate via candidateSource() but '${p}' is not in its declared scope -- the validator will refuse the call before the handler runs`);
    }
  }
});

test("no op reads an args.* field that its declared scope forbids", async () => {
  // The broadest version of the same defect: a handler reads args.noCache /
  // args.declarations / args.verifyTu, but the parameter's declared scope
  // names only the op it was first written for, so the validator refuses the
  // call. Checking candidateSource() alone missed three of these.
  const decomp = await srcOf("decomp.js");
  const util = await readFile(new URL("../src/mcp/util.js", import.meta.url), "utf8");
  const block = util.match(/const DECLARED_SCOPE = \{[\s\S]*?\n  \};/)?.[0] ?? "";
  const declared = new Map();
  for (const m of block.matchAll(/(\w+): \[([^\]]+)\]/g)) {
    declared.set(m[1], new Set([...m[2].matchAll(/"(\w+)"/g)].map((x) => x[1])));
  }

  const problems = [];
  for (const m of decomp.matchAll(/case "(\w+)": \{([\s\S]*?)\n        \}/g)) {
    const [, op, body] = m;
    for (const u of body.matchAll(/\bargs\.(\w+)/g)) {
      const param = u[1];
      const scope = declared.get(param);
      if (scope && !scope.has(op)) problems.push(`op:'${op}' reads args.${param}, declared only for ${[...scope].join("/")}`);
    }
  }
  assert.deepEqual(problems, [],
    `a handler reads a parameter the validator refuses for that op:\n  ${problems.join("\n  ")}`);
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
