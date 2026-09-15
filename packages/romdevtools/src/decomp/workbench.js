// workbench.js — the bridge to n64-decomp-workbench.
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
// workbench can grow without romdev being edited — and so a command's own
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

/** Run one workbench command. Never throws on exit 1 — that is an answer. */
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
    // Exit 1 is "gate/no-result" — a real answer, not a failure. Reporting it
    // as an error is how a legitimate "no" becomes a fake problem.
    ok: r.code === 0 || r.code === 1,
    isGate: r.code === 1,
    report: r.json,
    ...(r.json ? {} : { stdout: r.stdout.slice(0, 4000) }),
    ...(r.stderr ? { stderr: r.stderr.slice(0, 2000) } : {}),
    argv: r.argv,
  };
}
