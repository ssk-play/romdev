// experiment.js — a campaign experiment as a durable, falsifiable record.
//
// THE PROBLEM THIS SOLVES. One function in a real campaign accumulated 264 candidate
// files. The directory records what was BUILT; it records nothing about why —
// which hypothesis was under test, which single lever was varied, which source
// families were already exhausted, or whether a later agent is about to repeat
// a dead one. That knowledge lived in prose, in a handoff that grew by
// prepending hundreds of narrative entries, which is why the campaign kept
// paying to rediscover its own dead ends.
//
// An experiment here is a record with the shape of a real experiment:
//
//   ONE causal hypothesis, stated before the run and falsifiable.
//   The single source LEVER being varied (varying two proves nothing).
//   Baseline identities: source, object, target, toolchain.
//   REQUIRED controls — positive, negative and determinism. A run whose
//     negative control also "passes" has measured nothing, and the record says
//     so instead of reporting a win.
//   Per-candidate results with the semantic gate's verdict alongside exactness.
//   A conclusion: accepted / rejected / exhausted, with the scope it covers.
//
// Records live in the workspace beside the candidates, never in the checkout.
//
// Plain JS ESM + JSDoc.

import fs from "node:fs";
import path from "node:path";
import { mkdir, readFile, readdir, open, unlink } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { atomicJson, hashRecord } from "./measurement.js";

export const EXPERIMENT_SCHEMA = "romdev-decomp-experiment-v1";

const dir = (project) => path.join(project.ws, "experiments");
const fileFor = (project, id) => {
  if (!/^[a-zA-Z0-9_.-]+$/.test(id)) throw new Error("invalid experiment id");
  return path.join(dir(project), `${id}.json`);
};

// Atomic replacement prevents torn JSON, but does not serialize read/modify/
// write. A workspace lock protects updates across requests AND processes.
// Never steal a possibly live lock: a crashed writer leaves an explicit,
// inspectable lock and bounded error, rather than silently losing evidence.
async function withExperimentLock(project, id, update) {
  await mkdir(dir(project), { recursive: true });
  const lockPath = `${fileFor(project, id)}.lock`;
  const deadline = Date.now() + 10_000;
  let lock;
  while (!lock) {
    try { lock = await open(lockPath, "wx"); }
    catch (e) {
      if (e.code !== "EEXIST") throw e;
      if (Date.now() >= deadline) throw Object.assign(new Error(`experiment update is locked: ${lockPath}. Inspect its owner; recover a crashed writer's lock only after confirming it is no longer running.`), { code: "EXPERIMENT_LOCKED" });
      await new Promise(resolve => setTimeout(resolve, 20));
    }
  }
  try {
    await lock.writeFile(JSON.stringify({ pid: process.pid, at: new Date().toISOString() }));
    return await update();
  } finally { await lock.close(); await unlink(lockPath); }
}

/** Control kinds an experiment must declare. */
export const CONTROL_KINDS = Object.freeze({
  positive: "a change that MUST move the metric. If it does not, the harness is not measuring what you think.",
  negative: "a change that MUST NOT move the metric. If it does, the metric is responding to noise and any 'win' is meaningless.",
  determinism: "the SAME input run twice. If the two disagree, nothing measured in this experiment can be trusted.",
});

/**
 * Open a new experiment.
 *
 * @param {import("./project.js").Project} project
 * @param {{symbol:string, hypothesis:string, lever:string, family?:string, baseline?:object, parentId?:string|null, notes?:string}} a
 */
export async function createExperiment(project, { symbol, hypothesis, lever, family, baseline, parentId = null, notes }) {
  if (!symbol) throw Object.assign(new Error("experiment: `symbol` is required"), { code: "BAD_ARGS" });
  if (!hypothesis) throw Object.assign(new Error("experiment: a `hypothesis` is required — an experiment without a falsifiable claim is just a sweep, and a sweep is what produced 264 undifferentiated candidates."), { code: "BAD_ARGS" });
  if (!lever) throw Object.assign(new Error("experiment: a single `lever` is required — varying more than one source change at a time cannot attribute the result."), { code: "BAD_ARGS" });

  await mkdir(dir(project), { recursive: true });
  const id = `exp-${symbol}-${randomUUID()}`;
  const rec = {
    schema: EXPERIMENT_SCHEMA, id, project: project.id, symbol,
    hypothesis, lever, family: family ?? null, parentId,
    baseline: baseline ?? null,
    createdAt: new Date().toISOString(),
    status: "open",
    controls: { positive: null, negative: null, determinism: null },
    candidates: [],
    conclusion: null,
    ...(notes ? { notes } : {}),
  };
  await atomicJson(fileFor(project, id), rec);
  return rec;
}

