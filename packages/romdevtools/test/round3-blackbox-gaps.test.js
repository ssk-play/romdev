// Round-3 and black-box audit defects.
//
// THE LESSON THESE SHARE. Every one of these shipped because the module was
// tested in-process and the PUBLIC SCHEMA was never driven. A handler that
// works is not a feature if the validator rejects the call before it runs, or
// if the op reads a path the caller cannot produce. "Implemented" has to mean
// reachable through the same door the client uses.

import { test } from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";

import { makeScopeChecker } from "../src/mcp/util.js";
import { encodeMio0, decodeMio0Container, roundTrip } from "../src/decomp/assets.js";
import { makeWorkClassifier } from "../src/decomp/work-class.js";

// ── the action enum covered only ONE op's vocabulary ───────────────────────

test("the decomp `action` enum covers every op that has actions", async () => {
  // `action` was declared TWICE and the second (job-only) declaration
  // overwrote the first, so scenario/experiment/skill/artifacts actions were
  // rejected by the validator BEFORE their handlers ran. `artifacts
  // action:'status'` appeared to work only because 'status' is a job action.
  const { registerDecompTools } = await import("../src/mcp/tools/decomp.js");
  let shape = null;
  registerDecompTools({ tool(n, _d, s) { if (n === "decomp") shape = s; } }, z, "k");
  assert.ok(shape?.action, "decomp declares an `action` parameter");
  const values = shape.action._def?.innerType?._def?.entries ?? shape.action._def?.entries
    ?? shape.action.options ?? [];
  const list = Array.isArray(values) ? values : Object.values(values ?? {});
  for (const needed of ["status", "best", "cancel", "report",     // job
                        "create", "control", "conclude", "list",  // experiment
                        "save", "run",                            // scenario
                        "preview", "write",                       // skill
                        "prune"]) {                               // artifacts
    assert.ok(list.includes(needed), `action must accept '${needed}' (got: ${list.join(", ")})`);
  }
});

// ── per-op validation must reach every tool, and only real scopes ──────────

test("per-op scope is read from FOUR description spellings, not two", async () => {
  // `op=step/stepAndShot:` and `target=rom:` were matched; `op:'readCart' —`
  // and `target:'decompile' —` were not. That is why the check fired on
  // disasm/frame and silently did nothing on memory/playtest.
  const shape = {
    op: z.enum(["read", "readCart"]).describe("what to do"),
    findHex: z.string().optional().describe("op:'readCart' — byte-pattern SCAN over the loaded cart image."),
    offsets: z.array(z.number()).optional().describe("op=read: batch offsets."),
  };
  const check = makeScopeChecker(shape, "memory");
  assert.ok(check, "a colon-and-em-dash description must still yield a checker");
  assert.match(check({ op: "read", findHex: "dead" }), /'findHex' does not apply to op:'read'/);
  assert.equal(check({ op: "readCart", findHex: "dead" }), null);
  assert.match(check({ op: "readCart", offsets: [0] }), /'offsets' does not apply/);
});

test("a scope marker that is an ASIDE in prose is not treated as a whitelist", async () => {
  // `project` reads "Required by every op except list. op:'import' picks it."
  // — the marker names one special case, and reading it as the complete scope
  // rejected `project` on every decomp op.
  const shape = {
    op: z.enum(["import", "compare"]).describe("what to do"),
    project: z.string().optional().describe("Project id (required by every op except list). op:'import' picks it."),
  };
  const check = makeScopeChecker(shape, "decomp");
  assert.equal(check, null, "no parameter here declares a leading scope, so there is nothing to enforce");
});

test("the shared-parameter exemption is PER TOOL, not global", async () => {
  // `path` on disasm is under-documented (required by targets its text never
  // names), so enforcing it rejects valid calls. On playtest the same NAME
  // means one specific thing, and passing it to op:'open' really is a drop.
  const dis = makeScopeChecker({
    target: z.enum(["rom", "recompile"]).describe("what"),
    path: z.string().optional().describe("target=rom: ROM file path."),
    address: z.number().optional().describe("target=rom: address."),
  }, "disasm");
  assert.equal(dis({ target: "recompile", path: "/x" }), null, "disasm `path` is exempt");

  const pt = makeScopeChecker({
    op: z.enum(["open", "framebuffer"]).describe("what"),
    path: z.string().optional().describe("op:framebuffer — absolute path to write the PNG to."),
  }, "playtest");
  assert.match(pt({ op: "open", path: "/tmp/x.png" }), /'path' does not apply to op:'open'/);
  assert.equal(pt({ op: "framebuffer", path: "/tmp/x.png" }), null);
});

