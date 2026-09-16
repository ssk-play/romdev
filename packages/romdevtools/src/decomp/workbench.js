// workbench.js - the bridge to n64-decomp-workbench.
//
// WHY A BRIDGE AND NOT A REIMPLEMENTATION. romdev's comparator classifies
// instruction count, stack frame, register substitutions, immediates, branch
// targets, relocations and whole-stream reordering. That is good first-pass
// triage and it cannot diagnose the mechanisms a late-stage campaign actually
// turns on: allocator webs, uopt global coloring, ugen temporary provenance,
// stack homes, as1 ready-set scheduling, emitted-line-number ties, pass
// ownership, frontend lineage. The workbench already does all of that, it is
// the tool real campaigns already use by hand, and building a second shallower
// copy inside romdev would produce two tools that disagree.
//
// DISCOVERY, NOT HARDCODING. `decomp-workbench commands --json` is a versioned,
// self-describing catalog: 128 commands in 24 groups, each carrying its own
// `invocation`, `report_schema`, and a `safety` block that says whether it is
// destructive, touches the network, or spawns an external process. The bridge
// reads that catalog and refuses anything it has not been told about, so the
// workbench can grow without romdev being edited - and so a command's own
// safety metadata, not a guess here, decides what is allowed to run.
//
// Its exit codes are part of the contract: 0 success, 1 gate/no-result (a real
// answer, NOT an error), 2 usage/capability/process, 3 census-failed.
//
// Plain JS ESM + JSDoc.

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawn } from "node:child_process";
import { readFile, mkdir, copyFile, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { compilationEnvironment, fileIdentities, fileRevisions, atomicJson, instructionIdentity, hashRecord } from "./measurement.js";
import { dumpObject, findSymbol, trimToSize, run } from "./mips-obj.js";
import { dependencyHash } from "./project.js";

/** The catalog schema this bridge understands. */
export const SUPPORTED_COMMAND_MAP_SCHEMA = "decomp-workbench-command-map-v1";

/** Exit codes the workbench documents. 1 is a RESULT, not a failure. */
export const WORKBENCH_EXIT = Object.freeze({
  0: "success",
  1: "gate/no-result",
  2: "usage/capability/process",
  3: "census-failed",
});

/** Where the workbench may live, in priority order. */
function candidateRoots() {
  const out = [];
  if (process.env.ROMDEV_WORKBENCH_HOME) out.push(process.env.ROMDEV_WORKBENCH_HOME);
  out.push(path.join(os.homedir(), ".romdev", "tools", "n64-decomp-workbench"));
  out.push(path.join(os.homedir(), "code", "cliemu", "n64-decomp-reference", "n64-decomp-workbench"));
  return out;
}

/**
 * Locate the workbench: an installed `decomp-workbench` on PATH, or a source
 * checkout run through `python3 -m decomp_workbench.cli`.
 */
export function locateWorkbench() {
  // A real install wins: it is the supported entry point.
  for (const dir of (process.env.PATH ?? "").split(path.delimiter)) {
    const p = path.join(dir, "decomp-workbench");
    try { if (fs.existsSync(p) && fs.statSync(p).isFile()) return { kind: "installed", argv0: [p], root: null }; } catch {}
  }
  for (const root of candidateRoots()) {
    const cli = path.join(root, "src", "decomp_workbench", "cli.py");
    if (fs.existsSync(cli)) {
      return { kind: "checkout", argv0: [process.env.ROMDEV_PYTHON ?? "python3", "-m", "decomp_workbench.cli"], root, pythonPath: path.join(root, "src") };
    }
  }
  return null;
}

/** Run one workbench command. Never throws on exit 1 - that is an answer. */
export async function runWorkbench(args, { cwd, timeoutMs = 600_000, json = true, env: extraEnv } = {}) {
  const loc = locateWorkbench();
  if (!loc) {
    throw Object.assign(new Error(
      "n64-decomp-workbench is not installed. Set ROMDEV_WORKBENCH_HOME to a checkout, "
      + "or `pip install n64-decomp-workbench` so `decomp-workbench` is on PATH. "
      + "romdev bridges to it rather than reimplementing late-stage mechanism diagnosis."),
      { code: "MISSING_WORKBENCH" });
  }
  const argv = [...loc.argv0, ...args, ...(json && !args.includes("--json") ? ["--json"] : [])];
  // The PROJECT's environment matters: a project-local binutils is built
  // against project-local shared objects, so running its objdump without the
  // project's LD_LIBRARY_PATH fails with a missing-library error that reads
  // like a workbench bug and is not one.
  const env = { ...process.env, ...(extraEnv ?? {}) };
  if (loc.pythonPath) env.PYTHONPATH = loc.pythonPath + (env.PYTHONPATH ? path.delimiter + env.PYTHONPATH : "");

  return await new Promise((resolve) => {
    const child = spawn(argv[0], argv.slice(1), { cwd: cwd ?? process.cwd(), env });
    let stdout = "", stderr = "", done = false;
    const timer = setTimeout(() => { if (!done) { try { child.kill("SIGKILL"); } catch {} } }, timeoutMs);
    child.stdout.on("data", (d) => { stdout += d; });
    child.stderr.on("data", (d) => { stderr += d; });
    child.on("error", (e) => { done = true; clearTimeout(timer); resolve({ code: 2, stdout, stderr: String(e?.message ?? e), argv, json: null }); });
    child.on("close", (code) => {
      done = true; clearTimeout(timer);
      let parsed = null;
      if (json) { try { parsed = JSON.parse(stdout); } catch {} }
      resolve({ code: code ?? 2, meaning: WORKBENCH_EXIT[code ?? 2] ?? "unknown", stdout, stderr, argv, json: parsed });
    });
  });
}

let _catalog = null;

/**
 * The workbench's own command catalog. Cached per process; the workbench is a
 * fixed install for the life of a session.
 */
export async function workbenchCatalog({ force = false } = {}) {
  if (_catalog && !force) return _catalog;
  const loc = locateWorkbench();
  if (!loc) return { available: false, reason: "not installed", setup: "set ROMDEV_WORKBENCH_HOME, or pip install n64-decomp-workbench" };
  const r = await runWorkbench(["commands"], { timeoutMs: 60_000 });
  if (!r.json) {
    return { available: false, reason: `could not read the command map (exit ${r.code})`, stderr: r.stderr.slice(0, 400) };
  }
  const d = r.json;
  const groups = {};
  let total = 0;
  for (const [name, list] of Object.entries(d.groups ?? {})) {
    const cmds = (Array.isArray(list) ? list : []).map((c) => ({
      command: c.command, description: c.description,
      invocation: c.invocation, reportSchema: c.report_schema, safety: c.safety,
    }));
    groups[name] = cmds; total += cmds.length;
  }
  _catalog = {
    available: true, kind: loc.kind, root: loc.root,
    schema: d.schema ?? null,
    schemaSupported: (d.schema ?? null) === SUPPORTED_COMMAND_MAP_SCHEMA,
    compatibility: d.compatibility ?? null,
    exitCodes: d.automation?.exit_codes ?? WORKBENCH_EXIT,
    groups, groupCount: Object.keys(groups).length, commandCount: total,
    ...(d.schema && d.schema !== SUPPORTED_COMMAND_MAP_SCHEMA
      ? { schemaWarning: `the workbench reports command-map schema '${d.schema}'; this bridge was written against '${SUPPORTED_COMMAND_MAP_SCHEMA}'. Commands are still discovered and run, but new fields may be ignored.` }
      : {}),
  };
  return _catalog;
}

const _flagCache = new Map();

/** Resolve exact compared objects instead of asking the client to reconstruct
 * a compiler invocation and guess which nearby object belongs to an artifact. */
export async function artifactWorkbenchInput(project, artifactPath) {
  const resultPath = artifactPath.replace(/\.diff\.json$/, ".result.json");
  const r = JSON.parse(await readFile(resultPath, "utf8"));
  if (r.measurementValidity?.state !== "valid" || !r.compileSucceeded) throw new Error("workbench requires a valid successful measured artifact; refresh compare first");
  if (!r.artifacts?.object || !r.artifacts?.targetObject || !r.objectIdentity?.sha256) throw new Error("comparison predates retained object provenance or has a ROM-only target; run compare with noCache:true to retain supported objects");
  const actual = (await fileIdentities([r.artifacts.object]))[0];
  if (actual.sha256 !== r.objectIdentity.sha256) throw new Error("candidate object no longer matches the recorded comparison hash; refusing mismatched provenance");
  const stored = JSON.parse(await readFile(r.artifacts.diff, "utf8"));
  const objdump = project.m.toolchain.objdump?.path;
  if (!objdump) throw new Error("artifact workbench requires the project's recorded objdump");
  const streams = [];
  for (const [objPath, bytes] of [[r.artifacts.targetObject, r.targetBytes], [r.artifacts.object, r.candidateBytes]]) {
    const dump = await dumpObject({ objdump, objPath, cwd: project.root, env: project.env });
    const symbol = findSymbol(dump, r.function.symbol);
    if (!symbol) throw new Error(`compared symbol '${r.function.symbol}' missing from retained object`);
    streams.push(trimToSize(symbol.instructions, bytes));
  }
  const targetId = instructionIdentity(streams[0]), candidateId = instructionIdentity(streams[1]);
  if (targetId?.sha256 !== instructionIdentity(stored.target)?.sha256 || candidateId?.sha256 !== r.outputIdentity?.sha256
    || candidateId?.sha256 !== instructionIdentity(stored.candidate)?.sha256) throw new Error("retained object instructions/relocations disagree with the comparison artifact; refusing workbench attribution");
  return { result: r, args: [r.artifacts.targetObject, r.artifacts.object, "--symbol", r.function.symbol,
    "--register-profile", "unverified", ...(r.artifacts.translationUnit ? ["--source", r.artifacts.translationUnit] : [])],
    provenance: { resultPath, inputIdentity: r.inputIdentity, invocation: r.compiler.invocation,
      outputIdentity: candidateId, targetIdentity: targetId, objectIdentity: actual,
      equivalence: "retained compared object, full object hash plus function instruction/relocation identity verified",
      freshness: "artifact-bound historical measurement; this check does not recompile or claim live-tree freshness",
      limits: "Object diagnosis alone does not supply allocator-web or scheduler traces. Register profile is explicitly unverified rather than inferring a measured compiler profile from its name." } };
}

/** External traces need a bundle binding invocation AND actual emitted code.
 * An unordered 90% word-coverage test or a nearby object hash is not proof. */
export async function verifyTraceBundle(project, artifactPath, tracePath) {
  let manifest;
  try { manifest = JSON.parse(await readFile(`${tracePath}.manifest.json`, "utf8")); }
  catch { return { equivalent: false, state: "unverified", reason: "no trace bundle manifest; loose logs cannot establish compiler invocation or emitted-output equivalence" }; }
  try {
    const { result: r } = await artifactWorkbenchInput(project, artifactPath);
    if (manifest.inputIdentity !== r.inputIdentity.sha256) throw new Error("trace baseline compilation identity differs");
    if (hashRecord(manifest.env) !== hashRecord(r.inputIdentity.env) || hashRecord(manifest.toolchain) !== hashRecord(r.inputIdentity.toolchain)) throw new Error("trace compiler/environment identity differs from the compared build");
    const traceIdentity = (await fileIdentities([tracePath]))[0];
    if (traceIdentity.sha256 !== manifest.traceSha256) throw new Error("trace log hash differs from bundle manifest");
    if (manifest.retainedPasses && hashRecord(await fileIdentities(manifest.retainedPasses.map(f => f.path))) !== hashRecord(manifest.retainedPasses)) throw new Error("retained compiler passes differ from the trace bundle");
    const ins = manifest.instrumentation;
    if (ins) {
      if (ins.kind !== "ido-5.3-globalcolor" || ins.originalDriver !== r.compiler.compiler.path
        || hashRecord(ins.traceEnvironment) !== hashRecord({ CDX_LOG: "1", CDX_DETAIL_WEB: "all" })) throw new Error("unsupported or undisclosed diagnostic compiler intervention");
      if (hashRecord(await fileIdentities(ins.files.map(f => f.path))) !== hashRecord(ins.files)) throw new Error("instrumented compiler files changed since capture");
      const off = (await fileIdentities([ins.disabledControl.object]))[0];
      if (off.sha256 !== ins.disabledControl.sha256 || off.sha256 !== r.objectIdentity.sha256) throw new Error("tracing-disabled diagnostic compiler fails full-object fidelity");
    }
    const normalized = (argv, context) => {
      const collapsed = [];
      for (let i = 0; i < argv.length; i++) {
        if (ins?.driverRunner && hashRecord(argv.slice(i, i + 3)) === hashRecord(ins.driverRunner)) { collapsed.push(ins.originalDriver); i += 2; }
        else collapsed.push(argv[i]);
      }
      return collapsed.filter(a => a !== "-Wa,-R" && !(ins && a === "-K"))
        .map(a => a === context.source ? "<source>" : a === context.object ? "<object>" : ins && a === ins.driver ? ins.originalDriver : a);
    };
    if (!manifest.context || !r.compileContext || hashRecord(normalized(manifest.invocation, manifest.context)) !== hashRecord(normalized(r.compiler.invocation, r.compileContext))) throw new Error("trace invocation changed beyond the disclosed -Wa,-R instrumentation flag");
    if (ins && hashRecord(normalized(ins.disabledControl.invocation, ins.disabledControl.context)) !== hashRecord(normalized(r.compiler.invocation, r.compileContext))) throw new Error("tracing-disabled control invocation differs from baseline");
    const actualObject = (await fileIdentities([manifest.objectPath]))[0];
    if (actualObject.sha256 !== manifest.objectSha256) throw new Error("traced object hash differs from bundle manifest");
    const dump = await dumpObject({ objdump: project.m.toolchain.objdump.path, objPath: manifest.objectPath, cwd: project.root, env: project.env });
    const stream = trimToSize(findSymbol(dump, r.function.symbol)?.instructions ?? [], r.candidateBytes);
    const identity = instructionIdentity(stream);
    if (identity?.sha256 !== r.outputIdentity.sha256) throw new Error("traced instructions or relocations differ from the compared function");
    // Whole-object equality additionally protects literal pools, siblings and
    // relocation/symbol context. If instrumentation changes metadata, report
    // that as non-equivalence instead of silently weakening the criterion.
    if (actualObject.sha256 !== r.objectIdentity.sha256) throw new Error("traced whole object differs, despite any matching function words; trace is non-equivalent");
    return { equivalent: true, state: "verified", tracePath, objectIdentity: actualObject, outputIdentity: identity,
      inputIdentity: r.inputIdentity.sha256, invocation: manifest.invocation,
      method: "manifest-bound trace hash, disclosed instrumentation-only invocation delta, ordered function instructions/relocations and full compared-object equality" };
  } catch (e) { return { equivalent: false, state: "rejected", reason: e.message }; }
}

/** Native IDO scheduler instrumentation only. No optimizer flags or compiler
 * binaries are substituted. Every trace must prove emitted-object equality. */
export async function captureSchedulerTrace(project, artifactPath) {
  const bound = await artifactWorkbenchInput(project, artifactPath), r = bound.result;
  if (!r.artifacts.translationUnit || !r.compileContext) throw new Error("refresh compare with noCache:true to preserve its exact compiled translation unit");
  if (r.compiler.compiler?.kind !== "ido") throw new Error("native -Wa,-R capture currently supports IDO only; no trace flag is guessed for other compilers");
  const inv = await project.compileInvocation(r.function.tu);
  if (hashRecord({ compile: inv.compile, post: inv.post }) !== hashRecord(r.inputIdentity.invocation)) throw new Error("live compiler invocation changed; refresh comparison before tracing");
  const toolFiles = r.inputIdentity.toolchain.map(t => t.path);
  const actualTools = await fileIdentities(toolFiles);
  if (hashRecord(actualTools) !== hashRecord(r.inputIdentity.toolchain) || hashRecord(compilationEnvironment(project)) !== hashRecord(r.inputIdentity.env)) throw new Error("compiler/environment changed since comparison");
  const dep = await dependencyHash(project, r.artifacts.translationUnit, inv);
  if (!dep.depsOk || dep.hash !== r.inputIdentity.candidateDependencies) throw new Error("retained TU or headers changed since comparison; trace would describe another build");
  const cacheKey = hashRecord({ input: r.inputIdentity.sha256, output: r.outputIdentity, mode: "native-as1-R-v1" });
  const dir = path.join(project.ws, "traces", cacheKey), index = path.join(dir, "bundle.json");
  try {
    const cached = JSON.parse(await readFile(index, "utf8"));
    const verification = await verifyTraceBundle(project, artifactPath, cached.tracePath);
    if (verification.equivalent) return { ...cached, verification, cacheHit: true };
  } catch { /* absent or damaged trace: produce a fresh isolated bundle */ }
  const work = path.join(dir, randomUUID());
  const source = path.join(work, r.function.tu), object = path.join(work, "trace.o");
  await mkdir(path.dirname(source), { recursive: true });
  await copyFile(r.artifacts.translationUnit, source);
  const watched = [r.artifacts.translationUnit, ...toolFiles, ...dep.deps.map(p => project.abs(p))];
  const before = await fileRevisions(watched);
  const argv = r.compiler.invocation.map(a => a === r.compileContext.source ? source : a === r.compileContext.object ? object : a);
  // asm-processor treats its final argument as the input filename.
  argv.splice(argv.indexOf(source), 0, "-Wa,-R");
  const result = await run(argv[0], argv.slice(1), { cwd: project.root, env: project.env, timeoutMs: 180_000 });
  const tracePath = path.join(work, "scheduler.log");
  await writeFile(tracePath, result.stdout + "\n" + result.stderr);
  if (result.code !== 0) return { tracePath, equivalent: false, reason: "instrumented compile failed", exitCode: result.code };
  const originalObj = path.join(project.m.splat.buildPath, r.function.tu.replace(/\.c$/, ".o"));
  for (const post of inv.post) {
    const args = post.map(a => a === originalObj ? object : a === r.function.tu ? source : a);
    const step = await run(args[0], args.slice(1), { cwd: project.root, env: project.env });
    if (step.code !== 0) throw new Error("instrumented compile post-processing failed");
  }
  const afterDep = await dependencyHash(project, r.artifacts.translationUnit, inv);
  if (afterDep.hash !== dep.hash || hashRecord(before) !== hashRecord(await fileRevisions(watched))) return { tracePath, equivalent: false, reason: "inputs changed during trace capture" };
  const manifest = { schema: "romdev-compiler-trace-v1", inputIdentity: r.inputIdentity.sha256,
    invocation: argv, context: { source, object }, env: r.inputIdentity.env, toolchain: actualTools,
    objectPath: object, objectSha256: (await fileIdentities([object]))[0].sha256,
    traceSha256: (await fileIdentities([tracePath]))[0].sha256 };
  await atomicJson(`${tracePath}.manifest.json`, manifest);
  const verification = await verifyTraceBundle(project, artifactPath, tracePath);
  const bundle = { tracePath, manifestPath: `${tracePath}.manifest.json`, verification, cacheHit: false };
  if (verification.equivalent) await atomicJson(index, bundle);
  return bundle;
}

/**
 * Does a workbench command accept a given flag?
 *
 * Asked of the COMMAND ITSELF via `--help`, not guessed. romdev used to append
 * `--objdump <path>` to every invocation so a project-local binutils would
 * load - correct for `object diagnose`, and fatal for `project show`, which
 * has no such flag and exits 2. A read-only command must be called only with
 * flags its own schema accepts.
 *
 * Cached per process: the workbench is a fixed install for the session.
 */
export async function commandAcceptsFlag(inv, flag) {
  const key = `${inv.join(" ")}::${flag}`;
  if (_flagCache.has(key)) return _flagCache.get(key);
  let ok = false;
  try {
    const r = await runWorkbench([...inv, "--help"], { timeoutMs: 30_000, json: false });
    ok = new RegExp(`(^|\\s)${flag.replace(/[-]/g, "[-]")}(\\s|=|$)`, "m").test(r.stdout ?? "");
  } catch { ok = false; }
  _flagCache.set(key, ok);
  return ok;
}

/** Find one command in the catalog by "<group> <command>" or a flat name. */
export function findCommand(catalog, group, command) {
  if (!catalog?.available) return null;
  if (group && catalog.groups[group]) {
    return catalog.groups[group].find((c) => c.command === command) ?? null;
  }
  for (const [g, list] of Object.entries(catalog.groups)) {
    const hit = list.find((c) => c.command === command);
    if (hit) return { ...hit, group: g };
  }
  return null;
}

/**
 * Run a catalogued command, refusing anything the catalog does not list and
 * anything whose own safety metadata says it is destructive or networked
 * unless the caller opted in explicitly.
 */
export async function invokeWorkbench({ group, command, args = [], cwd, timeoutMs, env, allowDestructive = false, allowNetwork = false }) {
  const catalog = await workbenchCatalog();
  if (!catalog.available) {
    throw Object.assign(new Error(`workbench unavailable: ${catalog.reason}. ${catalog.setup ?? ""}`), { code: "MISSING_WORKBENCH" });
  }
  const spec = findCommand(catalog, group, command);
  if (!spec) {
    const near = Object.entries(catalog.groups).filter(([g]) => !group || g === group)
      .flatMap(([g, l]) => l.map((c) => `${g} ${c.command}`)).slice(0, 25);
    throw Object.assign(new Error(
      `workbench has no command '${[group, command].filter(Boolean).join(" ")}'. `
      + `The catalog is read from the workbench itself (${catalog.commandCount} commands in ${catalog.groupCount} groups), so this is authoritative. `
      + `Nearby: ${near.join(", ")}`), { code: "NO_SUCH_WORKBENCH_COMMAND" });
  }
  // The command's OWN safety metadata decides, not a guess here.
  if (spec.safety?.destructive && !allowDestructive) {
    throw Object.assign(new Error(`workbench '${group ?? spec.group} ${command}' is marked destructive by the workbench itself; pass allowDestructive:true to run it.`), { code: "WORKBENCH_DESTRUCTIVE" });
  }
  if (spec.safety?.network && !allowNetwork) {
    throw Object.assign(new Error(`workbench '${group ?? spec.group} ${command}' reaches the NETWORK; pass allowNetwork:true to run it.`), { code: "WORKBENCH_NETWORK" });
  }

  // Use the catalog's own invocation, minus its argv0 (the bridge supplies that).
  const inv = Array.isArray(spec.invocation) ? spec.invocation.slice(1) : [group, command].filter(Boolean);
  const r = await runWorkbench([...inv, ...args], { cwd, timeoutMs, env });
  return {
    command: `${group ?? spec.group ?? ""} ${command}`.trim(),
    reportSchema: spec.reportSchema ?? null,
    safety: spec.safety ?? null,
    exitCode: r.code, exitMeaning: r.meaning,
    // Exit 1 is "gate/no-result" - a real answer, not a failure. Reporting it
    // as an error is how a legitimate "no" becomes a fake problem.
    ok: r.code === 0 || r.code === 1,
    isGate: r.code === 1,
    report: r.json,
    ...(r.json ? {} : { stdout: r.stdout.slice(0, 4000) }),
    ...(r.stderr ? { stderr: r.stderr.slice(0, 2000) } : {}),
    argv: r.argv,
  };
}

/** Large workbench evidence belongs on disk, not in every agent context.
 * Keep the workbench's complete report intact and expose a bounded projection. */
export async function compactWorkbenchReport(project, response, { outputPath, detail = false } = {}) {
  if (!response.report) return response;
  const bytes = Buffer.byteLength(JSON.stringify(response.report));
  if (!outputPath && (detail || bytes <= 64_000)) return response;
  const destination = outputPath ?? path.join(project.ws, "workbench", `${randomUUID()}.json`);
  await mkdir(path.dirname(destination), { recursive: true });
  await atomicJson(destination, response.report);
  const report = response.report;
  return { ...response, reportArtifact: { path: destination, bytes, complete: true },
    report: detail ? report : { schema: report.schema, filters: report.filters, error: report.error,
      compact: true, availableFields: Object.keys(report),
      arrayCounts: Object.fromEntries(Object.entries(report).filter(([, v]) => Array.isArray(v)).map(([k, v]) => [k, v.length])),
      ...(report.allocator_webs ? { allocator_webs: report.allocator_webs.slice(0, 10).map(w => ({
        proc: w.proc, web: w.web, phase: w.phase_tag, assigned_color: w.assigned_color, assigned_register: w.assigned_register,
        natural_color: w.natural_color, natural_register: w.natural_register, explanation: w.explanation,
        mincost_tie_colors: w.mincost_tie_colors, detail: w.detail,
      })) } : {}),
      note: "Complete, unmodified workbench report is in reportArtifact.path. This projection is bounded; omitted fields are not absent evidence. Use wbArgs filters for a narrower report or detail:true for explicit full inline output." } };
}
