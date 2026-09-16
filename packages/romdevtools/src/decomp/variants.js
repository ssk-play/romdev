// variants.js - small, reproducible experiment batches.
//
// §7 of the 2026-09-15 report: "We repeatedly wrote ad hoc Node scripts to load
// a candidate, construct three small variants, call compare serially, and print
// only useful fields. This is a normal workflow that the public tool should
// support cleanly."
//
// What makes this more than a for-loop around `compare`:
//
//   ONE SNAPSHOT.       Every variant in a batch is measured against a single
//                       dependency hash. If the tree moves mid-batch the
//                       results are not comparable, so the batch says so
//                       instead of quietly mixing two measurements.
//   DUPLICATES NAMED.   Two variants whose SOURCE hashes match are one
//                       experiment; equal function words and relocations are
//                       instruction-identical, not whole-object identical.
//                       Both were paid for and both are worth
//                       knowing, so neither is silently dropped.
//   ISOLATION.          Variants of two different functions must not share a
//                       working directory. compileAndCompare already builds in
//                       a per-call work dir; batches never edit shared source.
//   NO SCALAR COLLAPSE. size, schedule and register residuals are reported
//                       separately. A single "score" hides that a candidate
//                       got closer on bytes while getting worse on allocation.
//   FAILURES KEPT.      A variant that does not compile is a result. It stays
//                       in the table with its diagnostics.

import { createHash } from "node:crypto";
import { measurementSnapshot, batchSnapshot, linkedMismatchCount } from "./measurement.js";

export const VARIANTS_SCHEMA = "romdev-decomp-variant-batch-v1";

const sha = (t) => createHash("sha256").update(String(t)).digest("hex");

/**
 * Apply a named patch to a baseline source.
 *
 * A patch is deliberately simple and LITERAL - `find` must appear exactly once,
 * because a replacement that silently hits three sites is not the experiment
 * the caller described. Callers who want something richer pass full
 * `candidateText` instead.
 *
 * @param {string} baseline
 * @param {{find?:string, replace?:string, candidateText?:string}} patch
 */
export function applyPatch(baseline, patch) {
  if (patch.candidateText != null) return patch.candidateText;
  if (patch.find == null) throw Object.assign(new Error("a variant needs either `candidateText` or a `find`/`replace` pair"), { code: "BAD_ARGS" });
  const parts = String(baseline).split(patch.find);
  if (parts.length === 1) {
    throw Object.assign(new Error(`variant patch did not apply: \`find\` text was not present in the baseline. The text searched for was: ${JSON.stringify(patch.find.slice(0, 120))}`), { code: "PATCH_NOT_APPLIED" });
  }
  if (parts.length > 2) {
    throw Object.assign(new Error(`variant patch is ambiguous: \`find\` matched ${parts.length - 1} times. A patch that hits several sites is not the experiment you described - make the text unique or pass candidateText.`), { code: "PATCH_AMBIGUOUS" });
  }
  return parts.join(patch.replace ?? "");
}

/**
 * Separate residual metrics. Deliberately NOT collapsed into one score.
 */
export function metricsOf(result) {
  // Field names read from a REAL stored result.json, not assumed: the compare
  // result is flat (`strictMismatches`, `targetBytes`, `evidence`), and an
  // earlier guess at nested shapes silently produced null for every metric -
  // a table of nulls that still looked like it had run.
  const ev = result?.evidence ?? {};
  return {
    compiled: result?.compileSucceeded === true,
    targetBytes: result?.targetBytes ?? null,
    candidateBytes: result?.candidateBytes ?? null,
    frameSize: ev.stackFrame ? { target: ev.stackFrame.target, candidate: ev.stackFrame.candidate } : null,
    strictMismatches: result?.strictMismatches ?? null,
    linkedMismatches: linkedMismatchCount(result),
    instructionCountDelta: ev.instructionCount ? ev.instructionCount.candidate - ev.instructionCount.target : null,
    differenceKinds: result?.differenceKinds ?? [],
    distance: result?.distance?.value ?? null,
    scheduling: ev.reordered ?? null,
    registerSubstitutions: ev.registerSubstitutions?.count ?? null,
    branchDifferences: ev.branchTargetDifferences?.count ?? null,
    exactFunctionMatch: result?.exactFunctionMatch === true,
    functionLocal: result?.verdict?.functionLocal ?? result?.verification?.functionLocal ?? null,
    siblingsUnchanged: result?.verification?.translationUnit ?? null,
  };
}

