// Report 2026-09-15 §6: "Several queue entries with no recorded attempts
// already had extensive local drafts and experiments. Some newer research
// notes themselves said 'never attempted' while much better older drafts
// existed."
//
// Acceptance: "importing the research folder surfaces the older
// number-renderer near-match and does not describe the target as never
// attempted. A stale one-difference result is labeled stale until refreshed.
// A note claiming exactness cannot override a failed build or differing ROM
// bytes."
import { test } from "node:test";
import assert from "node:assert/strict";
import { extractClaims, definedFunctions, bySymbol, conflicts, leadsFor, scanResearch } from "../src/decomp/research.js";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

test("a 'never attempted' claim is recorded as a CLAIM, never a fact", () => {
  const claims = extractClaims("This function was never attempted in the current tree.");
  const c = claims.find((x) => x.kind === "never-attempted");
  assert.ok(c, "the claim that causes rework must be detected");
  assert.equal(c.confidence, "claim-only");
});

test("an exactness claim in a note is also only a claim", () => {
  const c = extractClaims("The draft is byte-exact against the target.").find((x) => x.kind === "claims-exact");
  assert.ok(c);
  assert.equal(c.confidence, "claim-only",
    "a note claiming exactness must never be recorded as a verified result");
});

test("a draft is attributed to functions it DEFINES, not ones it merely calls", () => {
  const src = "void func_CALLER(void) { func_CALLEE(1); }\nvoid func_REAL(s32 a) { return; }";
  const defined = definedFunctions(src);
  assert.ok(defined.includes("func_CALLER"));
  assert.ok(defined.includes("func_REAL"));
  assert.ok(!defined.includes("func_CALLEE"), "a called function is not implemented by this draft");
});

test("a 'never attempted' note contradicted by drafts is reported as a conflict", () => {
  const index = { entries: [
    { kind: "note", path: "/r/NEW/README.md", symbols: ["func_X"], claims: extractClaims("func_X was never attempted.") },
    { kind: "draft", path: "/r/OLD/x.c", symbols: ["func_X"], definedFunctions: ["func_X"], bytes: 548 },
  ] };
  const cs = conflicts(bySymbol(index));
  assert.equal(cs.length, 1);
  assert.equal(cs[0].kind, "never-attempted-contradicted");
  assert.match(cs[0].why, /recency does not settle this/i,
    "the newer note was the wrong one in the motivating case; recency must not decide");
});

test("a draft with no current measurement is needs-refresh, never verified", () => {
  const index = { entries: [
    { kind: "draft", path: "/r/x.c", symbols: ["func_X"], definedFunctions: ["func_X"], bytes: 548 },
    { kind: "note", path: "/r/n.md", symbols: ["func_X"], claims: extractClaims("548 bytes, one strict/linked mismatch.") },
  ] };
  const leads = leadsFor(bySymbol(index), { measuredSymbols: new Set() });
  const lead = leads.find((l) => l.symbol === "func_X");
  assert.equal(lead.state, "needs-refresh");
  assert.equal(lead.claimedBestDistance, 1, "the claimed distance orders refresh work");
  assert.match(lead.policy, /NEVER a verified result/i);
});

test("a symbol with a current measurement is marked history, not a refresh target", () => {
  const index = { entries: [{ kind: "draft", path: "/r/x.c", symbols: ["func_X"], definedFunctions: ["func_X"], bytes: 548 }] };
  const lead = leadsFor(bySymbol(index), { measuredSymbols: new Set(["func_X"]) })[0];
  assert.equal(lead.state, "has-current-measurement");
  assert.match(lead.stateReason, /do not override it/i,
    "imported research must not outrank a current-tree measurement");
});

test("a truncated scan says so rather than looking complete", async () => {
  // A silent cap is worse than no cap: the index looks whole and the missing
  // files are exactly the older research this feature exists to surface.
  const dir = await mkdtemp(path.join(tmpdir(), "romdev-research-"));
  await mkdir(path.join(dir, "sub"), { recursive: true });
  for (let i = 0; i < 8; i++) await writeFile(path.join(dir, "sub", `f${i}.c`), `void func_F${i}(void) {}`);
  const full = await scanResearch(dir);
  assert.equal(full.truncated, false);
  assert.equal(full.entries.length, 8);
  const capped = await scanResearch(dir, { maxFiles: 3 });
  assert.equal(capped.truncated, true, "hitting the cap must be reported");
  assert.match(capped.truncatedNote, /INCOMPLETE/);
});
