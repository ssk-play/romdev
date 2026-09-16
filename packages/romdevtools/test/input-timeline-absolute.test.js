// input({op:'timeline'}) - the FRAME-EXACT input schedule.
//
// The whole point of this op is that `frame: 600` means ROM frame 600, so two
// runs of the same timeline hold the same buttons on the same frames and a
// differential comparison against a reference has no phase drift.
//
// THE BUG THIS PINS. The first implementation stepped `firstFrame` frames from
// wherever the session already was, so the schedule was silently RELATIVE: a
// window declared at frame 600 landed on ROM frame 710 when the ROM had
// already run 100 frames. The response even said "Absolute schedule", which
// makes it the worst kind of wrong -- a documented guarantee that does not
// hold. Drift of a single frame is a different frame of animation.
//
// These run against a fake host (frame arithmetic is the thing under test), so
// they need no core and no ROM.

import { test } from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";

import { registerInputTools } from "../src/mcp/tools/input.js";
import { _setHostForTest } from "../src/mcp/state.js";

function captureHandler(registerFn, toolName, sessionKey) {
  let handler;
  const fakeServer = { tool(name, _desc, _schema, h) { if (name === toolName) handler = h; } };
  registerFn(fakeServer, z, sessionKey);
  return handler;
}

function parseResult(res) {
  return JSON.parse(res.content.find((c) => c.type === "text").text);
}

/** A host that records which buttons were held on each frame it ran. */
function recordingHost(startFrame = 0) {
  return {
    status: { platform: "sms", loaded: true, frameCount: startFrame, fbWidth: 256, fbHeight: 192 },
    held: [],            // ports snapshot pending for the next stepped frame
    perFrame: new Map(), // absolute frame -> array of held button names (port 0)
    setInput({ ports }) { this.held = ports; },
    stepFrames(n = 1) {
      for (let i = 0; i < n; i++) {
        const names = Object.entries(this.held?.[0] ?? {}).filter(([, v]) => v).map(([k]) => k).sort();
        if (names.length) this.perFrame.set(this.status.frameCount, names);
        this.status.frameCount += 1;
      }
      return n;
    },
    framebufferHash() { return String(this.status.frameCount); },
  };
}

test("a window at frame N is held on ROM frame N when starting from frame 0", async () => {
  const key = "timeline-abs-0";
  const host = recordingHost(0);
  _setHostForTest(key, host);
  const input = captureHandler(registerInputTools, "input", key);

  const res = parseResult(await input({ op: "timeline", timeline: [{ frame: 600, button: "1", until: 610 }] }));
  assert.equal(res.startedAtFrame, 0);
  assert.equal(res.frameCount, 610, "the run ends exactly at the window's end frame");
  assert.equal(res.framesWithInput, 10);

  const heldFrames = [...host.perFrame.keys()].sort((a, b) => a - b);
  assert.deepEqual(heldFrames, Array.from({ length: 10 }, (_, i) => 600 + i),
    "input must land on frames 600..609 inclusive");
});

test("THE DRIFT BUG: the same timeline lands on the same ROM frames from a later start", async () => {
  const key = "timeline-abs-100";
  const host = recordingHost(100);          // 100 frames already run
  _setHostForTest(key, host);
  const input = captureHandler(registerInputTools, "input", key);

  const res = parseResult(await input({ op: "timeline", timeline: [{ frame: 600, button: "1", until: 610 }] }));
  assert.equal(res.startedAtFrame, 100);
  assert.equal(res.framesRun, 510, "only 510 frames remain to reach frame 610");
  assert.equal(res.frameCount, 610, "absolute: the end frame does NOT shift by the start offset");

  const heldFrames = [...host.perFrame.keys()].sort((a, b) => a - b);
  assert.deepEqual(heldFrames, Array.from({ length: 10 }, (_, i) => 600 + i),
    "the window must still be frames 600..609, not 700..709");
});

