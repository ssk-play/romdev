// scenario.js - replayable gameplay evidence, kept apart from byte matching.
//
// A boot smoke test answers "does it start". It cannot answer "does the rebuilt
// ROM behave like the base one once the game is actually running", and it tells
// you nothing about WHICH remaining functions a run exercised.
//
// A scenario is: a base state, an input script on absolute frames, checkpoints,
// an expected overlay sequence, and optional memory/framebuffer assertions.
// Run it against the base ROM and the rebuilt ROM and compare.
//
// THE LINE THIS FILE WILL NOT CROSS. Runtime agreement is SEMANTIC evidence, not
// byte matching. Two ROMs can play identically for a thousand frames and differ
// in bytes; a candidate can be byte-exact and still break a scenario through its
// collateral. Reporting one as the other is the confusion this whole domain
// exists to avoid, so every result here is labelled `semantic` and never
// contributes to an exactness verdict.
//
// Coverage from a scenario is only as exact as the core's PC logging. When the
// capability probe says coverage is a frame-boundary sample, the report says so
// and refuses to call a sampled hit "executed".
//
// Plain JS ESM + JSDoc.

import fs from "node:fs";
import path from "node:path";
import { readFile, writeFile, mkdir, readdir } from "node:fs/promises";
import { createHash } from "node:crypto";

export const SCENARIO_SCHEMA = "romdev-decomp-scenario-v1";

const dir = (project) => path.join(project.ws, "scenarios");

/**
 * Save a scenario definition.
 * @param {{name:string, description?:string, fromState?:string|null, inputs:Array<{frame:number,buttons:string[],until?:number,holdFrames?:number,port?:number}>, checkpoints?:Array<{frame:number,note?:string,regions?:Array<{region:string,offset:number,length:number}>}>, expectedOverlays?:string[], frames:number}} def
 */
export async function saveScenario(project, def) {
  if (!def?.name) throw Object.assign(new Error("scenario: `name` is required"), { code: "BAD_ARGS" });
  if (!Number.isFinite(def.frames) || def.frames <= 0) throw Object.assign(new Error("scenario: `frames` (how long to run) is required"), { code: "BAD_ARGS" });
  await mkdir(dir(project), { recursive: true });
  const rec = {
    schema: SCENARIO_SCHEMA, name: def.name, description: def.description ?? null,
    fromState: def.fromState ?? null,
    // Inputs are an ABSOLUTE frame schedule, so two runs of one scenario hold
    // the same buttons on the same frames. A relative schedule drifts, and a
    // one-frame drift is a different frame of animation.
    inputs: def.inputs ?? [], frames: def.frames,
    checkpoints: def.checkpoints ?? [],
    expectedOverlays: def.expectedOverlays ?? [],
    createdAt: new Date().toISOString(),
  };
  await writeFile(path.join(dir(project), `${def.name}.json`), JSON.stringify(rec, null, 2));
  return rec;
}

export async function listScenarios(project) {
  const d = dir(project);
  if (!fs.existsSync(d)) return [];
  const out = [];
  for (const f of await readdir(d)) {
    if (f.endsWith(".json")) { try { out.push(JSON.parse(await readFile(path.join(d, f), "utf8"))); } catch {} }
  }
  return out;
}

export async function loadScenario(project, name) {
  const f = path.join(dir(project), `${name}.json`);
  if (!fs.existsSync(f)) throw Object.assign(new Error(`scenario '${name}' not found`), { code: "NO_SUCH_SCENARIO" });
  return JSON.parse(await readFile(f, "utf8"));
}

const sha = (b) => createHash("sha256").update(b).digest("hex").slice(0, 16);

/**
 * Run one scenario against a loaded host, collecting checkpoint evidence.
 *
 * @param {object} host a loaded emulator host
 * @param {object} scenario
 * @param {{capability?:object}} [opts]
 */