export async function loadExperiment(project, id) {
  const p = fileFor(project, id);
  if (!fs.existsSync(p)) throw Object.assign(new Error(`experiment '${id}' not found`), { code: "NO_SUCH_EXPERIMENT" });
  return JSON.parse(await readFile(p, "utf8"));
}

async function save(project, rec) {
  rec.updatedAt = new Date().toISOString();
  await atomicJson(fileFor(project, rec.id), rec);
  return rec;
}

/** Record a control outcome. `moved` is whether the metric actually moved. */
export const recordControl = (project, id, args) => withExperimentLock(project, id, () => recordControlLocked(project, id, args));
async function recordControlLocked(project, id, { kind, moved, detail, metricBefore, metricAfter }) {
  if (!CONTROL_KINDS[kind]) throw Object.assign(new Error(`experiment control kind must be one of: ${Object.keys(CONTROL_KINDS).join(", ")}`), { code: "BAD_ARGS" });
  const rec = await loadExperiment(project, id);
  // A control PASSES when it behaves the way its definition requires.
  const passed = kind === "positive" ? moved === true
    : kind === "negative" ? moved === false
    : moved === false; // determinism: two identical runs must not differ
  rec.controls[kind] = {
    kind, moved: !!moved, passed, detail: detail ?? null,
    metricBefore: metricBefore ?? null, metricAfter: metricAfter ?? null,
    requirement: CONTROL_KINDS[kind], at: new Date().toISOString(),
  };
  return await save(project, rec);
}

/** Attach a candidate result (with its semantic-gate verdict) to the record. */
export const recordCandidate = (project, id, args) => withExperimentLock(project, id, () => recordCandidateLocked(project, id, args));
async function recordCandidateLocked(project, id, { candidatePath, candidateSha, distance, exactFunctionMatch, functionLocal, gate, dependencyHash, note }) {
  const rec = await loadExperiment(project, id);
  rec.candidates.push({
    candidatePath: candidatePath ?? null, candidateSha: candidateSha ?? null,
    distance: distance ?? null,
    exactFunctionMatch: !!exactFunctionMatch, functionLocal: functionLocal ?? null,
    // Exactness and source quality stay SEPARATE fields, never merged.
    gateClassification: gate?.classification ?? null,
    gateFindings: gate?.counts ?? null,
    integrationEligible: gate?.integrationEligible ?? null,
    dependencyHash: dependencyHash ?? null,
    at: new Date().toISOString(),
    ...(note ? { note } : {}),
  });
  return await save(project, rec);
}

/**
 * Close an experiment.
 *
 * A conclusion is REFUSED while a required control is missing or failing —
 * that is the whole point of declaring them. "The metric improved" means
 * nothing if the negative control also improved.
 */
export const concludeExperiment = (project, id, args) => withExperimentLock(project, id, () => concludeExperimentLocked(project, id, args));
async function concludeExperimentLocked(project, id, { verdict, scope, rationale, force = false }) {
  const VERDICTS = ["accepted", "rejected", "exhausted"];
  if (!VERDICTS.includes(verdict)) throw Object.assign(new Error(`experiment verdict must be one of: ${VERDICTS.join(", ")}`), { code: "BAD_ARGS" });
  const rec = await loadExperiment(project, id);

  const missing = Object.entries(rec.controls).filter(([, v]) => v == null).map(([k]) => k);
  const failed = Object.entries(rec.controls).filter(([, v]) => v && !v.passed).map(([k]) => k);
  if ((missing.length || failed.length) && !force) {
    throw Object.assign(new Error(
      `experiment '${id}' cannot conclude: `
      + (missing.length ? `controls not run: ${missing.join(", ")}. ` : "")
      + (failed.length ? `controls FAILED: ${failed.join(", ")}. ` : "")
      + "A conclusion drawn without its controls is not evidence — a negative control that moves means the metric is responding to noise, "
      + "and a determinism control that differs means nothing in this run is reproducible. "
      + "Run them, or pass force:true to record the conclusion WITH its unverified status attached."),
      { code: "CONTROLS_INCOMPLETE", missing, failed });
  }

  rec.status = "closed";
  rec.conclusion = {
    verdict, scope: scope ?? null, rationale: rationale ?? null,
    at: new Date().toISOString(),
    controlsVerified: !missing.length && !failed.length,
    ...(missing.length ? { controlsNotRun: missing } : {}),
    ...(failed.length ? { controlsFailed: failed } : {}),
    ...((missing.length || failed.length) ? { caveat: "this conclusion was FORCED past incomplete controls and must not be cited as a verified result" } : {}),
    bestCandidate: rec.candidates.filter((c) => c.distance != null).sort((a, b) => a.distance - b.distance)[0] ?? null,
  };
  return await save(project, rec);
}

