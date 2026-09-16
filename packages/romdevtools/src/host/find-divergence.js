// Cross-runtime observation, shared by the existing frame tool. Equal RAM is
// scoped evidence, never proof that an arbitrary recompiler is correct.
function regionReader(host, region, offset, length) {
  const wasm = host.status?.platform === "wasmcart";
  if (wasm && region !== "linear_memory") throw new Error("wasmcart comparisons require regionB:'linear_memory' and the recompiled RAM's offsetB; a WASM heap is not SMS system_ram");
  const size = wasm ? host.wasmMemorySize() : host.regionSize?.(region) ?? 0;
  if (!size || offset < 0 || length < 1 || offset + length > size) throw new Error(`comparison range ${region}+${offset}:${length} exceeds available ${size} bytes`);
  return () => {
    const bytes = wasm ? host.readMemory(offset, length) : host.readMemory(region, offset, length);
    if (bytes.length !== length) throw new Error(`short comparison read: expected ${length}, got ${bytes.length}`);
    return Uint8Array.from(bytes);
  };
}

export function findDivergence(hostA, hostB, { region = "system_ram", regionB = region, offsetA = 0, offsetB = 0,
  compareLength, maxFrames = 600, restore = true } = {}) {
  const sizeA = hostA.status?.platform === "wasmcart" ? hostA.wasmMemorySize() : hostA.regionSize?.(region) ?? 0;
  const sizeB = hostB.status?.platform === "wasmcart" ? hostB.wasmMemorySize() : hostB.regionSize?.(regionB) ?? 0;
  if (hostB.status?.platform === "wasmcart" && compareLength == null) throw new Error("wasmcart findDiverge requires compareLength: explicitly select the emulated RAM, not the entire heap");
  const length = compareLength ?? Math.min(sizeA - offsetA, sizeB - offsetB);
  const readA = regionReader(hostA, region, offsetA, length), readB = regionReader(hostB, regionB, offsetB, length);
  if (restore && [hostA, hostB].some((h) => typeof h.serializeState !== "function" || typeof h.unserializeState !== "function")) {
    throw new Error("one runtime cannot serialize its full machine state; pass restore:false to explicitly allow advancing BOTH comparison slots. Copying WASM linear memory alone is not a valid VM checkpoint.");
  }
  const saveA = restore ? hostA.serializeState() : null, saveB = restore ? hostB.serializeState() : null;
  const initialA = readA(), initialB = readB();
  let previousA = initialA, previousB = initialB, changedFramesA = 0, changedFramesB = 0, framesStepped = 0;
  let result, primaryError;
  const diff = (a, b) => { for (let i = 0; i < length; i++) if (a[i] !== b[i]) return { offset: i, a: a[i], b: b[i] }; return null; };
  try {
    let first = diff(initialA, initialB);
    if (first) result = { diverged: true, atFrame: 0, ...first };
    for (let f = 1; !result && f <= maxFrames; f++) {
      const fa = hostA.status.frameCount, fb = hostB.status.frameCount;
      hostA.stepFrames(1); hostB.stepFrames(1); framesStepped = f;
      if (!Number.isFinite(fa) || !Number.isFinite(fb) || hostA.status.frameCount <= fa || hostB.status.frameCount <= fb) throw new Error("comparison host did not advance a frame (paused/stalled); no valid lockstep result");
      const a = readA(), b = readB();
      if (diff(a, previousA)) changedFramesA++;
      if (diff(b, previousB)) changedFramesB++;
      previousA = a; previousB = b;
      first = diff(a, b);
      if (first) result = { diverged: true, atFrame: f, ...first };
    }
    result ??= { diverged: false };
  } catch (e) { primaryError = e; }
  const restoration = { requested: restore, a: restore ? "pending" : "not-requested", b: restore ? "pending" : "not-requested" };
  if (restore) {
    for (const [side, host, state] of [["a", hostA, saveA], ["b", hostB, saveB]]) {
      try { host.unserializeState(state); restoration[side] = "restored"; }
      catch (e) { restoration[side] = `failed: ${e.message}`; primaryError ??= new Error(`failed to restore slot ${side}: ${e.message}`); }
    }
  }
  if (primaryError) throw Object.assign(primaryError, { restoration });
  // A frame-0 divergence returns BEFORE the stepping loop, so changedFramesA/B
  // are structurally 0 — not an observation that the slots sat still. Reporting
  // them undecorated made a caller read "slot B never executes a frame" off a
  // result that never asked slot B to execute one. Say which it is.
  const steppedAtAll = framesStepped > 0;
  const meaningfulActivity = steppedAtAll && changedFramesA > 0 && changedFramesB > 0;
  return { op: "findDiverge", ...result, framesStepped, comparedBytes: length,
    a: result.diverged ? result.a : { platform: hostA.status.platform },
    b: result.diverged ? result.b : { platform: hostB.status.platform },
    slots: { a: { platform: hostA.status.platform, region, offset: offsetA },
      b: { platform: hostB.status.platform, region: regionB, offset: offsetB } },
    ...(result.offset != null ? { valueA: result.a, valueB: result.b,
      address: "$" + result.offset.toString(16).toUpperCase().padStart(4, "0"),
      addressA: offsetA + result.offset, addressB: offsetB + result.offset } : {}),
    activity: { changedFramesA, changedFramesB, meaningfulActivity, framesStepped,
      ...(steppedAtAll ? {} : { activityNote: "No frames were stepped, so changedFramesA/B are 0 by construction and say NOTHING about whether either slot executes. The comparison ended before the stepping loop (the slots already differed at frame 0). To test whether a slot advances, step it directly: frame({op:'step', slot:'b'})." }) },
    restoration,
    conclusion: result.diverged ? "diverged" : meaningfulActivity ? "no-observed-divergence" : "inconclusive-no-observed-memory-activity",
    note: result.diverged ? `First divergence at frame ${result.atFrame} in the selected memory.${result.atFrame === 0 ? " The slots differed BEFORE any frame was stepped, so this is a difference in starting state, not an execution divergence — warm each side to a common point with frame({op:'step', slot:'a'|'b'}) and compare from there. Note that an emulator slot is NOT at hardware power-on after loadMedia: warm-up frames ran during load (loadMedia reports settleFrames) and the game's boot code has already written RAM, so a starting-state difference here is expected rather than a finding about either side." : ""} This localizes an observation, not its cause.`
      : meaningfulActivity ? "Selected memory agreed at each sampled frame and changed during execution. This does not prove whole-program equivalence or instruction-level lockstep."
        : "Selected memory remained unchanged on one or both sides. An idle/spin loop can produce this result; it is NOT a successful verification of the recompiled game." };
}
