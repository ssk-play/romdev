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

  // instruction step
  try {
    const before = host.status?.frameCount ?? null;
    if (typeof host.stepInstructions === "function") {
      host.stepInstructions(1);
      mark("instructionStep", "proven", { evidence: `stepInstructions(1) returned; frameCount ${before} -> ${host.status?.frameCount}` });
    } else mark("instructionStep", "unsupported", { upgrade: "the host exposes no stepInstructions(); frame stepping is the only granularity here" });
  } catch (e) { mark("instructionStep", "unsupported", { evidence: String(e?.message ?? e).slice(0, 160) }); }

  // exact PC break
  try {
    if (typeof host.setPCBreak === "function") {
      const pc = host.getCPUState?.()?.pc ?? null;
      host.setPCBreak(pc ?? 0, true);
      host.setPCBreak(pc ?? 0, false);
      mark("pcBreak", "proven", { evidence: "setPCBreak() accepted an arm and a disarm" });
    } else {
      mark("pcBreak", "unsupported", {
        upgrade: info.platform === "n64"
          ? "N64 exact PC breaks need romdev-core-parallel-n64 >= 0.3.0 (the hook lives in the default cached-interpreter CPU; no core option is needed). Check the version reported here against the installed package."
          : `no setPCBreak on the ${info.platform} host`,
        note: "WITHOUT this, a frame-sampled PC is the only signal available — and a sample must NOT be reported as an exact trace. It answers a different question.",
      });
    }
  } catch (e) { mark("pcBreak", "unsupported", { evidence: String(e?.message ?? e).slice(0, 160) }); }

  // read / write watchpoints
  for (const [k, fnName] of [["readWatch", "setReadWatch"], ["writeWatch", "setWriteWatch"]]) {
    try {
      if (typeof host[fnName] === "function") {
        host[fnName](0, true); host[fnName](0, false);
        mark(k, "proven", { evidence: `${fnName}() accepted an arm and a disarm` });
      } else mark(k, "unsupported", { upgrade: `the ${info.platform} core build exposes no ${fnName}` });
    } catch (e) { mark(k, "unsupported", { evidence: String(e?.message ?? e).slice(0, 160) }); }
  }

  // exact PC coverage (the bitmap)
  try {
    if (typeof host.logPCBitmap === "function" || typeof host.getCoverageBitmap === "function") {
      mark("pcCoverage", "proven", { evidence: "the core exports the PC coverage bitmap" });
    } else {
      mark("pcCoverage", "unsupported", {
        upgrade: "the coverage bitmap (romdev_covbits_*) ships in the instrumented core builds; update the core package",
        note: "a frame-boundary PC sample is NOT exact coverage: it cannot prove a basic block ran, only that it was observed at a sample point",
      });
    }
  } catch { mark("pcCoverage", "unknown"); }

  // deterministic save/load
  try {
    if (typeof host.saveState === "function" && typeof host.loadState === "function") {
      const a = host.saveState();
      if (a && a.length) {
        host.loadState(a);
        const b = host.saveState();
        const identical = b && b.length === a.length && Buffer.compare(Buffer.from(a), Buffer.from(b)) === 0;
        mark("saveState", identical ? "proven" : "unknown", {
          evidence: identical ? `save -> load -> save round-tripped ${a.length} bytes identically`
            : `round-trip produced ${b?.length ?? 0} bytes vs ${a.length}: not byte-identical, so determinism is NOT established`,
        });
      } else mark("saveState", "unknown", { evidence: "saveState() returned nothing" });
    } else mark("saveState", "unsupported", { upgrade: "this host implements no serializeState/saveState" });
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
