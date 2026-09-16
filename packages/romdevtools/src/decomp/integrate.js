// integrate.js - turn an exact candidate into a reviewable source patch, apply
// it, run the project's full build, and verify the ROM byte-for-byte. Any
// failure restores the original TU. The patch file is written whether or not
// it is applied, so a human can review it as a diff.
import { readFile, writeFile, mkdir, copyFile } from "node:fs/promises";
import fs from "node:fs";
import path from "node:path";
import { run } from "./mips-obj.js";
import { spliceFunction } from "./compile.js";
import { sha1File, sha256Text } from "./project.js";

/**
 * @param {import('./project.js').Project} project
 * @param {object} fn resolved function
 * @param {{candidateText:string, apply:boolean, verify:boolean, jobs?:number, declarations?:string}} opts
 */
export async function integrateCandidate(project, fn, { candidateText, apply = false, verify = true, jobs = 8, declarations }) {
  const tuRel = fn.source?.tu;
  if (!tuRel) throw Object.assign(new Error(`function '${fn.symbol}' is not in any TU`), { code: "FUNCTION_NOT_IN_TU" });
  const tuAbs = project.abs(tuRel);
  const original = await readFile(tuAbs, "utf8");
  let text = candidateText;
  if (declarations) text = declarations.replace(/\s*$/, "\n\n") + text;
  const spliced = spliceFunction(original, fn.symbol, text);
  const dir = path.join(project.ws, "patches");
  await mkdir(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const newPath = path.join(dir, `${fn.symbol}.${stamp}.c`);
  await writeFile(newPath, spliced.text);
  const patchPath = path.join(dir, `${fn.symbol}.${stamp}.patch`);
  const d = await run("diff", ["-u", "--label", `a/${tuRel}`, "--label", `b/${tuRel}`, tuAbs, newPath], { cwd: project.root });
  await writeFile(patchPath, d.stdout);
  const result = { function: fn.symbol, tu: tuRel, replaced: spliced.replaced, atLine: spliced.line, patch: patchPath, patchLines: d.stdout.split("\n").length, applied: false, verification: { fullRom: "not-run" } };
  if (!apply) { result.note = "patch written, NOT applied (apply:true to write the TU and verify the full ROM)"; return result; }
  const backup = path.join(dir, `${fn.symbol}.${stamp}.orig.c`);
  await copyFile(tuAbs, backup);
  await writeFile(tuAbs, spliced.text);
  result.applied = true; result.backup = backup;
  if (!verify) { result.note = "applied WITHOUT full-ROM verification (verify:true to build + compare)"; return result; }
  const v = await fullRomVerify(project, { jobs });
  result.verification = { fullRom: v.ok ? "byte-exact" : "MISMATCH", ...v };
  if (!v.ok) {
    await writeFile(tuAbs, original);
    result.applied = false; result.revertedTo = backup;
    result.note = "full build did not reproduce the base ROM - the TU was RESTORED to its original text; the patch file remains for inspection";
  } else result.note = "applied and the full rebuilt ROM is byte-exact with the base ROM";

  // DURABLE PROOF BUNDLE. §11: a recovery must stay auditable "after restarts
  // and later edits". Everything needed to re-check this integration without
  // trusting the current tree is written to ONE immutable file, including the
  // pointers to the patch, the pre-integration owner, and the build log that
  // is no longer overwritten by the next build.
  try {
    const bundleDir = path.join(project.ws, "proofs");
    await mkdir(bundleDir, { recursive: true });
    const bundlePath = path.join(bundleDir, `${fn.symbol}.${stamp}.proof.json`);
    const bundle = {
      schema: "romdev-decomp-integration-proof-v1",
      recordedAt: new Date().toISOString(),
      project: project.id,
      // Exact target identity: a symbol name alone does not identify a
      // function where overlays share a VA.
      target: { symbol: fn.symbol, segment: fn.segment ?? null, va: fn.vaHex ?? null,
        tu: tuRel, object: fn.object ?? null, sizeBytes: fn.sizeBytes ?? null,
        romOffset: fn.romOffsetHex ?? null },
      source: {
        patch: patchPath, spliced: newPath, preIntegrationOwner: backup,
        ownerSha256Before: sha256Text(original).slice(0, 16),
        ownerSha256After: sha256Text(spliced.text).slice(0, 16),
        candidateSha256: sha256Text(candidateText).slice(0, 16),
        declarations: declarations ? sha256Text(declarations).slice(0, 16) : null,
        replaced: spliced.replaced, atLine: spliced.line,
      },
      toolchain: {
        compiler: project.m.toolchain?.compiler ?? null,
        buildCommand: project.m.build?.command ?? null,
      },
      build: {
        command: v.command ?? null, exit: v.buildExit ?? null, ms: v.buildMs ?? null,
        log: v.log ?? null, logIsImmutable: v.logIsImmutable === true,
      },
      rom: { baseSha1: v.baseSha1 ?? project.m.rom?.sha1 ?? null, builtSha1: v.builtSha1 ?? null,
        byteExact: v.ok === true, builtRom: v.builtRom ?? null },
      outcome: result.applied ? "integrated" : "reverted",
      contribution: "this bundle records ONE function's integration. Completion counts move for many reasons; do not read a project-wide percentage as this operation's contribution.",
      caveat: "byte-exactness is not source-quality approval. Type-view caveats recorded during the work (pointer casts, one-element arrays, payload aliasing) remain open questions even when the ROM matches.",
    };
    await writeFile(bundlePath, JSON.stringify(bundle, null, 2));
    result.proof = bundlePath;
  } catch (e) {
    // A bundle that cannot be written must not fail an integration that
    // already succeeded - but the caller has to know the proof is missing.
    result.proofError = `the integration completed but its proof bundle could not be written: ${String(e?.message ?? e).slice(0, 160)}`;
  }
  return result;
}

/** Run the project's build and compare the built ROM with the base ROM. */
export async function fullRomVerify(project, { jobs = 8 } = {}) {
  const cmd = project.m.build.command;
  const t0 = Date.now();
  const r = await run(cmd[0], [...cmd.slice(1), `-j${jobs}`], { cwd: project.root, env: project.env, timeoutMs: 900_000 });
  const ms = Date.now() - t0;
  const built = project.m.built?.rom ? project.abs(project.m.built.rom) : null;
  // IMMUTABLE BUILD LOGS. §11: "Keep build logs under immutable
  // per-integration paths rather than relying only on `last-build.log`.
  // Successful recovery should not become unverifiable when another build
  // runs." Every build gets its own timestamped file; `last-build.log` remains
  // as a convenience pointer to the newest one.
  const logDir = path.join(project.ws, "builds");
  await mkdir(logDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const logPath = path.join(logDir, `build-${stamp}.log`);
  const body = `$ ${cmd.join(" ")} -j${jobs}\nexit=${r.code}\n${r.stdout}\n${r.stderr}`;
  await writeFile(logPath, body);
  await mkdir(project.ws, { recursive: true });
  await writeFile(path.join(project.ws, "last-build.log"), body);
  const common = { buildExit: r.code, buildMs: ms, log: logPath, logIsImmutable: true,
    command: [...cmd, `-j${jobs}`] };
  if (r.code !== 0) return { ok: false, ...common, tail: (r.stdout + r.stderr).split("\n").filter(Boolean).slice(-8) };
  if (!built || !fs.existsSync(built)) return { ok: false, ...common, error: `built ROM not found at ${built}` };
  const sha = await sha1File(built);
  return { ok: sha === project.m.rom.sha1, ...common, builtSha1: sha, baseSha1: project.m.rom.sha1, builtRom: project.m.built.rom };
}
