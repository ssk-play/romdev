// layout.js — stack maps and data ownership, from the instruction stream.
//
// §8 of the 2026-09-15 report. The concrete case: a 1,256-byte function whose
// original frame is 472 bytes; the refreshed draft had the same instruction
// count and a 480-byte frame. Changing two locals from `Mtx` to `Mtx_t`
// restored the size but left two matrix homes four bytes high, and moving one
// real declaration between two others reproduced every original offset. No
// padding was needed, and that is the point: the fix was a real declaration
// change, discovered by comparing what the two frames actually contained.
//
// So this module answers two questions the caller was answering by hand:
//
//   WHERE DOES THE FRAME DIFFER, and is it a uniform shift (one object is the
//   wrong size, everything after it moves) or an isolated misplacement (one
//   home is wrong, its neighbours are right)? Those call for different edits.
//
//   WHAT DOES base+offset ACTUALLY NAME? `D_801C2C70 + i*0x378` is not a new
//   integer matrix; it is `D_801C2938[i].unk338`, a member that already
//   exists. Proposing a new struct there would have been worse than useless.
//
// The rule this file holds to: an INFERRED slot is never presented as a proven
// variable home. Everything below is derived from loads and stores, which show
// that bytes are used, not what they are called.

/** The operand half of an sp-relative access: `t0,0x1c(sp)` / `f4,0x84(sp)`. */
const SP_ACCESS = /^(\S+),\s*(-?(?:0x)?[0-9a-fA-F]+)\((?:\$)?sp\)$/;
/** The frame adjustment itself. */
const FRAME_RE = /^sp,sp,(-?\d+)$/;
/**
 * An ADDRESS-TAKEN local: `addiu s0,sp,184` computes &local rather than
 * loading it. These never appear as lw/sw against sp, so a scanner that looked
 * only at loads and stores missed exactly the homes that mattered — the
 * reporter's two fixed-matrix objects at 184/120 differ by four bytes and are
 * reached ONLY this way, because they are passed to a helper by address.
 */
const SP_ADDR = /^(\S+),\s*(?:\$)?sp,\s*(-?(?:0x)?[0-9a-fA-F]+)$/;

const widthOf = (mnemonic) => {
  if (/^(ldc1|sdc1|ld|sd)$/.test(mnemonic)) return 8;
  if (/^(lwc1|swc1|lw|sw|lwu|lwl|lwr|swl|swr)$/.test(mnemonic)) return 4;
  if (/^(lh|lhu|sh)$/.test(mnemonic)) return 2;
  if (/^(lb|lbu|sb)$/.test(mnemonic)) return 1;
  return null;
};

const parseOffset = (s) => {
  const t = String(s).trim();
  const neg = t.startsWith("-");
  const body = neg ? t.slice(1) : t;
  const n = /^0x/i.test(body) ? parseInt(body, 16) : parseInt(body, 10);
  return Number.isFinite(n) ? (neg ? -n : n) : null;
};

/**
 * The frame size a stream declares, or null if it has no prologue adjustment.
 */
export function frameSizeOf(stream) {
  for (const i of stream ?? []) {
    if (i.mnemonic !== "addiu") continue;
    const m = FRAME_RE.exec(String(i.operands ?? ""));
    if (m) return Math.abs(Number(m[1]));
  }
  return null;
}

/**
 * Every sp-relative access in a stream, grouped into SLOTS.
 *
 * A slot is a distinct (offset, width) the code touches. Saved registers,
 * outgoing arguments and real locals all look the same here — they are
 * separated by position, and that separation is labelled as inference.
 */