export async function runScenario(host, scenario, { capability } = {}) {
  if (!host) throw Object.assign(new Error("runScenario: no host - loadMedia first"), { code: "NO_HOST" });
  const startFrame = host.status?.frameCount ?? 0;
  const windows = [];
  for (const e of scenario.inputs ?? []) {
    const from = e.frame ?? 0;
    const to = e.until != null ? e.until : from + (e.holdFrames ?? 1);
    windows.push({ from, to, port: e.port ?? 0, buttons: Array.isArray(e.buttons) ? e.buttons : (e.button ? [e.button] : []) });
  }
  const checkpointAt = new Map();
  for (const c of scenario.checkpoints ?? []) checkpointAt.set(c.frame, c);

  const observations = [];
  const framebufferHashes = [];
  for (let f = startFrame; f < startFrame + scenario.frames; f++) {
    const ports = [{}, {}];
    for (const w of windows) {
      if (f - startFrame < w.from || f - startFrame >= w.to) continue;
      for (const b of w.buttons) ports[w.port][b] = true;
    }
    try { host.setInput({ ports }); } catch {}
    host.stepFrames(1);

    const rel = f - startFrame + 1;
    const cp = checkpointAt.get(rel);
    if (cp) {
      const obs = { frame: rel, note: cp.note ?? null, regions: [] };
      for (const r of cp.regions ?? []) {
        try {
          const bytes = host.readMemory(r.region, r.offset ?? 0, r.length ?? 16);
          obs.regions.push({ region: r.region, offset: r.offset ?? 0, length: r.length ?? 16, sha: sha(Buffer.from(bytes)) });
        } catch (e) { obs.regions.push({ region: r.region, error: String(e?.message ?? e).slice(0, 120) }); }
      }
      try { obs.framebufferHash = host.framebufferHash?.() ?? null; } catch {}
      observations.push(obs);
    }
    if (rel % Math.max(1, Math.floor(scenario.frames / 8)) === 0) {
      try { framebufferHashes.push({ frame: rel, hash: host.framebufferHash?.() ?? null }); } catch {}
    }
  }

  const coverageExact = capability?.capabilities?.pcCoverage?.state === "proven";
  return {
    scenario: scenario.name, framesRun: scenario.frames,
    observations, framebufferHashes,
    coverage: {
      exact: coverageExact,
      // A frame-boundary sample is NOT proof a block executed. Saying so is the
      // difference between coverage evidence and a coverage-shaped guess.
      note: coverageExact
        ? "the core's PC bitmap was available: executed PCs are exact"
        : "exact PC coverage is NOT available on this core, so nothing here may be reported as 'executed' - a frame-boundary sample only shows what was observed at a sample point",
    },
    kind: "semantic",
    policy: "SEMANTIC evidence only. Runtime agreement is not byte matching: two ROMs can play identically and differ in bytes, and a "
      + "byte-exact candidate can still break a scenario through its collateral. This result never contributes to an exactness verdict.",
  };
}

/**
 * Compare two scenario runs (base vs rebuilt).
 * Divergence is reported with the FIRST frame it appears at - the last frame
 * they agreed is what a bisect needs.
 */
export function compareRuns(baseRun, rebuiltRun) {
  const diffs = [];
  const n = Math.max(baseRun.observations.length, rebuiltRun.observations.length);
  for (let i = 0; i < n; i++) {
    const a = baseRun.observations[i], b = rebuiltRun.observations[i];
    if (!a || !b) { diffs.push({ index: i, kind: "missing-checkpoint", base: !!a, rebuilt: !!b }); continue; }
    if (a.frame !== b.frame) { diffs.push({ index: i, kind: "frame-mismatch", baseFrame: a.frame, rebuiltFrame: b.frame }); continue; }
    for (let r = 0; r < Math.max(a.regions.length, b.regions.length); r++) {
      const ra = a.regions[r], rb = b.regions[r];
      if (!ra || !rb) continue;
      if (ra.sha !== rb.sha) diffs.push({ frame: a.frame, kind: "region-diverged", region: ra.region, offset: ra.offset, baseSha: ra.sha, rebuiltSha: rb.sha });
    }
    if (a.framebufferHash && b.framebufferHash && a.framebufferHash !== b.framebufferHash) {
      diffs.push({ frame: a.frame, kind: "framebuffer-diverged", base: a.framebufferHash, rebuilt: b.framebufferHash });
    }
  }
  const firstDiverged = diffs.find((d) => d.frame != null)?.frame ?? null;
  return {
    agreed: diffs.length === 0,
    divergences: diffs.slice(0, 40), divergenceCount: diffs.length,
    firstDivergedFrame: firstDiverged,
    lastAgreedFrame: firstDiverged == null ? (baseRun.observations.at(-1)?.frame ?? null)
      : (baseRun.observations.filter((o) => o.frame < firstDiverged).at(-1)?.frame ?? null),
    kind: "semantic",
    note: diffs.length === 0
      ? "the two runs agreed at every checkpoint. That is SEMANTIC agreement over this scenario only - it is not a byte-identity claim, and another scenario may still diverge."
      : "divergence is semantic: the rebuilt ROM behaved differently. Start from `lastAgreedFrame` to bisect.",
  };
}

/**
 * Which remaining functions a scenario exercised, so the planner can prefer
 * work whose behaviour is checkable.
 */
export function coverageGuidedQueue({ remaining, executedPCs, symbolRanges, coverageExact }) {
  const covered = [], uncovered = [];
  const hit = new Set(executedPCs ?? []);
  for (const fn of remaining) {
    const range = symbolRanges?.[fn.symbol];
    let touched = false;
    if (range && hit.size) {
      for (const pc of hit) { if (pc >= range.start && pc < range.end) { touched = true; break; } }
    }
    (touched ? covered : uncovered).push(fn);
  }
  return {
    coveredByScenario: covered.sort((a, b) => (b.sizeBytes ?? 0) - (a.sizeBytes ?? 0)),
    notObserved: uncovered.sort((a, b) => (b.sizeBytes ?? 0) - (a.sizeBytes ?? 0)),
    coverageExact: !!coverageExact,
    guidance: coverageExact
      ? "Functions in `coveredByScenario` can have their behaviour checked against the base ROM after integration - prefer those when a "
        + "semantic check is worth having. `notObserved` need a new scenario before runtime evidence is possible; a function reached only "
        + "through a table or callback may need one written specifically for it."
      : "coverage was NOT exact on this core, so `coveredByScenario` is a list of functions OBSERVED AT SAMPLE POINTS, not functions proven "
        + "to have executed. Do not use it to claim a function ran.",
  };
}
