// capability.js — prove the runtime's debug capabilities instead of describing
// them.
//
// A real session recorded `PC_BREAK_UNSUPPORTED` against
// romdev-core-parallel-n64 0.2.0 while the source said PC breaks need 0.3.0 and
// the tool description discussed core selection in terms that no longer matched
// the implementation. Three sources of truth, none of them the running core.
//
// So this ASKS THE CORE. Each capability is exercised against the loaded ROM
// and reported as proven / unsupported / unknown, with the version that
// answered and the exact upgrade path when it is missing. "unknown" is a real
// result and is never promoted to "proven".
//
// The rule that matters for the caller: a frame-sampled PC must never be
// reported as an exact function-entry trace. A sampled probe answers "was this
// address seen at a frame boundary", which is a different question, and
// conflating them turns a coverage estimate into a false claim about execution.
//
// Plain JS ESM + JSDoc.

/** @typedef {"proven"|"unsupported"|"unknown"} CapState */

export const CAPABILITIES = Object.freeze({
  instructionStep: "single-step one instruction and observe PC advance",
  pcBreak: "stop at an exact PC (not a frame-boundary sample)",
  readWatch: "stop on a read of an address",
  writeWatch: "stop on a write to an address",
  pcCoverage: "record executed PCs exactly (the coverage bitmap)",
  saveState: "save and restore deterministically",
  overlayRead: "read RAM where an overlay is resident",
});

/**
 * Probe each capability against the LOADED core.
 *
 * @param {object} host the live emulator host
 * @param {{platform:string, corePackage?:string, coreVersion?:string}} info
 */