export function stackSlots(stream, { frameSize = null } = {}) {
  /** @type {Map<number, any>} */
  const slots = new Map();
  const savedRegs = new Set();

  (stream ?? []).forEach((ins, index) => {
    const ops = String(ins.operands ?? "");
    // Address-taken first: `addiu rX,sp,N` is a home whose SIZE is unknown
    // (nothing here says how many bytes the callee touches), but whose
    // POSITION is exact and is what a layout comparison turns on.
    if (ins.mnemonic === "addiu") {
      const am = SP_ADDR.exec(ops);
      if (am) {
        const off = parseOffset(am[2]);
        if (off != null && off >= 0) {
          if (!slots.has(off)) slots.set(off, { offset: off, width: 0, reads: 0, writes: 0, registers: new Set(), addressTaken: 0, firstIndex: index, lastIndex: index });
          const s = slots.get(off);
          s.addressTaken = (s.addressTaken ?? 0) + 1;
          s.registers.add(am[1]);
          s.lastIndex = index;
        }
        return;
      }
    }
    const om = SP_ACCESS.exec(ops);
    if (!om) return;
    const width = widthOf(ins.mnemonic);
    if (width == null) return;
    const off = parseOffset(om[2]);
    if (off == null) return;

    const reg = om[1];
    const isStore = /^s/.test(ins.mnemonic);
    if (!slots.has(off)) slots.set(off, { offset: off, width, reads: 0, writes: 0, registers: new Set(), addressTaken: 0, firstIndex: index, lastIndex: index });
    const s = slots.get(off);
    s.width = Math.max(s.width, width);
    s.registers.add(reg);
    s.lastIndex = index;
    if (isStore) s.writes++; else s.reads++;

    // A callee-saved register stored in the first few instructions and
    // reloaded near the end is the saved-register area, not a local.
    if (isStore && /^(s[0-7]|fp|ra|f2[0-9]|f3[01])$/.test(reg) && index < 8) savedRegs.add(off);
  });

  const out = [...slots.values()].sort((a, b) => a.offset - b.offset).map((s) => ({
    offset: s.offset, offsetHex: `0x${s.offset.toString(16)}`, width: s.width || null,
    reads: s.reads, writes: s.writes, registers: [...s.registers].slice(0, 6),
    ...(s.addressTaken ? { addressTaken: s.addressTaken } : {}),
    // CLASSIFICATION IS INFERENCE. Position and access pattern are evidence of
    // ROLE, never proof of which declared variable lives here.
    inferredRole: savedRegs.has(s.offset) ? "saved-register"
      : s.addressTaken && !s.reads && !s.writes ? "address-taken (passed to a callee by address; its SIZE is not observable here, only its position)"
      : frameSize != null && s.offset >= frameSize - 8 ? "frame-top"
      : s.offset < 16 ? "outgoing-argument-area"
      : s.writes && !s.reads ? "written-only (output slot or dead store)"
      : !s.writes && s.reads ? "read-only (incoming or preset)"
      : "local-or-temporary",
    evidence: s.addressTaken && !s.reads && !s.writes
      ? `address taken ${s.addressTaken} time(s) via addiu sp`
      : `${s.reads} read(s), ${s.writes} write(s) at ${s.width}-byte width${s.addressTaken ? `, address taken ${s.addressTaken} time(s)` : ""}`,
  }));
  return { frameSize, slots: out, slotCount: out.length };
}

/**
 * Compare two stack maps and say WHY they differ.
 *
 * The distinction the report asked for: a uniform shift (every home past some
 * point moves by the same delta, because one object is the wrong size) versus
 * an isolated misplacement (one home is wrong and its neighbours are right).
 * They need different edits, and conflating them wastes experiments.
 */
