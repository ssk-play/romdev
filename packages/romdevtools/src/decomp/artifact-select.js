// artifact-select.js - choosing WHICH stored comparison to analyse, out loud.
//
// Client reply, 2026-09-15: a symbol-only `diagnose` call silently picked an
// older, worse candidate - 13 linked mismatches when the caller had already
// produced one with 11 and corrected stack homes. Both shared a dependency
// hash, so this was not stale evidence; it was a bad default, chosen without
// saying so.
//
// The default had been "newest file". That is wrong twice over:
//
//   1. mtime records when a comparison was last RUN, not how good it is. A
//      developer re-running an old candidate while testing something else
//      (which is exactly what happened) promotes it to "newest".
//   2. Even when newest is right, a caller cannot tell whether the diagnosis
//      describes their latest candidate, their best one, or something else.
//
// So: rank by RESIDUAL, break ties by recency, and always return the policy,
// the identity of what was chosen, and what else was available.

import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { dependencyHash } from "./project.js";
import { INPUT_SCHEMA, storedMeasurementFreshness, linkedMismatchCount } from "./measurement.js";
import { VERIFIER_VERSION } from "./verdict.js";

export const SELECTION_POLICIES = Object.freeze({
  best: "fewest ROM-linked mismatches, then fewest strict mismatches, then most recent. This is the default: a diagnosis should describe the closest candidate, not whichever one was compiled last.",
  newest: "most recently compared, whatever its residual. Useful when you want the diagnosis to follow the experiment you just ran.",
});

export async function describeExplicitArtifact(project, artifactPath) {
  let freshness = { state: "unknown", reason: "comparison result unavailable" }, candidate = null;
  try {
    const r = JSON.parse(await readFile(artifactPath.replace(/\.diff\.json$/, ".result.json"), "utf8"));
    const inv = await project.compileInvocation(r.function.tu);
    const dep = await dependencyHash(project, r.function.tu, inv);
    freshness = await storedMeasurementFreshness(project, r, { dependencyHash: dep.depsOk ? dep.hash : null });
    candidate = { inputIdentity: r.inputIdentity?.sha256 ?? null, dependencyHash: r.compiler?.dependencyHash ?? null,
      ownerMode: r.inputIdentity?.ownerMode ?? null, symbol: r.function.symbol, segment: r.function.segment ?? null };
  } catch (e) { freshness = { state: "unknown", reason: `could not establish live freshness: ${e.message}` }; }
  return { path: artifactPath, policy: "explicit", why: "caller-selected artifact; historical evidence stays inspectable but cannot rank as current",
    freshness: freshness.state, freshnessReason: freshness.reason, candidate };
}

/** Residual summary of one stored compare result, for ranking. */
async function residualOf(dir, base, project, dependencyHash, memo) {
  const resultPath = path.join(dir, `${base}.result.json`);
  try {
    const r = JSON.parse(await readFile(resultPath, "utf8"));
    return {
      linked: linkedMismatchCount(r),
      strict: r.strictMismatches ?? null,
      exact: r.exactFunctionMatch === true,
      compiled: r.compileSucceeded === true,
      dependencyHash: r.compiler?.dependencyHash ?? null,
      candidateSha: r.candidate?.sha256 ?? null,
      freshness: await storedMeasurementFreshness(project, r, { dependencyHash, memo }),
      liveMeasurement: r.inputIdentity?.schema === INPUT_SCHEMA && r.inputIdentity?.ownerMode === "live"
        && r.measurementValidity?.state === "valid" && r.verifierVersion === VERIFIER_VERSION,
    };
  } catch {
    return null;
  }
}

const rank = (a) => [
  a.residual?.compiled === false ? 1 : 0,          // a failed compile ranks last
  a.residual?.linked ?? Number.MAX_SAFE_INTEGER,
  a.residual?.strict ?? Number.MAX_SAFE_INTEGER,
  -a.mtime,                                        // recency breaks ties
];

const cmp = (a, b) => {
  const ra = rank(a), rb = rank(b);
  for (let i = 0; i < ra.length; i++) if (ra[i] !== rb[i]) return ra[i] - rb[i];
  return 0;
};

/**
 * Pick a stored `.diff.json` for a symbol and EXPLAIN the choice.
 *
 * @param {object} project
 * @param {string} symbol
 * @param {{prefer?: "best"|"newest"}} opts
 */
