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
import { mkdir, readFile, writeFile, readdir } from "node:fs/promises";

export const EXPERIMENT_SCHEMA = "romdev-decomp-experiment-v1";

const dir = (project) => path.join(project.ws, "experiments");
const fileFor = (project, id) => path.join(dir(project), `${id}.json`);

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
  const id = `exp-${symbol}-${Date.now().toString(36)}`;
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
  await writeFile(fileFor(project, id), JSON.stringify(rec, null, 2));
  return rec;
}

export async function loadExperiment(project, id) {
  const p = fileFor(project, id);
  if (!fs.existsSync(p)) throw Object.assign(new Error(`experiment '${id}' not found`), { code: "NO_SUCH_EXPERIMENT" });
  return JSON.parse(await readFile(p, "utf8"));
}

async function save(project, rec) {
  rec.updatedAt = new Date().toISOString();
  await writeFile(fileFor(project, rec.id), JSON.stringify(rec, null, 2));
  return rec;
}

/** Record a control outcome. `moved` is whether the metric actually moved. */
export async function recordControl(project, id, { kind, moved, detail, metricBefore, metricAfter }) {
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
export async function recordCandidate(project, id, { candidatePath, candidateSha, distance, exactFunctionMatch, functionLocal, gate, dependencyHash, note }) {
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
export async function concludeExperiment(project, id, { verdict, scope, rationale, force = false }) {
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
    else if (e.conclusion?.verdict) g[e.conclusion.verdict]++;
    for (const c of e.candidates) if (c.distance != null && (g.bestDistance == null || c.distance < g.bestDistance)) g.bestDistance = c.distance;
    if (e.hypothesis && g.hypotheses.length < 5) g.hypotheses.push(e.hypothesis);
    byFamily.set(key, g);
  }
  const families = [...byFamily.values()];
  return {
    symbol, families,
    deadFamilies: families.filter((f) => f.open === 0 && f.accepted === 0 && (f.rejected + f.exhausted) > 0).map((f) => f.family),
    note: "a family with no open experiments, no acceptance, and at least one rejected/exhausted conclusion has already been paid for — "
      + "re-running it costs budget and produces the same answer.",
  };
}
