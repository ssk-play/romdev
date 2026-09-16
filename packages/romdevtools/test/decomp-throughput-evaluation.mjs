// Explicit opt-in benchmark, not a normal unit test or a new public tool.
// Reads the game checkout; writes only disposable saved-owner/workspace copies.
import { mkdtemp, readFile, writeFile, readdir } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import assert from "node:assert/strict";
import { Project } from "../src/decomp/project.js";
import { compileAndCompare } from "../src/decomp/compile.js";
import { fileIdentities, hashRecord, atomicJson, measurementSnapshot } from "../src/decomp/measurement.js";
import { metricsOf, runVariantBatch } from "../src/decomp/variants.js";

if (process.env.ROMDEV_DECOMP_INTEGRATION !== "1") throw new Error("set ROMDEV_DECOMP_INTEGRATION=1 to spend this real-compiler budget");
const original = await Project.open("wr64-us-rev1");
const root = await mkdtemp(path.join(os.tmpdir(), "romdev-throughput-evaluation-"));
const research = path.join(original.root, "docs/research/parallel-candidates");
const cases = [
  { id: "allocation", symbol: "func_8004EAA4", candidate: path.join(original.ws, "candidates/func_8004EAA4/3d47c0df671e0c1fca69-947be21c958209e6-v2.c"),
    find: "extern s32 D_80192494;\nextern s32 D_800D4724;", replace: "extern s32 D_800D4724;\nextern s32 D_80192494;" },
  { id: "scheduling", symbol: "func_i3_802C5800", segment: "ovl_i3", candidate: path.join(research, "i3-init5800-299/candidate.c"),
    originalOwner: path.join(original.ws, "patches/func_i3_802C5800.2026-09-16T00-11-57-395Z.orig.c"),
    find: "courseId=D_801CB334; difficulty=gDifficulty;", replace: "difficulty=gDifficulty; courseId=D_801CB334;" },
  { id: "frame", symbol: "func_i15_802C5800", segment: "ovl_i15", candidate: path.join(research, "i15-init5800-305/candidate.c"),
    find: "Mtx_t projectionFixed, viewFixed;", replace: "Mtx_t viewFixed, projectionFixed;" },
  { id: "structural", symbol: "func_1B1FB0_802C6C1C", segment: "segment_1B1FB0", candidate: path.join(research, "func_1B1FB0_802C6C1C.one-difference.c.txt"),
    alternative: path.join(research, "func_1B1FB0_802C6C1C.blez-correct-5diff.c.txt") },
  { id: "stale-history", symbol: "func_i1_802C59E8", segment: "ovl_i1",
    candidate: path.join(original.ws, "candidates/func_i1_802C59E8/4db49b3c594af5f46535-7820d41df54669e9-v2.c") },
  // Held out from implementation/fixture design before this evaluation. Other
  // agents have historical drafts; this is NOT an untouched-by-anyone target.
  { id: "held-out", symbol: "func_8004DAF0", heldOut: true },
];
async function historicalCandidate(symbol, best) {
  const dir = path.join(original.ws, "candidates", symbol);
  const records = [];
  for (const name of (await readdir(dir)).sort().filter(n => n.endsWith(".result.json"))) {
    const r = JSON.parse(await readFile(path.join(dir, name), "utf8"));
    const candidate = path.join(dir, name.replace(/\.result\.json$/, ".c"));
    if (!r.compileSucceeded || !await readFile(candidate).then(() => true, () => false)) continue;
    records.push({ candidate, result: path.join(dir, name), linked: r.romLinked?.mismatches ?? Infinity });
  }
  if (best) records.sort((a, b) => a.linked - b.linked || a.candidate.localeCompare(b.candidate));
  assert.ok(records.length, `missing historical ${symbol}`);
  return records[0];
}
for (const c of cases) {
  c.fn = await original.resolveFunction(c);
  if (!c.candidate) { c.historical = await historicalCandidate(c.symbol, c.id === "stale-history"); c.candidate = c.historical.candidate; }
  const baseline = await readFile(c.candidate, "utf8");
  c.ownerPath = path.join(root, `${c.id}-owner.c`);
  await writeFile(c.ownerPath, await readFile(c.originalOwner ?? original.abs(c.fn.source.tu)));
  let edit = c.alternative ? await readFile(c.alternative, "utf8") : null;
  if (c.find) { assert.equal(baseline.split(c.find).length, 2); edit = baseline.replace(c.find, c.replace); }
  if (!edit) {
    // Control for candidates where no source mechanism was prespecified.
    // Do not manufacture a supposedly useful edit after seeing either arm.
    edit = `/* second negative control; not a recovery hypothesis */\n${baseline}`;
  }
  c.inputs = [baseline, `${baseline}\n/* benchmark negative control */\n`, edit];
  c.inputHashes = c.inputs.map(hashRecord);
  c.ownerIdentity = (await fileIdentities([c.ownerPath]))[0];
}
await atomicJson(path.join(root, "preregistered-cases.json"), cases);
console.log(JSON.stringify({ root, cases: cases.map(c => ({ id: c.id, state: c.fn.source.state, historical: c.historical })) }));
const records = [];
const rounds = 4;
for (let round = 0; round < rounds; round++) {
  for (const width of round % 2 ? [2, 1] : [1, 2]) {
    const p = await Project.open(original.id);
    Object.defineProperty(p, "ws", { value: await mkdtemp(path.join(root, `r${round}-w${width}-`)) });
    for (const c of cases) {
      const start = performance.now();
      const rows = [];
      const one = async ({ candidateText: source, label }) => {
        const index = label === "baseline" ? 0 : Number(label.split(":")[1]);
        const start = performance.now();
        try {
          const r = await compileAndCompare(p, c.fn, { candidateText: source, ownerPath: c.ownerPath, noCache: true, label: `input-${index}` });
          rows[index] = { index, wallMs: performance.now() - start, compileMs: r.compileMs, input: r.inputIdentity,
            snapshot: measurementSnapshot(r), metrics: metricsOf(r), output: r.outputIdentity, artifacts: r.artifacts,
            diagnostics: r.diagnostics, cacheHit: r.cacheHit };
          return r;
        } catch (e) { rows[index] = { index, wallMs: performance.now() - start, error: String(e.stack) }; throw e; }
      };
      // Same budget/order: baseline first, then two prespecified candidates.
      const batch = await runVariantBatch(p, c.fn, { baselineText: c.inputs[0], ownerPath: c.ownerPath,
        variants: c.inputs.slice(1).map((candidateText, i) => ({ id: String(i + 1), candidateText })), compare: one, threads: width });
      const wallMs = performance.now() - start;
      const hitStart = performance.now();
      const hit = await compileAndCompare(p, c.fn, { candidateText: c.inputs[0], ownerPath: c.ownerPath });
      records.push({ round, width, id: c.id, workspace: p.ws, wallMs, rows, batch,
        cacheProbe: { wallMs: performance.now() - hitStart, hit: hit.cacheHit, output: hit.outputIdentity } });
      console.log(JSON.stringify({ round, width, id: c.id, wallMs: Math.round(wallMs), rows: rows.map(r => ({ error: r.error, linked: r.metrics?.linkedMismatches, valid: r.snapshot?.validity })) }));
      await atomicJson(path.join(root, "results.json"), records);
    }
  }
}
const comparisons = [];
for (let round = 0; round < rounds; round++) for (const c of cases) {
  const a = records.find(r => r.round === round && r.id === c.id && r.width === 1);
  const b = records.find(r => r.round === round && r.id === c.id && r.width === 2);
  const projection = r => r.rows.map(x => ({ input: x.input?.sha256, snapshot: x.snapshot, output: x.output, metrics: x.metrics, error: x.error }));
  comparisons.push({ round, id: c.id, equivalent: hashRecord(projection(a)) === hashRecord(projection(b)), serialMs: a.wallMs, parallelMs: b.wallMs });
}
const totals = [1, 2].map(width => ({ width, batches: records.filter(r => r.width === width).length,
  wallMs: records.filter(r => r.width === width).reduce((n, r) => n + r.wallMs, 0),
  compileWallSumMs: records.filter(r => r.width === width).flatMap(r => r.rows).reduce((n, r) => n + (r.compileMs ?? 0), 0) }));
const summary = { root, at: new Date().toISOString(), rounds, comparisons, totals,
  budgetPerArm: `${rounds} rounds × ${cases.length} targets × 3 uncached inputs, plus one cache probe per target/round`,
  integrations: 0, recoveredBytes: 0, fullRomVerification: "not-run: no integration/source writes",
  limitations: ["fixed-workload compiler microbenchmark, not an agent or integration-rate experiment", "separate empty workspaces, same saved owners and source inputs; OS/tool-binary page cache is shared", "alternating arm order reduces but does not eliminate system-load bias", "child compiler CPU time unavailable; compileMs measures wall time", "held-out function had previous-agent drafts; held out only from this implementation's development", "historical score is an attributed claim until these fresh compiles"] };
await atomicJson(path.join(root, "summary.json"), summary);
console.log(JSON.stringify({ summary: path.join(root, "summary.json"), totals, allEquivalent: comparisons.every(c => c.equivalent) }));