/**
 * Run a batch of source variants against one baseline.
 *
 * @param {object} project
 * @param {object} fn resolved function
 * @param {{baselineText:string, variants:Array<{id:string,hypothesis?:string,find?:string,replace?:string,candidateText?:string}>,
 *          compare:Function, gate?:Function, maxVariants?:number, ownerPath?:string|null}} a
 */
export async function runVariantBatch(project, fn, {
  baselineText, variants, compare, gate, maxVariants = 12, ownerPath = null, threads = 1,
} = {}) {
  if (!baselineText) throw Object.assign(new Error("decomp({op:'variants'}): a baseline candidate is required (candidatePath or candidateText)."), { code: "BAD_ARGS" });
  if (!Array.isArray(variants) || !variants.length) throw Object.assign(new Error("decomp({op:'variants'}): `variants` must be a non-empty list of {id, hypothesis, find/replace | candidateText}."), { code: "BAD_ARGS" });
  if (![1, 2].includes(threads)) throw Object.assign(new Error("variants supports threads:1 or threads:2; larger pools have not been validated for this workflow"), { code: "BAD_ARGS" });

  const picked = variants.slice(0, maxVariants);
  const startedAt = Date.now();

  // The baseline is measured FIRST and in the same way as every variant, so a
  // variant's numbers are comparable to something rather than to nothing.
  const rows = [];
  const base = await compare({ candidateText: baselineText, label: "baseline", ownerPath });
  rows.push({ id: "baseline", hypothesis: "the unmodified candidate: the reference every variant is compared against",
    sourceSha: sha(baselineText), metrics: metricsOf(base), artifacts: base?.artifacts ?? null,
    inputIdentity: base?.inputIdentity ?? null, snapshot: measurementSnapshot(base), outputIdentity: base?.outputIdentity ?? null,
    cacheHit: base?.cacheHit ?? false, compileMs: base?.cacheHit ? 0 : base?.compileMs ?? 0 });

  // Did the baseline produce a usable reference at all?
  const baselineMeasured = rows[0].metrics.compiled === true;

  /** @type {Map<string,string>} sourceSha -> first id with it */
  const bySource = new Map([[sha(baselineText), "baseline"]]);
  /** @type {Map<string,string>} candidate object bytes -> first id */
  const byOutput = new Map();
  const outputKey = (r) => r?.outputIdentity?.sha256 && r.outputIdentity.scope
    ? `${r.outputIdentity.scope}:${r.outputIdentity.sha256}` : null;
  if (base.compileSucceeded && outputKey(base)) byOutput.set(outputKey(base), "baseline");

  // Decide source duplication BEFORE launching workers. Reduce results in
  // request order, not completion order, so identity attribution is stable.
  const prepared = picked.map(v => {
    if (!v?.id) return { row: { id: "(unnamed)", error: "every variant needs a stable `id`" } };
    let text;
    try { text = applyPatch(baselineText, v); }
    catch (e) { return { row: { id: v.id, hypothesis: v.hypothesis ?? null, error: `${e.code ?? "ERROR"}: ${e.message}`, applied: false } }; }

    const srcSha = sha(text);
    // A duplicate SOURCE is reported, not re-run: it is the same experiment.
    if (bySource.has(srcSha)) {
      return { row: { id: v.id, hypothesis: v.hypothesis ?? null, sourceSha: srcSha,
        duplicateOf: bySource.get(srcSha), note: "identical source to an earlier entry: not recompiled, and it is not independent evidence" } };
    }
    bySource.set(srcSha, v.id);

    return { v, text, srcSha };
  });
  let next = 0;
  await Promise.all(Array.from({ length: threads }, async () => {
    while (next < prepared.length) {
      const task = prepared[next++];
      if (task.row) continue;
      try { task.r = await compare({ candidateText: task.text, label: `variant:${task.v.id}`, ownerPath }); }
      catch (e) {
        task.row = { id: task.v.id, hypothesis: task.v.hypothesis ?? null, sourceSha: task.srcSha,
          error: `${e.code ?? "ERROR"}: ${String(e.message).slice(0, 200)}` };
      }
    }
  }));
  for (const task of prepared) {
    if (task.row) { rows.push(task.row); continue; }
    const { v, text, srcSha, r } = task;

    const m = metricsOf(r);
    // Only ordered function words and relocations are covered by this hash.
    const outKey = m.compiled ? outputKey(r) : null;
    let byteInert = null;
    if (outKey) {
      if (byOutput.has(outKey)) byteInert = byOutput.get(outKey);
      else byOutput.set(outKey, v.id);
    }

    const row = {
      id: v.id, hypothesis: v.hypothesis ?? null, lever: v.lever ?? null, sourceSha: srcSha,
      metrics: m,
      inputIdentity: r?.inputIdentity ?? null, snapshot: measurementSnapshot(r), outputIdentity: r?.outputIdentity ?? null,
      cacheHit: r?.cacheHit ?? false, compileMs: r?.cacheHit ? 0 : r?.compileMs ?? 0,
      // Movement relative to the BASELINE, per dimension.
      //
      // A delta is only meaningful when the baseline actually produced a
      // measurement. When it did not compile there is nothing to move relative
      // TO, and `bytes: 0` / `registers: 0` would read as "this variant changed
      // nothing" when the truth is "we cannot say" -- the confident-wrong-answer
      // shape this whole module exists to avoid.
      delta: baselineMeasured ? {
        strict: m.strictMismatches != null && rows[0].metrics.strictMismatches != null ? m.strictMismatches - rows[0].metrics.strictMismatches : null,
        linked: m.linkedMismatches != null && rows[0].metrics.linkedMismatches != null ? m.linkedMismatches - rows[0].metrics.linkedMismatches : null,
        bytes: m.candidateBytes != null && rows[0].metrics.candidateBytes != null ? m.candidateBytes - rows[0].metrics.candidateBytes : null,
        registers: m.registerSubstitutions != null && rows[0].metrics.registerSubstitutions != null
          ? m.registerSubstitutions - rows[0].metrics.registerSubstitutions : null,
      } : null,
      ...(baselineMeasured ? {} : { deltaNote: "the BASELINE did not compile, so there is no reference to measure movement against. This variant's own metrics stand on their own; no delta is reported rather than one that would read as 'unchanged'." }),
      ...(byteInert ? { instructionIdenticalTo: byteInert,
        note: "same function instruction bytes and relocation records; rodata, other functions, and semantics are NOT covered by this identity" } : {}),
      ...(r?.diagnostics?.length ? { diagnostics: r.diagnostics.slice(0, 4) } : {}),
      artifacts: r?.artifacts ?? null,
    };
    if (gate && m.compiled) {
      try { row.sourceQuality = await gate(text); } catch {}
    }
    rows.push(row);
  }

  // Snapshot validity: if the dependency hash moved during the batch, the rows
  // are not comparable and saying so is the whole point of taking a snapshot.
  const snapshot = batchSnapshot(rows);
  if (snapshot.snapshotStable !== true) {
    for (const row of rows) { if (row.delta) row.delta = null; }
  }

  return {
    schema: VARIANTS_SCHEMA,
    threads,
    function: { symbol: fn.symbol, segment: fn.segment ?? null, va: fn.vaHex ?? null, tu: fn.source?.tu ?? null },
    ...snapshot,
    ...(snapshot.snapshotStable === true ? {} : { snapshotWarning: "input snapshot is invalid or unknown: rows are not comparable. Re-run against a stable, measured tree." }),
    requestedVariants: variants.length, executedVariants: rows.filter((r) => r.metrics).length - 1,
    truncatedVariants: Math.max(0, variants.length - picked.length),
    variants: rows.length,
    compiled: rows.filter((r) => r.metrics?.compiled).length,
    duplicates: rows.filter((r) => r.duplicateOf).length,
    instructionIdentical: rows.filter((r) => r.instructionIdenticalTo).length,
    uniqueInstructionOutputs: byOutput.size,
    cacheHits: rows.filter((r) => r.cacheHit).length,
    compileMs: rows.reduce((n, r) => n + (r.compileMs ?? 0), 0),
    failed: rows.filter((r) => r.error || r.metrics?.compiled === false).length,
    elapsedMs: Date.now() - startedAt,
    baselineMeasured,
    ...(baselineMeasured ? {} : { baselineWarning: "the baseline candidate did not compile. Variants were still measured and their own numbers are real, but NO deltas are reported: there is nothing to compare movement against. Fix the baseline first if you need relative movement." }),
    rows,
    policy: "size, schedule and register residuals are reported SEPARATELY and never collapsed into one score. Source duplication and instruction-output identity are separate. Instruction identity does not establish whole-object, rodata, or semantic identity. Missing evidence is unknown, not zero.",
  };
}
