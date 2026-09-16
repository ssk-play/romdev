import { test } from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";
import { findDivergence } from "../src/host/find-divergence.js";
import { registerLifecycleTools } from "../src/mcp/tools/lifecycle.js";
import { registerFrameTools } from "../src/mcp/tools/frame.js";
import { getHostB, clearHostB, _setHostForTest, _setHostBForTest, getHost, clearHost } from "../src/mcp/state.js";

function host({ wasm = false, increment = 1, fail = false } = {}) {
  const memory = new Uint8Array(32);
  const h = { status: { platform: wasm ? "wasmcart" : "sms", frameCount: 0 },
    regionSize: () => 32, wasmMemorySize: () => 32,
    readMemory: (...args) => { const [o, n] = wasm ? args : args.slice(1); return memory.slice(o, o + n); },
    stepFrames: (n = 1) => { for (let i = 0; i < n; i++) { h.status.frameCount++; if (fail) throw new Error("runtime failure"); memory[8] += increment; } return n; },
    memory };
  if (!wasm) Object.assign(h, { serializeState: () => memory.slice(), unserializeState: (s) => memory.set(s) });
  return h;
}
const opts = { regionB: "linear_memory", offsetA: 8, offsetB: 8, compareLength: 1, restore: false, maxFrames: 3 };

test("SMS versus WASM mapped memory: real activity and first mismatch are separate conclusions", () => {
  const equal = findDivergence(host(), host({ wasm: true }), opts);
  assert.equal(equal.conclusion, "no-observed-divergence");
  assert.equal(equal.activity.changedFramesB, 3);
  const diff = findDivergence(host(), host({ wasm: true, increment: 2 }), opts);
  assert.equal(diff.atFrame, 1); assert.equal(diff.valueA, 1); assert.equal(diff.valueB, 2);
  assert.equal(diff.addressB, 8);
});

test("matching idle/spin-loop memory is inconclusive, not a verification pass", () => {
  const r = findDivergence(host({ increment: 0 }), host({ wasm: true, increment: 0 }), opts);
  assert.equal(r.diverged, false);
  assert.equal(r.conclusion, "inconclusive-no-observed-memory-activity");
});

test("WASM requires explicit mapping and authority to advance unsnapshotable state", () => {
  assert.throws(() => findDivergence(host(), host({ wasm: true }), { ...opts, compareLength: undefined }), /compareLength/);
  assert.throws(() => findDivergence(host(), host({ wasm: true }), { ...opts, regionB: "system_ram" }), /linear_memory/);
  assert.throws(() => findDivergence(host(), host({ wasm: true }), { ...opts, restore: true }), /restore:false/);
});

test("emulator states restore even if stepping throws", () => {
  const a = host(), b = host({ fail: true });
  assert.throws(() => findDivergence(a, b, { maxFrames: 2 }), /runtime failure/);
  assert.equal(a.memory[8], 0); assert.equal(b.memory[8], 0);
});

test("actual wasmcart loads in slot B without replacing the session's primary host", async () => {
  const key = "wasmcart-slot-b-regression", tools = {};
  const primary = host(); _setHostForTest(key, primary);
  registerLifecycleTools({ tool: (n, _d, _s, h) => { tools[n] = h; } }, z, key);
  try {
    const r = await tools.loadMedia({ platform: "wasmcart", path: new URL("./fixtures/dbghello.wasc", import.meta.url).pathname, slot: "b" });
    assert.notEqual(r.isError, true, JSON.stringify(r));
    assert.equal(getHost(key), primary);
    const b = getHostB(key); assert.equal(b.status.platform, "wasmcart");
    const frame = b.status.frameCount; b.stepFrames(1); assert.equal(b.status.frameCount, frame + 1);
    assert.ok(b.wasmMemorySize() > 0);
  } finally { clearHostB(key); clearHost(key); }
});

// A frame-0 divergence returns BEFORE the stepping loop. changedFramesA/B are
// then 0 by construction, and a client read that as "slot B never executes a
// frame" - filing a frozen-slot-B bug against a run that never asked slot B to
// step. The counts must not be presentable as an observation about execution.
test("zero-frame comparison labels its activity counts as structural, not observed", () => {
  // Pre-diverged at frame 0: B's byte 8 starts at 9, A's at 0.
  const a = host(), b = host({ wasm: true });
  b.memory[8] = 9;
  const r = findDivergence(a, b, opts);
  assert.equal(r.atFrame, 0);
  assert.equal(r.framesStepped, 0);
  assert.equal(r.activity.changedFramesA, 0);
  assert.equal(r.activity.changedFramesB, 0);
  // The disclosure is the whole point: the counts are 0 because nothing ran.
  assert.match(r.activity.activityNote, /NOTHING about whether either slot executes/);
  assert.match(r.activity.activityNote, /step.*slot.*b/s);
  assert.equal(r.activity.framesStepped, 0);
  // And the note must not let a frame-0 result read as an execution divergence.
  assert.match(r.note, /BEFORE any frame was stepped/);
  assert.match(r.note, /difference in starting state/);
});

test("a comparison that actually stepped carries no structural-zero disclaimer", () => {
  const r = findDivergence(host(), host({ wasm: true }), opts);
  assert.equal(r.framesStepped, 3);
  assert.equal(r.activity.framesStepped, 3);
  assert.equal(r.activity.activityNote, undefined);
  assert.doesNotMatch(r.note ?? "", /BEFORE any frame was stepped/);
});