/** Every experiment for a project, newest first; optionally one symbol. */
export async function listExperiments(project, { symbol, includeClosed = true } = {}) {
  const d = dir(project);
  if (!fs.existsSync(d)) return [];
  const out = [];
  for (const f of await readdir(d)) {
    if (!f.endsWith(".json")) continue;
    try {
      const r = JSON.parse(await readFile(path.join(d, f), "utf8"));
      if (symbol && r.symbol !== symbol) continue;
      if (!includeClosed && r.status === "closed") continue;
      out.push(r);
    } catch {}
  }
  return out.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
}

/**
 * Which source families have already been tried for a symbol, and how they
 * ended — the question "am I about to repeat a dead end?" that the candidate
 * directory could not answer.
 */
export async function exhaustedFamilies(project, symbol) {
  const all = await listExperiments(project, { symbol });
  const byFamily = new Map();
  for (const e of all) {
    const key = e.family ?? e.lever ?? "(unnamed)";
    const g = byFamily.get(key) ?? { family: key, experiments: 0, rejected: 0, exhausted: 0, accepted: 0, open: 0, bestDistance: null, hypotheses: [] };
    g.experiments++;
    if (e.status !== "closed") g.open++;
    else if (["accepted", "rejected", "exhausted"].includes(e.conclusion?.verdict) && e.conclusion.controlsVerified) g[e.conclusion.verdict]++;
    for (const c of e.candidates) if (c.distance != null && (g.bestDistance == null || c.distance < g.bestDistance)) g.bestDistance = c.distance;
    if (e.hypothesis && g.hypotheses.length < 5) g.hypotheses.push(e.hypothesis);
    byFamily.set(key, g);
  }
  const families = [...byFamily.values()];
  return {
    symbol, families,
    deadFamilies: families.filter((f) => f.open === 0 && f.accepted === 0 && (f.rejected + f.exhausted) > 0).map((f) => f.family),
    note: "Family summaries are historical. Only controlled conclusions are counted; none establishes that every source arrangement is exhausted. Review exact tested input scope and refresh against current dependencies before reusing a conclusion.",
  };
}

/** Persist measured variants through the existing experiment store. Observations
 * are not controlled causal proofs and cannot exhaust an entire lever/family. */
export async function recordVariantExperiment(project, batch, { hypothesis, lever, family } = {}) {
  const base = batch.rows[0];
  const tested = batch.rows.slice(1).filter(r => !r.duplicateOf);
  const scope = { symbol: batch.function.symbol, segment: batch.function.segment,
    baselineInput: base.inputIdentity?.sha256 ?? null, baselineOutput: base.outputIdentity,
    snapshot: base.snapshot };
  // Filenames, labels, ordering, prose and repetition do not create independent evidence.
  const identity = hashRecord({ scope, snapshotStable: batch.snapshotStable,
    tested: tested.map(r => ({ input: r.inputIdentity?.sha256 ?? r.sourceSha,
    output: r.outputIdentity ?? null, snapshot: r.snapshot ?? null })).sort((a, b) => String(a.input).localeCompare(String(b.input))) });
  const id = `observed-${identity}`;
  return withExperimentLock(project, id, async () => {
  try { const prior = await loadExperiment(project, id); return { id, path: fileFor(project, id), duplicate: true, conclusion: prior.conclusion }; }
  catch (e) { if (e.code !== "NO_SUCH_EXPERIMENT") throw e; }
  const candidates = tested.map(r => {
    const valid = batch.snapshotStable === true && r.snapshot?.validity === "valid" && r.metrics?.compiled;
    const movement = [r.delta?.strict, r.delta?.linked].filter(Number.isFinite);
    const outcome = !valid ? "invalid-measurement" : !movement.length ? "inconclusive"
      : movement.some(n => n < 0) && !movement.some(n => n > 0) ? "improved"
      : movement.some(n => n > 0) && !movement.some(n => n < 0) ? "regressed"
      : movement.every(n => n === 0) ? "tested-unchanged" : "inconclusive";
    return { ...r, lever: r.lever ?? lever ?? null, outcome };
  });
  const rec = { schema: EXPERIMENT_SCHEMA, kind: "measured-variant-observation", id, project: project.id,
    symbol: scope.symbol, segment: scope.segment, scope, hypothesis: hypothesis ?? null, lever: lever ?? null, family: family ?? null,
    baseline: base, candidates, status: "observed", createdAt: new Date().toISOString(),
    elapsedMs: batch.elapsedMs, controls: { positive: null, negative: null, determinism: null },
    conclusion: { verdict: "observed", controlsVerified: false,
      scope: "Only the listed source inputs under this baseline and dependency/compiler/reference identity. No family-wide exhaustion or causal proof.",
      outcomes: candidates.map(c => ({ input: c.inputIdentity?.sha256 ?? c.sourceSha, lever: c.lever, outcome: c.outcome })) } };
  await atomicJson(fileFor(project, id), rec);
  return { id, path: fileFor(project, id), duplicate: false, conclusion: rec.conclusion };
  });
}