export function compareStackMaps(targetMap, candidateMap) {
  const t = targetMap.slots, c = candidateMap.slots;
  const frameDelta = (candidateMap.frameSize ?? 0) - (targetMap.frameSize ?? 0);

  // Match slots by ORDER, not by offset: if everything shifted, matching by
  // offset would report every slot as both missing and new.
  const pairs = [];
  const n = Math.max(t.length, c.length);
  for (let i = 0; i < n; i++) pairs.push({ index: i, target: t[i] ?? null, candidate: c[i] ?? null });

  const moved = pairs.filter((p) => p.target && p.candidate && p.target.offset !== p.candidate.offset)
    .map((p) => ({ index: p.index, targetOffset: p.target.offsetHex, candidateOffset: p.candidate.offsetHex,
      delta: p.candidate.offset - p.target.offset, width: p.target.width, role: p.target.inferredRole }));

  const deltas = [...new Set(moved.map((m) => m.delta))];
  let shape, why;
  if (!moved.length && frameDelta === 0) {
    shape = "identical";
    why = "every slot sits at the same offset and the frames are the same size";
  } else if (deltas.length === 1 && moved.length > 1) {
    shape = "uniform-shift";
    why = `${moved.length} slots all moved by exactly ${deltas[0]} bytes. ONE object before them is the wrong size (or one declaration is missing/extra); the slots themselves are not individually misplaced. Find the object whose size differs by ${Math.abs(deltas[0])}, not ${moved.length} separate problems.`;
  } else if (moved.length && moved.length <= 3) {
    shape = "isolated-misplacement";
    why = `${moved.length} slot(s) moved while their neighbours did not. This is a declaration ORDER or alignment difference for those objects specifically, not a size error in an earlier one.`;
  } else if (moved.length) {
    shape = "mixed";
    why = `slots moved by several different deltas (${deltas.slice(0, 5).join(", ")}): more than one object differs. Fix the earliest difference first and re-measure — later deltas usually collapse.`;
  } else {
    shape = "frame-size-only";
    why = `every slot is at its original offset but the frame size differs by ${frameDelta} bytes. The difference is in space that nothing loads or stores: alignment, or an object that is declared but never accessed.`;
  }

  return {
    frame: { target: targetMap.frameSize, candidate: candidateMap.frameSize, delta: frameDelta },
    slotCount: { target: t.length, candidate: c.length },
    shape, why,
    moved: moved.slice(0, 24),
    ...(t.length !== c.length ? { slotCountNote: `the candidate touches ${c.length} slots against the target's ${t.length}: an object is being homed that the original did not have, or vice versa` } : {}),
    guidance: "Never add padding or a dummy local to move an offset. A claimed slot reproduces a number without reproducing the code, and the gate flags it. The fix is a real declaration: its type, its size, or its position among its neighbours.",
  };
}

/**
 * Resolve `base + offset` against symbols that ALREADY EXIST.
 *
 * The report's case: `D_801C2C70 + i*0x378` is `D_801C2938[i].unk338`. A tool
 * that proposed a new stride array there would have invented a second name for
 * memory that is already named — and the caller would have had to discover
 * that by hand anyway.
 *
 * @param {Map<string,{va:number,size?:number}>} symbols known symbols by name
 * @param {number} va the address being accessed
 */
export function resolveAddress(symbols, va) {
  let best = null;
  for (const [name, rec] of symbols) {
    const base = rec.va ?? rec.address;
    if (base == null || base > va) continue;
    const size = rec.size ?? null;
    const within = size != null ? va < base + size : true;
    if (!within) continue;
    // Prefer the CLOSEST containing symbol: the innermost name wins.
    // At equal addresses prefer a name that can be WRITTEN IN C. A linker map
    // carries alias spellings like `D_801C2C70.NON_MATCHING` beside the real
    // `D_801C2C70`; proposing the alias hands back an expression that does not
    // compile, which is the same class of defect as emitting evidence notation
    // as a C type.
    const usable = !/[.$]/.test(name);
    const bestUsable = best ? !/[.$]/.test(best.name) : false;
    if (!best || base > best.base || (base === best.base && usable && !bestUsable)) best = { name, base, size };
  }
  if (!best) return { resolved: false, why: "no known symbol contains this address" };
  const delta = va - best.base;
  return {
    resolved: true, symbol: best.name, base: `0x${best.base.toString(16)}`,
    offset: delta, offsetHex: `0x${delta.toString(16)}`,
    ...(best.size != null ? { symbolSize: best.size } : {}),
    expression: delta === 0 ? best.name : `${best.name} + 0x${delta.toString(16)}`,
    guidance: delta === 0
      ? "this is the symbol itself"
      : `this address is INSIDE an existing symbol. Prefer an existing member at offset 0x${delta.toString(16)} of ${best.name} over declaring a new symbol here — a second name for the same bytes is how one object becomes two incompatible types.`,
  };
}

/**
 * A full layout report for a compare result.
 */
export function layoutReport({ targetStream, candidateStream }) {
  const tFrame = frameSizeOf(targetStream), cFrame = frameSizeOf(candidateStream);
  const tMap = stackSlots(targetStream, { frameSize: tFrame });
  const cMap = stackSlots(candidateStream, { frameSize: cFrame });
  return {
    schema: "romdev-decomp-stack-layout-v1",
    target: tMap, candidate: cMap,
    comparison: compareStackMaps(tMap, cMap),
    policy: "slot roles are INFERRED from access patterns and position. They show that bytes are used, not what the variable is called: a slot is never presented as a proven home for a named local. Layout proposals must be checked with offset/size assertions or compiler-checked evidence before they are trusted.",
  };
}