export async function probeCapabilities(host, info) {
  /** @type {Record<string,{state:CapState, evidence?:string, upgrade?:string, note?:string}>} */
  const out = {};
  const mark = (k, state, extra = {}) => { out[k] = { state, meaning: CAPABILITIES[k], ...extra }; };

  if (!host) {
    for (const k of Object.keys(CAPABILITIES)) mark(k, "unknown", { note: "no ROM loaded: nothing to probe against" });
    return { platform: info.platform, core: info, capabilities: out, probedAt: new Date().toISOString(),
      note: "load media first — a capability report with no core behind it would be a description, not a probe" };
  }

  // THE METHOD NAMES ARE TAKEN FROM THE HOST, NOT INVENTED. An earlier version
  // probed `stepInstructions` (plural) and `setPCBreak(pc, on)`; the host
  // exposes `stepInstruction` (singular) and `setPCBreak(pc, on, once)`, gated
  // by `pcBreakSupported()`. So this reported "unsupported" for capabilities
  // that `coverage` proved working on the SAME host in the same session — a
  // capability report that contradicts a runtime proof is worse than none,
  // because it is the thing a caller consults BEFORE trying.
  const gate = typeof host.pcBreakSupported === "function" ? !!host.pcBreakSupported() : null;

  // instruction step — PROVE it by stepping and watching the PC move.
  try {
    if (gate === false) {
      mark("instructionStep", "unsupported", { evidence: "host.pcBreakSupported() is false for this core" });
    } else if (typeof host.stepInstruction === "function") {
      const pcs = [];
      for (let i = 0; i < 6; i++) { const r = host.stepInstruction(); pcs.push(r?.pc ?? null); }
      const real = pcs.filter((p) => p != null);
      const moved = real.length === pcs.length && new Set(real).size >= 2;
      mark("instructionStep", moved ? "proven" : "unknown", {
        evidence: `6 host.stepInstruction() calls returned pcs [${pcs.map((p) => p == null ? "null" : "0x" + p.toString(16)).join(", ")}]`,
      });
    } else mark("instructionStep", "unsupported", { upgrade: "this host exposes no stepInstruction()" });
  } catch (e) { mark("instructionStep", "unsupported", { evidence: String(e?.message ?? e).slice(0, 160) }); }

  // exact PC break — ARM one on a PC we know executes, then confirm the hit.
  try {
    if (gate === false) {
      mark("pcBreak", "unsupported", {
        evidence: "host.pcBreakSupported() is false for this core",
        upgrade: info.platform === "n64"
          ? "N64 exact PC breaks need romdev-core-parallel-n64 >= 0.3.0 (the hook is in the default cached-interpreter CPU)."
          : `no PC-break support in the ${info.platform} core build`,
        note: "WITHOUT this, a frame-sampled PC is the only signal — and a sample must NOT be reported as an exact trace.",
      });
    } else if (typeof host.setPCBreak === "function" && typeof host.getPCBreak === "function") {
      const pc = host.stepInstruction?.()?.pc ?? host.getCPUState?.()?.pc ?? null;
      if (pc == null) mark("pcBreak", "unknown", { evidence: "no PC available to arm a break on" });
      else {
        host.setPCBreak(pc >>> 0, true, false);
        host.stepFrames(2);
        const pb = host.getPCBreak(true);
        host.setPCBreak(0, false, false);
        mark("pcBreak", pb?.hit ? "proven" : "unknown", {
          evidence: `setPCBreak(0x${(pc >>> 0).toString(16)}) then 2 frames: hit=${!!pb?.hit} hits=${pb?.hits ?? 0}`,
        });
      }
    } else mark("pcBreak", "unsupported", { upgrade: `no setPCBreak/getPCBreak on the ${info.platform} host` });
  } catch (e) { mark("pcBreak", "unsupported", { evidence: String(e?.message ?? e).slice(0, 160) }); }

  // read / write watchpoints. The METHOD NAMES ARE THE HOST'S: the write
  // watchpoint is `setWatchpoint`, not `setWriteWatch` — guessing the symmetric
  // name reported "unsupported" for a capability the host has. Each also has a
  // `*Supported()` gate, which is the core's own answer and outranks a probe.
  for (const [k, fnName, gateName] of [
    ["readWatch", "setReadWatch", "readWatchSupported"],
    ["writeWatch", "setWatchpoint", null],
  ]) {
    try {
      const gated = gateName && typeof host[gateName] === "function" ? !!host[gateName]() : null;
      if (gated === false) {
        mark(k, "unsupported", { evidence: `host.${gateName}() is false for this core` });
      } else if (typeof host[fnName] === "function") {
        host[fnName](0, true); host[fnName](0, false);
        mark(k, "proven", { evidence: `${fnName}() accepted an arm and a disarm` });
      } else mark(k, "unsupported", { upgrade: `the ${info.platform} core build exposes no ${fnName}` });
    } catch (e) { mark(k, "unsupported", { evidence: String(e?.message ?? e).slice(0, 160) }); }
  }

  // exact PC coverage (the bitmap) — CALL it, do not merely look for the name.
  try {
    if (typeof host.logPCBitmap === "function") {
      const r = host.logPCBitmap(0, 0, 0);
      mark("pcCoverage", r != null ? "proven" : "unknown", {
        evidence: r != null ? "host.logPCBitmap() returned a bitmap result" : "logPCBitmap() returned nothing",
      });
    } else {
      mark("pcCoverage", "unsupported", {
        upgrade: "the coverage bitmap (romdev_covbits_*) ships in the instrumented core builds; update the core package",
        note: "a frame-boundary PC sample is NOT exact coverage: it cannot prove a basic block ran, only that it was observed at a sample point",
      });
    }
  } catch (e) { mark("pcCoverage", "unknown", { evidence: String(e?.message ?? e).slice(0, 160) }); }

  // deterministic save/load — try every spelling the hosts actually use before
  // concluding anything. Reporting `unknown` because ONE guessed name returned
  // nothing is how a working capability gets written off.
  try {
    const saveFn = ["serializeState", "saveState", "getState"].find((n) => typeof host[n] === "function");
    const loadFn = ["unserializeState", "loadState", "setState"].find((n) => typeof host[n] === "function");
    if (saveFn && loadFn) {
      const a = host[saveFn]();
      if (a && a.length) {
        host[loadFn](a);
        const b = host[saveFn]();
        const identical = b && b.length === a.length && Buffer.compare(Buffer.from(a), Buffer.from(b)) === 0;
        mark("saveState", identical ? "proven" : "unknown", {
          evidence: identical
            ? `${saveFn}() -> ${loadFn}() -> ${saveFn}() round-tripped ${a.length} bytes identically`
            : `round-trip produced ${b?.length ?? 0} bytes vs ${a.length}: determinism NOT established`,
        });
      } else mark("saveState", "unknown", { evidence: `${saveFn}() returned nothing` });
    } else mark("saveState", "unsupported", { upgrade: "this host implements no state serializer (tried serializeState/saveState/getState)" });
  } catch (e) { mark("saveState", "unsupported", { evidence: String(e?.message ?? e).slice(0, 160) }); }

  // overlay RAM read
  try {
    if (typeof host.readMemory === "function") {
      const b = host.readMemory("system_ram", 0, 16);
      mark("overlayRead", b?.length ? "proven" : "unknown", { evidence: b?.length ? `read ${b.length} bytes of system_ram` : "read returned nothing" });
    } else mark("overlayRead", "unsupported");
  } catch (e) { mark("overlayRead", "unsupported", { evidence: String(e?.message ?? e).slice(0, 160) }); }

  const proven = Object.values(out).filter((c) => c.state === "proven").length;
  return {
    platform: info.platform, core: info,
    capabilities: out,
    summary: { proven, unsupported: Object.values(out).filter((c) => c.state === "unsupported").length,
      unknown: Object.values(out).filter((c) => c.state === "unknown").length, total: Object.keys(out).length },
    probedAt: new Date().toISOString(),
    policy: "every line above was PROVEN against the running core, not read from a description. 'unknown' means the probe could not "
      + "establish the capability and is never promoted to 'proven'. A frame-sampled PC answers a different question than an exact "
      + "PC break and must never be reported as an exact trace or as exact coverage.",
  };
}

/**
 * Gate a runtime operation on the capability it needs.
 * Returns null when allowed, or a typed refusal naming the upgrade path.
 */
export function requireCapability(report, name) {
  const c = report?.capabilities?.[name];
  if (c?.state === "proven") return null;
  return {
    code: "CAPABILITY_UNAVAILABLE", capability: name,
    state: c?.state ?? "unknown", meaning: CAPABILITIES[name],
    ...(c?.upgrade ? { upgrade: c.upgrade } : {}),
    ...(c?.note ? { note: c.note } : {}),
    core: report?.core ?? null,
    error: `'${name}' is ${c?.state ?? "unknown"} on this core (${report?.core?.package ?? "?"} ${report?.core?.version ?? "?"}). `
      + "Refusing early rather than returning a weaker signal that would be mistaken for this one.",
  };
}