/** Attach narrowly scoped prior measurements beside each proposed lever. */
export function annotateExperimentHistory(diagnosis, records, { symbol, segment, baselineInput, baselineOutput, snapshot } = {}) {
  const relevant = records.filter(r => r.kind === "measured-variant-observation" && r.symbol === symbol && (r.segment ?? null) === (segment ?? null));
  for (const group of diagnosis.groups) for (const experiment of group.experiments) {
    const prior = [];
    for (const r of relevant) {
      const sameSnapshot = snapshot && snapshot.validity === "valid" && hashRecord(r.scope.snapshot) === hashRecord(snapshot);
      const sameBaseline = r.scope.baselineInput === baselineInput && baselineInput != null
        && r.scope.baselineOutput?.sha256 === baselineOutput?.sha256 && baselineOutput?.sha256 != null;
      for (const c of r.candidates.filter(c => c.lever === experiment.id)) prior.push({ experimentId: r.id,
        input: c.inputIdentity?.sha256 ?? c.sourceSha, outcome: c.outcome,
        freshness: sameSnapshot && sameBaseline ? "current-baseline" : "historical-needs-refresh",
        scope: "these exact tested inputs only", hypothesis: c.hypothesis ?? r.hypothesis });
    }
    experiment.priorOutcomes = prior;
    experiment.historyState = prior.some(p => p.freshness === "current-baseline") ? "previously-tested-inputs-exist"
      : prior.length ? "historical-tests-need-refresh" : "untried-in-recorded-history";
    if (prior.length) experiment.nextDecision = "Inspect the recorded inputs; choose a genuinely different edit or new compiler/type evidence. A tested permutation does not exhaust this lever.";
  }
  return diagnosis;
}

/** A temporary queue penalty, never an exhaustion verdict. Only independent
 * current-baseline measured batches count. Novel levers bypass it explicitly. */
export function experimentCooldown(records, { symbol, segment, baselineInput, snapshot, threshold = 3,
  durationMs = 3_600_000, now = Date.now(), ignore = false, proposedLever } = {}) {
  const history = records.filter(r => r.kind === "measured-variant-observation" && r.symbol === symbol
    && (r.segment ?? null) === (segment ?? null));
  const sameTree = history.filter(r => snapshot?.validity === "valid" && snapshot.ownerMode === "live"
    && hashRecord(r.scope.snapshot) === hashRecord(snapshot));
  const campaignBaseline = baselineInput ?? [...sameTree].sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))[0]?.scope.baselineInput;
  const current = sameTree.filter(r => campaignBaseline && r.scope.baselineInput === campaignBaseline);
  const valid = [...new Map(current.map(r => [r.id, r])).values()]
    .filter(r => r.candidates.length && r.candidates.every(c => ["tested-unchanged", "regressed", "improved"].includes(c.outcome)))
    .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
  const noProgress = [];
  for (const r of valid) { if (r.candidates.some(c => c.outcome === "improved")) break; noProgress.push(r); }
  const levers = [...new Set(current.flatMap(r => r.candidates.map(c => c.lever)).filter(Boolean))];
  const novelLever = proposedLever && !levers.includes(proposedLever);
  const until = noProgress.length ? Date.parse(noProgress[0].createdAt) + durationMs : null;
  const active = !ignore && !novelLever && noProgress.length >= threshold && until > now;
  return { active, factor: active ? 0.1 : 1, baselineInput: campaignBaseline ?? null, independentNoProgressBatches: noProgress.length,
    threshold, until: until ? new Date(until).toISOString() : null, testedLevers: levers,
    reason: ignore ? "caller override: cooldown disabled" : novelLever ? "new proposed lever: reconsider target"
      : active ? "repeated current-baseline batches made no residual improvement; temporarily prefer other work"
      : history.length && !current.length ? "dependency/baseline identity changed or unavailable: refresh previous outcomes; unrelated edits do not prove failed levers promising"
      : "no active cooldown",
    scope: "Temporary scheduling advice for recorded inputs only, not proof that a target or lever is exhausted" };
}