// ── libultra objects live under an asm/ tree ───────────────────────────────

test("a libultra object built from an asm/ tree is LIBRARY, not handwritten", async () => {
  // Real projects build libultra as `build/asm/us/rev1/libultra/exceptasm.o`.
  // Testing the asm/ prefix FIRST swallowed all 27 SDK functions into
  // handwritten-asm-retain and emptied the known-source lane the policy text
  // says to search first — while the ledger counted them as library, so the
  // two disagreed.
  const splat = { segments: [{ name: "m", subsegments: [{ name: "entrypoint", type: "hasm" }] }] };
  const classify = makeWorkClassifier(splat, { splat: { buildPath: "build", srcPath: "src" } });
  assert.equal(classify("build/asm/us/rev1/libultra/exceptasm.o"), "libultra-known-source");
  assert.equal(classify("build/asm/us/rev1/entrypoint.o"), "handwritten-asm-retain",
    "a non-libultra asm/ object is still handwritten");
  assert.equal(classify("build/src/game/main.o"), "game-matching-c");
});

// ── the MIO0 encoder reproduces the reference's choices ────────────────────

test("MIO0 encode -> decode reproduces the payload for every input shape", () => {
  for (const [name, data] of [
    ["zeros", Buffer.alloc(2048)],
    ["runs", Buffer.from("A".repeat(2000))],
    ["repeats", Buffer.from("abcabc".repeat(300))],
    ["literals", Buffer.from(Array.from({ length: 1024 }, (_, i) => (i * 2654435761) & 0xff))],
    ["mixed", Buffer.concat([Buffer.alloc(32), Buffer.from("xyz".repeat(100)), Buffer.from([1, 2, 3])])],
    ["tiny", Buffer.from([7])],
  ]) {
    const enc = encodeMio0(data);
    const dec = decodeMio0Container(enc);
    assert.ok(dec, `${name}: encoded container must decode`);
    assert.equal(Buffer.compare(Buffer.from(dec), data), 0, `${name}: payload must survive`);
  }
});

test("MIO0 re-encode of our own container is BYTE-IDENTICAL", () => {
  // The encoder matches the reference's choices: first byte literal, lazy
  // lookahead (longest+1 < lookahead), oldest-match-wins tie-breaking, and a
  // 4-byte-aligned layout section. Any of those wrong and the container
  // differs while still decoding correctly — which is why the round trip, not
  // the decode, is the acceptance test.
  const payload = Buffer.concat([
    Buffer.alloc(48), Buffer.from("hello world ".repeat(20)),
    Buffer.from(Array.from({ length: 64 }, (_, i) => i & 0xff)),
  ]);
  const container = encodeMio0(payload);
  const r = roundTrip(container, { name: "synthetic" });
  assert.equal(r.payloadExact, true);
  assert.equal(r.containerExact, true, r.why);
  assert.equal(r.state, "round-trip-tool");
});

test("a range with zero padding after the container is still byte-exact", () => {
  // A segment is padded to alignment AFTER the stream ends. Comparing raw
  // lengths reported a false mismatch on a repack that is byte-identical.
  const container = encodeMio0(Buffer.from("padded".repeat(50)));
  const padded = Buffer.concat([container, Buffer.alloc(3)]);
  const r = roundTrip(padded, { name: "padded" });
  assert.equal(r.containerExact, true, "trailing zero padding is outside the container");
  assert.equal(r.trailingPadBytes, 3);
});

test("a range whose trailing bytes are NOT zero is not called byte-exact", () => {
  // The padding exemption must not become a blanket "ignore the tail".
  const container = encodeMio0(Buffer.from("data".repeat(50)));
  const dirty = Buffer.concat([container, Buffer.from([1, 2, 3])]);
  const r = roundTrip(dirty, { name: "dirty" });
  assert.equal(r.containerExact, false, "non-zero trailing bytes are real content, not padding");
});

// ── no tool may declare the same parameter twice ───────────────────────────

