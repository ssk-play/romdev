import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { recordVariantExperiment, listExperiments, annotateExperimentHistory, exhaustedFamilies, experimentCooldown, createExperiment, recordCandidate, loadExperiment, recordControl } from "../src/decomp/experiment.js";

const snapshot = { dependencyHash: "dep", compilerFingerprint: "compiler", referenceHash: "rom", ownerMode: "live", ownerSha256: "owner", validity: "valid" };
const base = { id: "baseline", inputIdentity: { sha256: "base" }, outputIdentity: { sha256: "output", scope: "instructions" }, snapshot, metrics: { compiled: true } };
const variant = { id: "first", lever: "declaration-order", inputIdentity: { sha256: "variant" }, snapshot, metrics: { compiled: true }, delta: { strict: 0, linked: 0 } };
const batch = { function: { symbol: "f", segment: "ovl1" }, rows: [base, variant], snapshotStable: true, elapsedMs: 5 };
const diagnosis = () => ({ groups: [{ experiments: [{ id: "declaration-order" }, { id: "lifetime-shortening" }] }] });
const scope = { symbol: "f", segment: "ovl1", baselineInput: "base", baselineOutput: base.outputIdentity, snapshot };

test("measured batches persist once; labels and filenames cannot manufacture independent experiments", async () => {
  const project = { id: "fixture", ws: await mkdtemp(path.join(os.tmpdir(), "romdev-history-")) };
  const first = await recordVariantExperiment(project, batch);
  const second = await recordVariantExperiment(project, { ...batch, rows: [base, { ...variant, id: "renamed" }] });
  assert.equal(second.id, first.id); assert.equal(second.duplicate, true);
  const relabeled = await recordVariantExperiment(project, { ...batch, rows: [base, { ...variant, lever: "invented-other-lever" }] });
  assert.equal(relabeled.id, first.id, "renaming a lever cannot turn the same tested input into independent evidence");
  const all = await listExperiments(project);
  assert.equal(all.length, 1);
  const d = annotateExperimentHistory(diagnosis(), all, scope);
  assert.equal(d.groups[0].experiments[0].priorOutcomes[0].outcome, "tested-unchanged");
  assert.equal(d.groups[0].experiments[0].historyState, "previously-tested-inputs-exist");
  assert.equal(d.groups[0].experiments[1].historyState, "untried-in-recorded-history");
  assert.deepEqual((await exhaustedFamilies(project, "f")).deadFamilies, []);
  for (const changed of [{ ...scope, segment: "ovl2" }, { ...scope, snapshot: { ...snapshot, dependencyHash: "new" } }, { ...scope, baselineInput: "another" }]) {
    const result = annotateExperimentHistory(diagnosis(), all, changed);
    assert.notEqual(result.groups[0].experiments[0].historyState, "previously-tested-inputs-exist");
  }
});

test("concurrent experiment updates preserve every candidate and control", async () => {
  const project = { id: "fixture", ws: await mkdtemp(path.join(os.tmpdir(), "romdev-history-concurrent-")) };
  const rec = await createExperiment(project, { symbol: "f", hypothesis: "test", lever: "declaration-order" });
  await Promise.all([
    ...Array.from({ length: 24 }, (_, i) => recordCandidate(project, rec.id, { candidateSha: String(i), distance: i })),
    recordControl(project, rec.id, { kind: "positive", moved: true }),
    recordControl(project, rec.id, { kind: "negative", moved: false }),
  ]);
  const saved = await loadExperiment(project, rec.id);
  assert.equal(new Set(saved.candidates.map(c => c.candidateSha)).size, 24);
  assert.equal(saved.controls.positive.passed, true);
  assert.equal(saved.controls.negative.passed, true);
  const observed = await Promise.all(Array.from({ length: 5 }, () => recordVariantExperiment(project, batch)));
  assert.equal(observed.filter(o => !o.duplicate).length, 1);
});

test("invalid batches record failures, never unchanged/exhausted conclusions", async () => {
  const project = { id: "fixture", ws: await mkdtemp(path.join(os.tmpdir(), "romdev-history-invalid-")) };
  const result = await recordVariantExperiment(project, { ...batch, snapshotStable: false });
  assert.equal(result.conclusion.outcomes[0].outcome, "invalid-measurement");
  assert.equal(result.conclusion.controlsVerified, false);
});

test("cooldown counts distinct valid current-baseline batches, expires, and permits deliberate/new-lever campaigns", async () => {
  const project = { id: "fixture", ws: await mkdtemp(path.join(os.tmpdir(), "romdev-cooldown-")) };
  for (let i = 0; i < 3; i++) await recordVariantExperiment(project, { ...batch, rows: [base, { ...variant, inputIdentity: { sha256: `different-${i}` } }] });
  const records = await listExperiments(project);
  assert.equal(experimentCooldown(records, scope).active, true);
  assert.equal(experimentCooldown([records[0], records[0], records[0]], scope).active, false);
  assert.equal(experimentCooldown(records, { ...scope, ignore: true }).active, false);
  assert.equal(experimentCooldown(records, { ...scope, proposedLever: "lifetime-shortening" }).active, false);
  assert.equal(experimentCooldown(records, { ...scope, now: Date.now() + 4_000_000 }).active, false);
  assert.equal(experimentCooldown(records, { ...scope, snapshot: { ...snapshot, dependencyHash: "changed" } }).active, false);
  assert.equal(experimentCooldown(records, { ...scope, baselineInput: undefined }).active, true, "planner selects latest campaign baseline, not latest variant");
  const improved = { ...records[0], id: "new-improvement", createdAt: new Date(Date.now() + 1).toISOString(), candidates: [{ ...records[0].candidates[0], outcome: "improved" }] };
  assert.equal(experimentCooldown([improved, ...records], scope).active, false);
});
