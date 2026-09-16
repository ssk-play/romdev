// replay.js — a public-API replay suite over preserved candidates.
//
// §12 of the 2026-09-15 report: "Build a small, public-API replay suite from
// preserved candidates, using isolated worktrees or fixture snapshots. Do not
// mutate the production checkout or treat already-integrated current C as the
// original assembly fixture."
//
// That second clause is the one that bites. An accepted candidate is already
// in the tree, so re-splicing it into the CURRENT owner yields `redeclaration
// of ...` and a compile failure that looks like the candidate's fault. Every
// case that names an integrated function therefore carries `ownerPath`: the
// pre-integration backup, which is what makes an accepted recovery
// re-verifiable at all.
//
// What this measures, and what it deliberately does not:
//
//   MEASURED    whether each case reproduces its expected outcome, and how
//               long the public call took.
//   NOT CLAIMED any speedup multiple. The report says plainly: "No controlled
//               before/after throughput benchmark has been run. I cannot
//               substantiate a promised 5x or 10x speedup." A suite that
//               invented one would be the same failure it was written to
//               catch. p50/p95 are reported only when there are enough runs.

export const REPLAY_SCHEMA = "romdev-decomp-replay-suite-v1";

/**
 * The evaluation set from §12, keyed to the fixtures that exist on disk.
 *
 * Each case states the EXPECT up front, so a run that merely completes cannot
 * be read as a run that passed.
 */
export function defaultCases({ researchRoot, workspace }) {
  const R = (p) => `${researchRoot}/parallel-candidates/${p}`;
  const W = (p) => `${workspace}/${p}`;
  return [
    {
      id: "i2-exact-with-contradictory-rodata",
      why: "§12.1 — an exact recovery whose function-local rodata check found 0 target references against 1 candidate reference. The verdict must be exact; the rodata check must report a LIMITATION, not a mismatch.",
      op: "compare",
      symbol: "func_i2_802C7C50", segment: "ovl_i2",
      candidatePath: R("i2-detail7C50-297/variant.c"),
      // Integrated: the current owner already contains it.
      ownerPathHint: "patches/func_i2_802C7C50.*.orig.c",
      expect: { compileSucceeded: true, exactFunctionMatch: true, rodataState: "not-applicable" },
    },
    {
      id: "i3-five-word-scheduling-group",
      why: "§12.2 — five words of setup that are a scheduling permutation, plus a separate reversed branch pair. Diagnosis must report them as DIFFERENT groups.",
      op: "diagnose",
      symbol: "func_i3_802C5800", segment: "ovl_i3",
      candidatePath: R("i3-init5800-299/candidate.c"),
      tracePath: R("i3-init5800-300/as1-trace.log"),
      expect: { mechanisms: ["scheduling-permutation", "branch-lowering"], traceAccepted: true },
    },
    {
      id: "i3-reversed-branch-operands",
      why: "§12.3 — reversing the literal equality does NOT fix the branch pair. A variant batch must show it moving nothing.",
      op: "variants",
      symbol: "func_i3_802C5800", segment: "ovl_i3",
      candidatePath: R("i3-init5800-300/candidate.c"),
      variants: [
        { id: "reversed-equality", hypothesis: "swapping the equality operands flips the branch order",
          find: "if (courseId == D_i3_802C6FE4[difficulty]) {", replace: "if (D_i3_802C6FE4[difficulty] == courseId) {" },
      ],
      expect: { variantDeltaLinked: 0 },
    },
    {
      id: "i15-ceremony-frame-and-registers",
      why: "§12.5 — frame size restored, two matrix homes four bytes high, and an s5/s6/s7 rotation. The layout report must call the two homes a UNIFORM SHIFT rather than two unrelated problems.",
      op: "layout",
      symbol: "func_i15_802C5800", segment: "ovl_i15",
      candidatePath: R("i15-init5800-305/candidate.c"),
      expect: { frameDelta: 0, layoutShape: "uniform-shift", movedSlots: 2 },
    },
    {
      id: "two-overlays-one-virtual-address",
      why: "§12.7 — two functions at VA 0x802C5800 in different overlays must resolve to different targets, bytes and TUs.",
      op: "batch",
      symbols: [
        { symbol: "func_i3_802C5800", segment: "ovl_i3" },
        { symbol: "func_1B1FB0_802C5800", segment: "segment_1B1FB0" },
      ],
      expect: { distinctTargets: 2, distinctTus: 2 },
    },
    {
      id: "stale-near-match-absent-from-api-history",
      why: "§12.8 — a better historical candidate that the API never measured. Research import must surface it and must NOT describe the target as never attempted.",
      op: "research-status",
      symbol: "func_1B1FB0_802C6C1C",
      expect: { hasDrafts: true, claimedBestDistanceAtMost: 1 },
    },
    {
      id: "semantically-wrong-but-plausible",
      why: "§12.9 — a candidate that removes a required output argument. The gate must flag it even if a score looks attractive.",
      op: "gate",
      symbol: "func_i15_802C5800", segment: "ovl_i15",
      candidateText: "void f(Mtx *out) { guMtxIdent((Mtx_t *)out); D_801C2C70 = 0; }",
      baselineText: "void f(Mtx *out) { guMtxIdent(out); }",
      expect: { findingIds: ["pointer-cast", "global-write-added"] },
    },
  ];
}