// meaningfulActivity gates the "this is a real verification" conclusion. It must
// be gated on framesStepped, not merely on the counters: a host whose counters
// read nonzero without the loop having run must still not claim activity.
// (Asserting it on the plain frame-0 case passes with OR without the gate - the
// counters are 0 there anyway - so that assertion proves nothing. This one
// forces the counters high and checks the gate alone holds the line.)
test("meaningfulActivity is gated on frames actually stepped, not on the counters", () => {
  // A host that reports a rising frameCount and mutating memory the instant it
  // is read, so any counter-only check would see "activity" without a loop.
  const liar = (wasm) => {
    const memory = new Uint8Array(32);
    let n = 0;
    return { status: { platform: wasm ? "wasmcart" : "sms", frameCount: 0 },
      regionSize: () => 32, wasmMemorySize: () => 32,
      readMemory: (...args) => { const [o, len] = wasm ? args : args.slice(1); memory[8] = ++n; return memory.slice(o, o + len); },
      stepFrames: () => { throw new Error("must not be reached"); },
      memory };
  };
  const a = liar(false), b = liar(true);
  b.memory[8] = 200; // differ at frame 0 -> return before the stepping loop
  const r = findDivergence(a, b, { ...opts, maxFrames: 0 });
  assert.equal(r.framesStepped, 0);
  assert.equal(r.activity.meaningfulActivity, false, "no frames ran, so nothing was observed");
  assert.ok(r.activity.activityNote, "a zero-frame result must disclose why its counts are 0");
});

// Slot B had no way to advance: frame({op:'step'}) was slot-A-only, so a caller
// comparing a cart that only diverges deep into a run could never warm slot B
// past its power-on state. Every comparison was against frame 0.
test("frame({op:'step', slot:'b'}) advances the comparison host, not the primary", async () => {
  const key = "frame-step-slot-b", tools = {};
  const primary = host(), secondary = host({ wasm: true });
  _setHostForTest(key, primary);
  _setHostBForTest(key, secondary);
  registerFrameTools({ tool: (n, _d, _s, h) => { tools[n] = h; } }, z, key);
  try {
    const before = { a: primary.status.frameCount, b: secondary.status.frameCount };
    const res = await tools.frame({ op: "step", slot: "b", frames: 5 });
    const out = JSON.parse(res.content[0].text);
    assert.equal(out.slot, "b");
    assert.equal(out.framesRun, 5, "reports the frames it actually ran");
    // Slot B moved by exactly the requested amount; slot A did NOT move at all.
    assert.equal(secondary.status.frameCount, before.b + 5, "slot B must advance");
    assert.equal(primary.status.frameCount, before.a, "slot A must be untouched");
    assert.equal(out.frameCount, secondary.status.frameCount);
  } finally { clearHostB(key); clearHost(key); }
});

test("frame({op:'step'}) still defaults to slot A", async () => {
  const key = "frame-step-slot-a-default", tools = {};
  const primary = host(), secondary = host({ wasm: true });
  _setHostForTest(key, primary);
  _setHostBForTest(key, secondary);
  registerFrameTools({ tool: (n, _d, _s, h) => { tools[n] = h; } }, z, key);
  try {
    const beforeB = secondary.status.frameCount;
    await tools.frame({ op: "step", frames: 3 });
    assert.equal(primary.status.frameCount, 3, "slot A advances by default");
    assert.equal(secondary.status.frameCount, beforeB, "slot B must not move");
  } finally { clearHostB(key); clearHost(key); }
});

// loadMedia runs uncounted warm-up frames to resolve framebuffer geometry, so
// frameCount:0 does NOT mean "nothing executed" - the game's boot code has run
// and written RAM. A client read the resulting RAM as a hardware power-on
// pattern and concluded it was cart-dependent. Measured with the settle loop
// suppressed, every cart tested reads the SAME byte at system_ram[0]; the
// apparent split was entirely what each game had overwritten by then.
test("a frame-0 divergence says an emulator slot is not at hardware power-on", () => {
  const a = host(), b = host({ wasm: true });
  b.memory[8] = 9;
  const r = findDivergence(a, b, opts);
  assert.equal(r.atFrame, 0);
  assert.match(r.note, /NOT at hardware power-on/);
  assert.match(r.note, /settleFrames/);
  assert.match(r.note, /boot code has already written RAM/);
});

// The settle disclosure must reach the caller, not just the source comment:
// loadMedia reports the warm-up frame count it ran, so "frameCount 0" is never
// the only thing a caller has to go on.
test("loadMedia discloses the warm-up frames it ran", async () => {
  const key = "loadmedia-settle-disclosure", tools = {};
  registerLifecycleTools({ tool: (n, _d, _s, h) => { tools[n] = h; } }, z, key);
  try {
    const res = await tools.loadMedia({ platform: "sms", path: process.env.ROMDEV_SMS_ROM ?? "" })
      .catch((e) => ({ skipped: e })); // no ROM configured -> nothing to assert
    if (res.skipped || res.isError) return;
    const out = JSON.parse(res.content[0].text);
    assert.ok(out.settleFrames > 0, "a libretro load runs warm-up frames and must say so");
    assert.match(out.settleNote, /NOT counted in frameCount/);
    assert.match(out.settleNote, /real execution/);
  } finally { clearHost(key); }
});