test("no tool schema declares a parameter twice", async () => {
  // A duplicate key in an object literal keeps the LAST one, silently. That is
  // how `action` lost four ops' vocabularies (the job-only enum overwrote the
  // full one, making five operations unreachable through the public schema),
  // how `apply` lost its artifacts scope, and how `maxFunctions` had its
  // dispatch ceiling narrowed from 512 to 64. The bug is invisible in review
  // and invisible at runtime — the only reliable catch is reading the source.
  const { readFile, readdir } = await import("node:fs/promises");
  const path = await import("node:path");
  const { fileURLToPath } = await import("node:url");
  const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "src", "mcp", "tools");

  const offenders = [];
  for (const f of await readdir(dir)) {
    if (!f.endsWith(".js")) continue;
    const text = await readFile(path.join(dir, f), "utf8");
    // A file may register SEVERAL tools, in which case a repeat is legitimate.
    const toolCount = (text.match(/server\.tool\(/g) ?? []).length;
    if (toolCount > 1) continue;
    // Scan only from the server.tool( call onward: a helper that builds a
    // NESTED shape (input.js's per-port button object) legitimately reuses the
    // same key names at the same indentation, and counting those is a false
    // positive that makes the guard unrunnable.
    const at = text.indexOf("server.tool(");
    if (at < 0) continue;
    const keys = [...text.slice(at).matchAll(/^ {6}([A-Za-z][A-Za-z0-9]*): z\./gm)].map((m) => m[1]);
    const seen = new Set(), dupes = new Set();
    for (const k of keys) { if (seen.has(k)) dupes.add(k); seen.add(k); }
    if (dupes.size) offenders.push(`${f}: ${[...dupes].join(", ")}`);
  }
  assert.deepEqual(offenders, [],
    `a single-tool file declared a parameter more than once — the later declaration silently wins:\n${offenders.join("\n")}`);
});

// ── overlapping observations become a REAL union ───────────────────────────

test("two incompatible types at one offset emit a compilable union", async () => {
  // The audit's item 7 had TWO clauses: valid C tokens, and "overlapping
  // observations as a compilable union representation rather than ordinary
  // sequential fields". Emitting one arbitrary winner with a /* CONFLICT */
  // comment answered only the first half.
  const { proposeStruct } = await import("../src/decomp/type-graph.js");
  const base = {
    base: "t", fieldCount: 1, functionCount: 2,
    fields: [{ offset: 0, width: 4, type: "f32", conflict: true, unionView: ["4:f32", "4:s32/u32/ptr"] }],
  };
  const { code, unions } = proposeStruct(base);
  assert.equal(unions, 1, "a same-offset type conflict is a union");
  assert.match(code, /union \{/);
  assert.match(code, /f32 as_f32;/);
  assert.match(code, /u32 as_u32;/);
  assert.match(code, /incompatible views/);
});

test("a field whose extent CROSSES the next offset is a union, not a sibling", async () => {
  // This is the half that is a real layout bug, not just lost information:
  // emitting overlapping fields sequentially pushes every following offset
  // along by bytes that were never there, so the struct stops describing the
  // evidence at all.
  const { proposeStruct } = await import("../src/decomp/type-graph.js");
  const base = {
    base: "t", fieldCount: 2, functionCount: 1,
    fields: [
      { offset: 0, width: 4, type: "u32" },
      { offset: 2, width: 2, type: "u16" },   // sits INSIDE the 4-byte field
    ],
  };
  const { code, unions } = proposeStruct(base);
  assert.equal(unions, 1, "overlapping extents are one location, not two fields");
  assert.match(code, /at \+0x2/, "the sub-offset must be recorded");
  // The next honest offset is 4, not 6 — the overlap must not shift the layout.
  assert.match(code, /size >= 0x4/);
});

test("non-overlapping fields are still plain fields", async () => {
  const { proposeStruct } = await import("../src/decomp/type-graph.js");
  const { code, unions } = proposeStruct({
    base: "t", fieldCount: 2, functionCount: 1,
    fields: [{ offset: 0, width: 4, type: "u32" }, { offset: 4, width: 4, type: "f32" }],
  });
  assert.equal(unions, 0, "adjacent fields are not a union");
  assert.match(code, /u32 unk_0;/);
  assert.match(code, /f32 unk_4;/);
});
