// SN76489 (PSG) decode: `raw.regsHex` must reconcile with `tones[]`.
//
// THE BUG THIS PINS. `tones[].frequency` used to carry the PERIOD, not Hz. The
// two fields then disagreed by construction, and a caller who tried to find
// the clock that related them got a different answer per channel
// (3.45M / 3.74M / 5.67M) -- the signature of a mislabelled field rather than
// an exotic encoding. It cost a real user a detour before they abandoned
// regsHex entirely.
//
// The decoder is pure (bytes in, object out), so this runs without an
// emulator: the fixture below is a real gpgx PSG register file captured from a
// commercial SMS ROM mid-music.

import { test } from "node:test";
import assert from "node:assert/strict";

import { decodeGenesisPSG } from "romdev-core-host/gpgx-state.js";

/** The SN76489 runs from the 3.579545 MHz NTSC colourburst on Genesis and SMS/GG alike. */
const PSG_CLOCK_HZ = 3579545;

/**
 * Build the gpgx PSG blob: 3 leading u32s (clocks, latch, noiseShiftValue)
 * then 8 registers, each widened to a host u32.
 */
function psgBlob(regs, { clocks = 0, latch = 0, noiseShift = 0 } = {}) {
  const b = new Uint8Array(12 + 8 * 4);
  const put = (off, v) => {
    b[off] = v & 0xff; b[off + 1] = (v >> 8) & 0xff;
    b[off + 2] = (v >> 16) & 0xff; b[off + 3] = (v >>> 24) & 0xff;
  };
  put(0, clocks); put(4, latch); put(8, noiseShift);
  regs.forEach((r, i) => put(12 + i * 4, r));
  return b;
}

// Captured live from a commercial SMS ROM mid-music (regsHex 88,160,b5,1bb,16a,118,0,0).
// Note the values exceed 10 bits: gpgx widens each register to a host int, which
// is exactly why a reader expecting raw chip registers could not decode them.
const LIVE_REGS = [0x88, 0x160, 0xb5, 0x1bb, 0x16a, 0x118, 0x00, 0x00];

test("regsHex reconciles with tones[]: period and attenuation derive from the documented formula", () => {
  const psg = decodeGenesisPSG(psgBlob(LIVE_REGS));
  const regs = psg.raw.regsHex.split(",").map((h) => parseInt(h, 16));
  assert.deepEqual(regs, LIVE_REGS, "regsHex must round-trip the register file");

  for (let c = 0; c < 3; c++) {
    // The formula the response documents in raw.regsNote.
    const period = ((regs[c * 2 + 1] & 0x3f) << 4) | (regs[c * 2] & 0x0f);
    const attenuation = regs[c * 2 + 1] & 0x0f;
    const t = psg.tones[c];
    assert.equal(t.period, period, `ch${c} period must derive from regsHex`);
    assert.equal(t.attenuation, attenuation, `ch${c} attenuation must derive from regsHex`);
  }
});

test("frequency is Hz and period is the register value — they are SEPARATE fields", () => {
  const psg = decodeGenesisPSG(psgBlob(LIVE_REGS));
  for (const t of psg.tones) {
    if (t.period === 0) continue;
    const hz = PSG_CLOCK_HZ / 16 / (2 * t.period);
    assert.ok(Math.abs(t.frequency - hz) < 0.05,
      `ch${t.channel}: frequency ${t.frequency} should be ${hz.toFixed(1)} Hz`);
    // The actual bug: frequency carrying the period.
    assert.notEqual(t.frequency, t.period,
      `ch${t.channel}: frequency must not be the period value`);
  }
});

test("the clock solve that exposed the bug now lands on the real colourburst", () => {
  // A caller solving clock = f * 32 * period across channels used to get three
  // different "clocks". With the fields correct it must land on one constant.
  const psg = decodeGenesisPSG(psgBlob(LIVE_REGS));
  const solved = psg.tones.filter((t) => t.period > 0).map((t) => t.frequency * 32 * t.period);
  assert.ok(solved.length >= 2, "need at least two sounding channels to compare");
  for (const s of solved) {
    assert.ok(Math.abs(s - PSG_CLOCK_HZ) < 2000,
      `solved clock ${Math.round(s)} should be ~${PSG_CLOCK_HZ} (rounding aside)`);
  }
  // and they must agree with EACH OTHER, which is what failed before.
  const spread = Math.max(...solved) - Math.min(...solved);
  assert.ok(spread < 3000, `per-channel clocks must agree; spread was ${Math.round(spread)}`);
});

test("the decode is self-consistent for a hand-built register set", () => {
  // period 0x0AB = 171, attenuation 3 on channel 0.
  const regs = [0x0b, (0x0a << 0) | 0x30, 0, 0x0f, 0, 0x0f, 0, 0x0f];
  const psg = decodeGenesisPSG(psgBlob(regs));
  const t = psg.tones[0];
  assert.equal(t.period, ((regs[1] & 0x3f) << 4) | (regs[0] & 0x0f));
  assert.equal(t.attenuation, regs[1] & 0x0f);
  assert.equal(t.muted, false);
  // attenuation 15 is silence, on every channel that carries it.
  assert.equal(psg.tones[1].muted, true, "attenuation 0x0F is muted");
  assert.equal(psg.tones[2].muted, true);
});

test("raw carries the derivation note and the clock, so regsHex is never a mystery", () => {
  const psg = decodeGenesisPSG(psgBlob(LIVE_REGS));
  assert.equal(psg.raw.psgClockHz, PSG_CLOCK_HZ);
  assert.match(psg.raw.regsNote, /period\s*=/, "the note must give the derivation");
  assert.match(psg.raw.regsNote, /attenuation\s*=/);
});