/** Percentiles, only once there are enough samples to mean anything. */
export function timings(samples) {
  const xs = samples.filter((n) => Number.isFinite(n)).sort((a, b) => a - b);
  if (xs.length < 5) {
    return { n: xs.length, min: xs[0] ?? null, max: xs[xs.length - 1] ?? null,
      note: "fewer than 5 samples: p50/p95 are NOT reported. The report asked for percentiles only after enough runs, and extrapolating from a handful is how a single compare becomes a claimed speedup." };
  }
  const at = (q) => xs[Math.min(xs.length - 1, Math.floor(q * xs.length))];
  return { n: xs.length, min: xs[0], p50: at(0.5), p95: at(0.95), max: xs[xs.length - 1] };
}

/**
 * Check one case's actual result against its stated expectation.
 * Returns the reasons it failed, so "passed" is never merely "did not throw".
 */
export function checkExpectations(kase, actual) {
  const fails = [];
  const e = kase.expect ?? {};
  const eq = (name, got, want) => { if (got !== want) fails.push(`${name}: expected ${JSON.stringify(want)}, got ${JSON.stringify(got)}`); };

  if (e.compileSucceeded != null) eq("compileSucceeded", actual.compileSucceeded, e.compileSucceeded);
  if (e.exactFunctionMatch != null) eq("exactFunctionMatch", actual.exactFunctionMatch, e.exactFunctionMatch);
  if (e.rodataState) eq("rodata state", actual.rodataState, e.rodataState);
  if (e.traceAccepted != null) eq("trace accepted", actual.traceAccepted, e.traceAccepted);
  if (e.mechanisms) {
    for (const m of e.mechanisms) {
      if (!(actual.mechanisms ?? []).includes(m)) fails.push(`mechanism '${m}' not reported (got: ${(actual.mechanisms ?? []).join(", ") || "none"})`);
    }
  }
  if (e.variantDeltaLinked != null) eq("variant linked delta", actual.variantDeltaLinked, e.variantDeltaLinked);
  if (e.frameDelta != null) eq("frame delta", actual.frameDelta, e.frameDelta);
  if (e.layoutShape) eq("layout shape", actual.layoutShape, e.layoutShape);
  if (e.movedSlots != null) eq("moved slots", actual.movedSlots, e.movedSlots);
  if (e.distinctTargets != null) eq("distinct targets", actual.distinctTargets, e.distinctTargets);
  if (e.distinctTus != null) eq("distinct TUs", actual.distinctTus, e.distinctTus);
  if (e.hasDrafts != null) eq("has drafts", actual.hasDrafts, e.hasDrafts);
  if (e.claimedBestDistanceAtMost != null) {
    const d = actual.claimedBestDistance;
    if (!(d != null && d <= e.claimedBestDistanceAtMost)) fails.push(`claimedBestDistance: expected <= ${e.claimedBestDistanceAtMost}, got ${JSON.stringify(d)}`);
  }
  if (e.findingIds) {
    for (const id of e.findingIds) {
      if (!(actual.findingIds ?? []).includes(id)) fails.push(`gate finding '${id}' not raised (got: ${(actual.findingIds ?? []).join(", ") || "none"})`);
    }
  }
  return fails;
}

/**
 * Summarize a completed run. Reports what was measured and refuses to turn it
 * into a throughput claim.
 */
export function summarize(results) {
  const passed = results.filter((r) => r.passed).length;
  const failed = results.filter((r) => !r.passed && !r.skipped).length;
  const skipped = results.filter((r) => r.skipped).length;
  return {
    schema: REPLAY_SCHEMA,
    cases: results.length, passed, failed, skipped,
    timings: timings(results.map((r) => r.ms)),
    results,
    interpretation:
      "This suite measures whether each known bottleneck reproduces its expected OUTCOME through the public API. It is not a throughput benchmark: no baseline workflow was run alongside it, so it cannot support a speedup figure, and none is stated. "
      + "A case that merely completed is not a case that passed — every case carries its expectation and the reasons it failed.",
  };
}
