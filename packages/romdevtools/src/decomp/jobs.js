// jobs.js — bounded candidate search as a cancellable, resumable background
// job around decomp-permuter. The permuter owns the mutation + scoring loop
// (it is the community's tool for exactly this); romdev owns the budget, the
// persistence, the process lifetime and the honest status.
//
// A job never touches the project's sources: import.py copies the TU + the
// target asm into its own directory under the workspace, and the compile
// script it writes runs the project's compiler with the candidate as input.
import { readFile, writeFile, mkdir, readdir, stat } from "node:fs/promises";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { run } from "./mips-obj.js";
import { toolPaths, backendStatus } from "./m2c.js";
import { sha256Text } from "./project.js";
import { profileFor } from "./platform.js";

const jobsDir = (project) => path.join(project.ws, "jobs");
let counter = 0;

/**
 * Build a decomp-permuter directory WITHOUT touching the project tree:
 *   base.c       the real TU with the candidate spliced in, preprocessed with the
 *                build's own includes/defines (pragmas stripped; the permuter
 *                replaces every other function with a declaration itself)
 *   target.o     the extracted asm assembled by romdev (same prelude the
 *                permuter's import.py uses)
 *   compile.sh   the project's compiler with the TU's exact flags (asm-processor
 *                stripped away: base.c has no GLOBAL_ASM left to process)
 *   settings.toml func_name + compiler_type + objdump
 */