test("two runs from different start frames are frame-identical", async () => {
  const timeline = [
    { frame: 600, button: "1", until: 610 },
    { frame: 700, button: "left", until: 730 },
  ];
  const runs = [];
  for (const start of [0, 37, 250]) {
    const key = `timeline-ident-${start}`;
    const host = recordingHost(start);
    _setHostForTest(key, host);
    const input = captureHandler(registerInputTools, "input", key);
    const res = parseResult(await input({ op: "timeline", timeline }));
    assert.equal(res.frameCount, 730, `start ${start}: must still end at 730`);
    runs.push([...host.perFrame.entries()].sort((a, b) => a[0] - b[0]));
  }
  assert.deepEqual(runs[1], runs[0], "a run from frame 37 must match a run from frame 0");
  assert.deepEqual(runs[2], runs[0], "a run from frame 250 must match a run from frame 0");
});

test("overlapping windows on one port are OR'd into a chord, not overwritten", async () => {
  const key = "timeline-chord";
  const host = recordingHost(0);
  _setHostForTest(key, host);
  const input = captureHandler(registerInputTools, "input", key);

  await input({ op: "timeline", timeline: [
    { frame: 10, button: "right", until: 20 },
    { frame: 15, button: "1", until: 25 },
  ] });
  // Frames 15..19 overlap: both must be held.
  assert.deepEqual(host.perFrame.get(12), ["right"], "before the overlap: right alone");
  const chord = host.perFrame.get(17);
  assert.equal(chord.length, 2, `frame 17 should hold both, got ${JSON.stringify(chord)}`);
  assert.deepEqual(host.perFrame.get(22)?.length, 1, "after the overlap: one button again");
});

test("frames outside every window are explicitly NEUTRAL", async () => {
  const key = "timeline-neutral";
  const host = recordingHost(0);
  _setHostForTest(key, host);
  const input = captureHandler(registerInputTools, "input", key);

  await input({ op: "timeline", timeline: [
    { frame: 5, button: "1", until: 8 },
    { frame: 20, button: "1", until: 22 },
  ] });
  for (const f of [8, 9, 15, 19]) {
    assert.equal(host.perFrame.get(f), undefined, `frame ${f} must hold nothing`);
  }
  assert.equal(host.perFrame.get(21)?.length, 1, "the second window still fires");
});

test("a window already in the past is REFUSED, not silently re-run", async () => {
  const key = "timeline-past";
  _setHostForTest(key, recordingHost(700));
  const input = captureHandler(registerInputTools, "input", key);

  // Frames cannot be un-run; pretending otherwise is how the relative
  // behaviour hid. The error must say so and name both frames.
  // (Tool errors surface as an isError result, not a thrown exception.)
  const res = await input({ op: "timeline", timeline: [{ frame: 600, button: "1", until: 610 }] });
  assert.equal(res.isError, true, "a past window must be an error, not a silent re-run");
  const msg = res.content.map((c) => c.text).join(" ");
  assert.match(msg, /already at frame 700/);
  assert.match(msg, /600/, "the message should name the window that was missed");
  assert.match(msg, /ABSOLUTE/i, "and say the schedule is absolute");
});

test("holdFrames is an alternative to until, and until is EXCLUSIVE", async () => {
  const key = "timeline-hold";
  const host = recordingHost(0);
  _setHostForTest(key, host);
  const input = captureHandler(registerInputTools, "input", key);

  await input({ op: "timeline", timeline: [{ frame: 30, button: "1", holdFrames: 4 }] });
  assert.deepEqual([...host.perFrame.keys()].sort((a, b) => a - b), [30, 31, 32, 33],
    "holdFrames:4 from frame 30 covers 30..33");
});

test("a zero-length or inverted window is rejected with a message that explains `until`", async () => {
  const key = "timeline-bad";
  _setHostForTest(key, recordingHost(0));
  const input = captureHandler(registerInputTools, "input", key);

  const res = await input({ op: "timeline", timeline: [{ frame: 100, button: "1", until: 100 }] });
  assert.equal(res.isError, true);
  assert.match(res.content.map((c) => c.text).join(" "), /EXCLUSIVE|greater than/i);
});