export async function selectArtifact(project, symbol, { prefer = "best", fn, currentDependencyHash } = {}) {
  if (!SELECTION_POLICIES[prefer]) {
    throw Object.assign(new Error(`unknown artifact preference '${prefer}'. Use one of: ${Object.keys(SELECTION_POLICIES).join(", ")}.`), { code: "BAD_ARGS" });
  }
  const dir = path.join(project.ws, "candidates", symbol);
  let files = [];
  try { files = (await readdir(dir)).filter((f) => f.endsWith(".diff.json")); } catch {}
  if (!files.length) {
    throw Object.assign(new Error(`no stored comparison for '${symbol}'. Run decomp({op:'compare', ...}) first, then pass its artifacts.diff - or call again once one exists.`), { code: "NO_ARTIFACT" });
  }

  let expectedHash = currentDependencyHash ?? null;
  if (currentDependencyHash === undefined) {
    try {
      fn ??= await project.resolveFunction({ symbol });
      const inv = await project.compileInvocation(fn.source.tu);
      const dep = await dependencyHash(project, fn.source.tu, inv);
      if (dep.depsOk) expectedHash = dep.hash;
    } catch { /* unknown is not current */ }
  }
  const rows = [], memo = new Map();
  for (const f of files) {
    const base = f.replace(/\.diff\.json$/, "");
    const st = await stat(path.join(dir, f)).catch(() => null);
    rows.push({ file: f, base, mtime: st?.mtimeMs ?? 0, residual: await residualOf(dir, base, project, expectedHash, memo) });
  }
  const currentRows = rows.filter((r) => expectedHash && r.residual?.freshness?.state === "current" && r.residual.liveMeasurement);
  if (!currentRows.length) throw Object.assign(new Error(
    `no verified current-tree comparison for '${symbol}' (${expectedHash ?? "dependency identity unavailable"}). Run decomp({op:'compare', ...}) to refresh a candidate, or pass artifactId explicitly to inspect historical evidence.`),
    { code: "NO_CURRENT_ARTIFACT", currentDependencyHash: expectedHash, historicalArtifacts: rows.length });
  const ordered = prefer === "newest" ? [...currentRows].sort((a, b) => b.mtime - a.mtime) : [...currentRows].sort(cmp);
  const chosen = ordered[0];
  const alternatives = ordered.slice(1, 6).map((r) => ({
    artifact: path.join(dir, r.file),
    linkedMismatches: r.residual?.linked ?? null,
    strictMismatches: r.residual?.strict ?? null,
    comparedAt: new Date(r.mtime).toISOString(),
  }));

  // A candidate that is better on the ranked measure but was NOT chosen can
  // only happen under prefer:'newest'. Say so rather than let it look like a
  // ranking bug.
  const bestByResidual = [...currentRows].sort(cmp)[0];
  const overridden = prefer === "newest" && bestByResidual.file !== chosen.file
    ? { artifact: path.join(dir, bestByResidual.file), linkedMismatches: bestByResidual.residual?.linked ?? null,
        note: "this candidate has a smaller residual but was not chosen, because prefer:'newest' was requested" }
    : null;

  return {
    path: path.join(dir, chosen.file),
    policy: prefer,
    policyMeaning: SELECTION_POLICIES[prefer],
    candidate: {
      sha256: chosen.residual?.candidateSha ?? chosen.base.split("-")[1] ?? null,
      dependencyHash: chosen.residual?.dependencyHash ?? chosen.base.split("-")[0] ?? null,
      linkedMismatches: chosen.residual?.linked ?? null,
      strictMismatches: chosen.residual?.strict ?? null,
      exactFunctionMatch: chosen.residual?.exact ?? null,
      comparedAt: new Date(chosen.mtime).toISOString(),
    },
    why: prefer === "best"
      ? `chosen from ${rows.length} stored comparison(s) as the one with the fewest ROM-linked mismatches (${chosen.residual?.linked ?? "unknown"}), ties broken by recency`
      : `chosen from ${rows.length} stored comparison(s) as the most recently compared`,
    totalArtifacts: rows.length,
    currentArtifacts: currentRows.length,
    historicalArtifacts: rows.length - currentRows.length,
    freshness: "current",
    ...(alternatives.length ? { alternatives } : {}),
    ...(overridden ? { betterCandidateNotChosen: overridden } : {}),
    note: "pass `artifactId` to analyse a specific comparison, or `prefer:'newest'` to follow the experiment you just ran. A symbol-only call does NOT automatically describe your latest candidate.",
  };
}