async function preparePermuterDir(project, fn, baseCandidateText, jobDir) {
  const t = toolPaths();
  if (!fs.existsSync(path.join(t.permuter, "permuter.py"))) throw Object.assign(new Error(`decomp-permuter not installed at ${t.permuter}. ${(await backendStatus()).permuter.setup}`), { code: "MISSING_BACKEND" });
  const { spliceFunction, ensureTarget } = await import("./compile.js");
  const tuRel = fn.source?.tu;
  if (!tuRel) throw Object.assign(new Error(`function '${fn.symbol}' is in no TU`), { code: "FUNCTION_NOT_IN_TU" });
  const target = await ensureTarget(project, fn);
  if (target.romOnly) throw Object.assign(new Error(`function '${fn.symbol}' has no extracted asm; the permuter needs a target .s`), { code: "NO_TARGET_ASM" });
  const inv = await project.compileInvocation(tuRel);
  // Preprocess the spliced TU with the build's include paths + defines.
  const tuText = await readFile(project.abs(tuRel), "utf8");
  const spliced = spliceFunction(tuText, fn.symbol, baseCandidateText).text.replace(/^[ \t]*#pragma\s+GLOBAL_ASM\([^)]*\)[ \t]*$/gm, "");
  const permDir = path.join(jobDir, "permuter");
  await mkdir(permDir, { recursive: true });
  const inPath = path.join(permDir, "base.in.c");
  await writeFile(inPath, spliced);
  const inc = inv.compile.reduce((acc, a, i, arr) => { if (arr[i - 1] === "-I") acc.push("-I", a); return acc; }, []);
  const defs = inv.compile.filter((a) => /^-D/.test(a));
  const pp = await run("gcc", ["-E", "-P", "-nostdinc", "-fno-builtin", "-std=gnu89", "-x", "c", ...inc, "-I", path.dirname(project.abs(tuRel)), ...defs, "-D_LANGUAGE_C", "-DPERMUTER", "-D__attribute__(x)=", "-U__GNUC__", inPath], { cwd: project.root, env: project.env, timeoutMs: 60_000 });
  if (pp.code !== 0) throw Object.assign(new Error(`preprocessing the TU for the permuter failed: ${pp.stderr.slice(0, 800)}`), { code: "SEARCH_IMPORT_FAILED" });
  await writeFile(path.join(permDir, "base.c"), pp.stdout);
  try { fs.unlinkSync(inPath); } catch {}
  await copyFileSafe(target.targetO, path.join(permDir, "target.o"));
  // compile.sh: the IDO invocation from the captured argv (drop the asm-processor wrapper + assembler section).
  const argv = inv.compile;
  let cc = argv;
  const bp = argv.findIndex((a) => /asm-processor\/build\.py$/.test(a));
  if (bp >= 0) {
    const firstSep = argv.indexOf("--");
    const secondSep = argv.indexOf("--", firstSep + 1);
    const compiler = argv[firstSep - 1];
    cc = [compiler, ...argv.slice(secondSep + 1)];
  }
  const objRel = inv.object;
  const ccOut = cc.map((a) => (a === tuRel ? '"$INPUT"' : a === objRel ? '"$OUTPUT"' : shq(a)));
  const envLines = Object.entries(project.env).map(([k, v]) => `export ${k}=${shq(v)}`).join("\n");
  const sh = `#!/usr/bin/env bash\nset -euo pipefail\nINPUT="$(realpath "$1")"\nOUTPUT="$(realpath "$3")"\n${envLines}\ncd ${shq(project.root)}\n${ccOut.join(" ")}\n`;
  await writeFile(path.join(permDir, "compile.sh"), sh, { mode: 0o755 });
  const objdump = project.m.toolchain.objdump?.path ?? (project.m.toolchain.binutilsPrefix ?? "mips-linux-gnu-") + "objdump";
  const profile = profileFor(project.m.splatPlatform ?? project.m.platform);
  const compilerKind = project.m.toolchain?.compiler?.kind ?? "ido";
  const permuterType = profile.permuterTypeByCompiler[compilerKind] ?? "gcc";
  await writeFile(path.join(permDir, "settings.toml"), `func_name = "${fn.symbol}"\ncompiler_type = "${permuterType}"\nobjdump_command = "${objdump} --disassemble --reloc --disassemble-zeroes -Mreg-names=32 -Mno-aliases"\n`);
  await writeFile(path.join(jobDir, "import.log"), `base.c: preprocessed ${tuRel} with the candidate spliced at ${fn.symbol}\ncompile.sh: ${ccOut.join(" ")}\ntarget.o: ${target.targetO}\n`);
  return { permDir, importLog: path.join(jobDir, "import.log"), compile: ccOut.join(" ") };
}

function shq(s) { return /^[A-Za-z0-9_\/.=:+-]+$/.test(s) ? s : "'" + String(s).replace(/'/g, "'\\''") + "'"; }
async function copyFileSafe(src, dst) { const { copyFile } = await import("node:fs/promises"); await copyFile(src, dst); }

/**
 * Resolve a caller's seed to the BACKEND's grammar, or refuse it.
 *
 * decomp-permuter parses `--seed` as `map(int, s.split(","))`: one integer
 * (the RNG seed) or `permuterIndex,rngSeed`. A descriptive string like
 * `i5-schedule-rodata-297` passed argparse (type=str) and then crashed inside
 * the backend AFTER the job directory existed and the process had been
 * spawned — an orphan job and a stack trace instead of an error.
 *
 * Descriptive labels are genuinely useful, so rather than only refusing them
 * this maps one deterministically onto the backend's integer space: the same
 * string always yields the same seed, and the mapping is RETURNED so a run can
 * be reproduced exactly. A numeric seed is passed through untouched.
 *
 * @param {string|undefined|null} seed
 * @returns {{seed:string|null, resolved:string|null, from:string|null, mapping:string|null}}
 */
export function resolveSeed(seed) {
  if (seed == null || seed === "") return { seed: null, resolved: null, from: null, mapping: null };
  const raw = String(seed).trim();
  // The backend's own grammar: N or N,N (32-bit, non-negative).
  if (/^\d+(,\d+)?$/.test(raw)) {
    const parts = raw.split(",").map(Number);
    if (parts.some((n) => !Number.isSafeInteger(n) || n < 0 || n > 0xffffffff)) {
      throw Object.assign(new Error(`seed '${raw}': each part must be an integer in 0..4294967295. The backend parses --seed as 'rngSeed' or 'permuterIndex,rngSeed'.`), { code: "BAD_ARGS" });
    }
    return { seed: raw, resolved: raw, from: "numeric", mapping: null };
  }
  // A descriptive label: map it deterministically instead of refusing outright.
  if (/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(raw)) {
    const h = createHash("sha256").update(raw).digest();
    const n = h.readUInt32BE(0);
    return { seed: String(n), resolved: String(n), from: "label",
      mapping: `'${raw}' -> ${n} (sha256(label)[0..4) as a uint32; stable across runs and machines)` };
  }
  throw Object.assign(new Error(`seed '${raw}' is not usable. Supported: an integer ('297'), 'permuterIndex,rngSeed' ('0,297'), or a descriptive label matching [A-Za-z0-9][A-Za-z0-9._-]* which is mapped deterministically to an integer. The backend itself accepts ONLY integers, so an unmapped string crashes it.`), { code: "BAD_ARGS" });
}

/**
 * Start a search job.
 * @param {{project, fn, baseCandidateText, timeLimitS?:number, threads?:number, seed?:string, stopOnZero?:boolean, label?:string, resumeFrom?:string}} a
 */
export async function startSearch({ project, fn, baseCandidateText, timeLimitS = 300, threads = 2, seed, stopOnZero = true, label, resumeFrom, preflight = null }) {
  const t = toolPaths();
  // PREFLIGHT BEFORE SPENDING BUDGET.
  //
  // §9: a 300-second, eight-thread search returned no improvement after ~317
  // seconds. A search can only permute a base that COMPILES, and a base that
  // is already exact needs no search at all — both are answerable in one
  // compile, before committing minutes of CPU. The caller supplies the check;
  // this refuses to launch when it fails, because "budget exhausted" is a much
  // more expensive way to learn the same thing.
  if (preflight) {
    if (preflight.compileSucceeded === false) {
      throw Object.assign(new Error(`search preflight FAILED: the base candidate does not compile, so every mutation of it would also fail. Fix the diagnostics first — a search cannot permute a candidate the compiler rejects.${preflight.firstDiagnostic ? ` First error: ${preflight.firstDiagnostic}` : ""}`), { code: "PREFLIGHT_FAILED" });
    }
    if (preflight.exactFunctionMatch === true) {
      throw Object.assign(new Error("search preflight: the base candidate is ALREADY byte-exact. There is nothing to search for — verify it with decomp({op:'compare'}) and integrate it."), { code: "PREFLIGHT_ALREADY_EXACT" });
    }
  }
  // VALIDATE BEFORE ANYTHING EXISTS. This throws synchronously, so an invalid
  // seed cannot leave a job directory or a spawned process behind.
  const seedInfo = resolveSeed(seed);
  const jobId = `search-${fn.symbol}-${Date.now().toString(36)}${(counter++).toString(36)}`;
  const jobDir = path.join(jobsDir(project), jobId);
  await mkdir(jobDir, { recursive: true });
  const prep = await preparePermuterDir(project, fn, baseCandidateText, jobDir);
  const args = [path.join(t.permuter, "permuter.py"), prep.permDir, "-j", String(Math.max(1, threads)), "--quiet", ...(stopOnZero ? ["--stop-on-zero"] : []), ...(seedInfo.seed ? ["--seed", seedInfo.seed] : [])];
  const logPath = path.join(jobDir, "permuter.log");
  const out = fs.openSync(logPath, "a");
  const child = spawn("timeout", ["-s", "INT", "-k", "10", String(timeLimitS), t.python, ...args], { cwd: jobDir, env: { ...process.env, ...project.env, PYTHONUNBUFFERED: "1" }, detached: true, stdio: ["ignore", out, out] });
  child.unref();
  const rec = {
    jobId, project: project.id, function: { symbol: fn.symbol, segment: fn.segment, va: fn.vaHex }, label: label ?? null,
    status: "running", pid: child.pid, startedAt: new Date().toISOString(), timeLimitS, threads, seed: seedInfo.seed, seedRequested: seed ?? null, seedFrom: seedInfo.from, seedMapping: seedInfo.mapping, stopOnZero,
    resumeFrom: resumeFrom ?? null, baseCandidateSha256: sha256Text(baseCandidateText).slice(0, 16),
    ...(preflight ? { preflight: { compileSucceeded: preflight.compileSucceeded ?? null, strictMismatches: preflight.strictMismatches ?? null, linkedMismatches: preflight.linkedMismatches ?? null, exactFunctionMatch: preflight.exactFunctionMatch ?? null } } : {}),
    dir: jobDir, permuterDir: prep.permDir, log: logPath, importLog: prep.importLog,
    backend: { name: "decomp-permuter", commit: (await backendStatus()).permuter?.commit, argv: [t.python, ...args] },
    best: null,
  };
  await writeFile(path.join(jobDir, "base.c"), baseCandidateText);
  await writeFile(path.join(jobDir, "job.json"), JSON.stringify(rec, null, 2));
  child.on("exit", () => {});
  return rec;
}

/** Read a job record + derive live status from the log and output dirs. */
export async function jobStatus(project, jobId) {
  const jobDir = path.join(jobsDir(project), jobId);
  let rec;
  try { rec = JSON.parse(await readFile(path.join(jobDir, "job.json"), "utf8")); } catch { throw Object.assign(new Error(`no job '${jobId}' for project '${project.id}'`), { code: "JOB_NOT_FOUND" }); }
  const log = fs.existsSync(rec.log) ? await readFile(rec.log, "utf8") : "";
  const alive = rec.pid ? isAlive(rec.pid) : false;
  // Permuter lines: "base score = N", "found new best score! (N vs M)", "iteration K", "Found zero score!"
  const baseScore = Number(/base score\s*=\s*(\d+)/.exec(log)?.[1] ?? NaN);
  const bestHits = [...log.matchAll(/found (?:new best|a better) score!? \((\d+) vs (\d+)\)/g)].map((m) => Number(m[1]));
  const zero = /Found zero score/.test(log) || /score 0\b/.test(log) && /output-0-/.test(log);
  const errors = (log.match(/(Traceback|Error:|error:)/g) ?? []).length;
  // Best candidate on disk: output-<score>-<n>/source.c under the permuter dir.
  let best = null;
  try {
    const outs = (await readdir(rec.permuterDir)).filter((d) => /^output-(\d+)-\d+$/.test(d)).map((d) => ({ dir: d, score: Number(/^output-(\d+)-/.exec(d)[1]) })).sort((a, b) => a.score - b.score);
    if (outs.length) {
      const b = outs[0];
      const src = path.join(rec.permuterDir, b.dir, "source.c");
      best = { score: b.score, path: src, candidatesWritten: outs.length, sha256: fs.existsSync(src) ? sha256Text(await readFile(src, "utf8")).slice(0, 16) : null };
    }
  } catch {}
  let status = rec.status;
  if (status === "running" && !alive) status = zero ? "complete-zero" : "complete-budget";
  if (rec.cancelledAt) status = "cancelled";
  if (errors > 0 && !best && !alive) status = "failed";
  // A FINISHED job's elapsed time is endedAt - startedAt, not now - startedAt.
  //
  // This read `Date.now()` unconditionally, so a completed run's elapsed time
  // kept growing forever: four real jobs that ran 45-210 seconds
  // against minute-scale budgets reported ~9 DAYS, which reads as a runaway
  // permuter rather than a job that finished normally. `endedAt` was already
  // being recorded a few lines below — and note it is stamped AFTER this line,
  // so a job detected as finished on THIS call had no endedAt to use yet.
  // Stamp it first, then measure.
  if (!alive && !rec.endedAt && rec.status === "running") rec.endedAt = new Date().toISOString();
  const endMs = rec.endedAt ? Date.parse(rec.endedAt) : (rec.cancelledAt ? Date.parse(rec.cancelledAt) : Date.now());
  const elapsedS = Math.round((endMs - Date.parse(rec.startedAt)) / 1000);
  const derived = { ...rec, status, alive, elapsedS, baseScore: Number.isNaN(baseScore) ? null : baseScore, bestScoreSeen: bestHits.length ? Math.min(...bestHits) : null, improvements: bestHits.length, candidatesWritten: (log.match(/^wrote to /gm) ?? []).length, zeroFound: zero, errorLines: errors, best,
    logTail: log.split("\n").filter(Boolean).slice(-6), note: status === "complete-budget" ? "budget exhausted — NOT a match unless best.score is 0 and compare confirms exact" : status === "complete-zero" ? "the permuter found a zero-score candidate; run decomp({op:'compare'}) on best.path to confirm strict equality" : undefined };
  if (status !== rec.status || (best && JSON.stringify(best) !== JSON.stringify(rec.best))) {
    rec.status = status; rec.best = best; if (!alive && !rec.endedAt) rec.endedAt = derived.endedAt ?? new Date().toISOString();
    await writeFile(path.join(jobDir, "job.json"), JSON.stringify(rec, null, 2));
  }
  return derived;
}

export async function cancelJob(project, jobId) {
  const jobDir = path.join(jobsDir(project), jobId);
  const rec = JSON.parse(await readFile(path.join(jobDir, "job.json"), "utf8"));
  if (rec.pid && isAlive(rec.pid)) { try { process.kill(-rec.pid, "SIGINT"); } catch { try { process.kill(rec.pid, "SIGINT"); } catch {} } }
  rec.cancelledAt = new Date().toISOString(); rec.status = "cancelled";
  await writeFile(path.join(jobDir, "job.json"), JSON.stringify(rec, null, 2));
  return jobStatus(project, jobId);
}

export async function listJobs(project, symbol) {
  let ids = [];
  try { ids = await readdir(jobsDir(project)); } catch { return []; }
  const out = [];
  for (const id of ids) {
    try {
      const s = await jobStatus(project, id);
      if (symbol && s.function.symbol !== symbol) continue;
      // §11: after a restart a caller must be able to tell LIVE work from
      // terminal work "from authoritative process/job state", not from a
      // status field a dead process never got to update. `pid` is checked
      // against the OS; a record that still says "running" with no live
      // process is reported as abandoned rather than as work in progress.
      const live = s.pid ? isAlive(s.pid) : false;
      const lifecycle = live ? "live"
        : s.status === "running" ? "abandoned"
        : "terminal";
      out.push({ jobId: id, symbol: s.function.symbol, segment: s.function.segment ?? null,
        status: s.status, lifecycle, live, pid: s.pid ?? null,
        best: s.best?.score ?? null, bestPath: s.best?.path ?? null,
        elapsedS: s.elapsedS, startedAt: s.startedAt,
        ...(lifecycle === "abandoned" ? { abandonedNote: `the record says 'running' but pid ${s.pid} is not alive: the process died (a restart, an OOM kill, or a reboot) without updating its status. Its artifacts are still on disk and its best candidate is still usable; it will not make further progress.` } : {}) });
    } catch {}
  }
  return out.sort((a, b) => (a.startedAt < b.startedAt ? 1 : -1));
}

function isAlive(pid) { try { process.kill(pid, 0); return true; } catch { return false; } }

/** A durable report of one job: base, best, every score improvement with its time, timings, and where everything is. */
export async function jobReport(project, jobId) {
  const s = await jobStatus(project, jobId);
  const log = fs.existsSync(s.log) ? await readFile(s.log, "utf8") : "";
  const history = [...log.matchAll(/found (?:new best|a better) score!? \((\d+) vs (\d+)\)/g)].map((m, i) => ({ n: i + 1, score: Number(m[1]), previous: Number(m[2]) }));
  const outputs = fs.existsSync(s.permuterDir) ? (await readdir(s.permuterDir)).filter((d) => /^output-\d+-\d+$/.test(d)).length : 0;
  // WHAT THE BUDGET ACTUALLY BOUGHT.
  //
  // §9: a 300s/8-thread run returned no improvement and left an 8-line log.
  // "No improvement" is only actionable if you know what was tried, so the
  // accounting below is read from the backend's own output rather than
  // inferred. A field the log does not support is reported as null — an
  // invented count would be worse than an absent one.
  const iterations = Number(/(?:iteration|tried)\s+(\d+)/i.exec(log)?.[1] ?? NaN);
  const compileFails = (log.match(/compile (?:error|failed)/gi) ?? []).length;
  const permMacros = /No perm macros found/i.test(log);
  const baseSources = Number(/Will try (\d+) different base sources/i.exec(log)?.[1] ?? NaN);
  const accounting = {
    elapsedS: s.elapsedS, timeLimitS: s.timeLimitS, threads: s.threads,
    candidatesWritten: outputs,
    improvements: history.length,
    iterationsReported: Number.isFinite(iterations) ? iterations : null,
    compileFailures: compileFails || null,
    baseSources: Number.isFinite(baseSources) ? baseSources : null,
    mutationFamilies: permMacros ? "randomization only (no PERM macros in the base: the search explores random rewrites, not a declared family)" : "PERM macros present in the base",
    terminationReason: s.zeroFound ? "zero score found"
      : s.status === "complete-budget" ? `time budget of ${s.timeLimitS}s exhausted`
      : s.status === "running" ? "still running"
      : s.status,
    note: Number.isFinite(iterations) ? undefined
      : "the backend's log does not report an iteration count, so effective compilations and cache hits cannot be stated. They are null rather than guessed.",
  };
  const exhaustedNoImprovement = s.status === "complete-budget" && history.length === 0;
  const report = { jobId, project: project.id, function: s.function, label: s.label, status: s.status, startedAt: s.startedAt, endedAt: s.endedAt ?? null, elapsedS: s.elapsedS, timeLimitS: s.timeLimitS, threads: s.threads, seed: s.seed,
    ...(s.seedRequested && s.seedFrom === "label" ? { seedRequested: s.seedRequested, seedMapping: s.seedMapping } : {}),
    ...(s.preflight ? { preflight: s.preflight } : {}),
    baseCandidateSha256: s.baseCandidateSha256, baseScore: s.baseScore, best: s.best, improvements: history, candidatesWritten: outputs, zeroFound: s.zeroFound, resumeFrom: s.resumeFrom,
    accounting,
    backend: s.backend, artifacts: { dir: s.dir, permuterDir: s.permuterDir, log: s.log, importLog: s.importLog, base: path.join(s.dir, "base.c") },
    verdict: s.zeroFound ? "zero score found — run decomp({op:'compare'}) on best.path; the permuter's score is not the strict test" : s.status === "complete-budget" ? "budget exhausted — best is the closest candidate, not a match" : s.status,
    ...(exhaustedNoImprovement ? { recommendation: `${s.elapsedS}s of ${s.threads}-thread search produced NO improvement over base score ${s.baseScore}. ${permMacros ? "The base has no PERM macros, so this was undirected randomization — it cannot target a specific residual." : ""} Switch mechanism rather than re-running with a larger budget: diagnose the residual (decomp({op:'diagnose'})) to learn which groups exist, then test a bounded set of source levers (decomp({op:'variants'})). Re-running an exhausted undirected search explores the same space again.` } : {}) };
  const md = [`# search ${jobId}`, ``, `- function: ${s.function.symbol} (${s.function.segment} ${s.function.va})`, `- status: ${s.status} (${s.elapsedS}s of ${s.timeLimitS}s, ${s.threads} threads${s.seed ? ", seed " + s.seed : ""})`, `- base score: ${s.baseScore} → best: ${s.best?.score ?? "none"} (${outputs} candidates written, ${history.length} improvements)`, `- verdict: ${report.verdict}`, `- best candidate: ${s.best?.path ?? "none"}`, ``, `## improvements`, ...history.map((h) => `${h.n}. ${h.previous} → ${h.score}`), ``, `## artifacts`, `- ${s.dir}`, `- ${s.log}`].join("\n");
  await writeFile(path.join(s.dir, "report.json"), JSON.stringify(report, null, 2));
  await writeFile(path.join(s.dir, "report.md"), md);
  return { ...report, reportJson: path.join(s.dir, "report.json"), reportMd: path.join(s.dir, "report.md") };
}
