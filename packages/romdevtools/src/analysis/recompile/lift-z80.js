// Z80 → IR lifter. Turns one objdump-style Z80 disassembly (what
// disasm({target:'rom'}) emits for sms/gg/msx and the Genesis sound CPU) into
// the generic recompile IR (ir.js).
//
// WHY Z80 FIRST, after 6502: one lifter unlocks FOUR platforms — Master
// System, Game Gear, MSX, and the Genesis Z80 — because they share the ISA and
// differ only at the hardware seam, which the IR already keeps separate
// (irHwReg). Everything else in the pipeline (IR, residue, callee stubbing,
// the disasm wiring) is shared with 6502.
//
// The lifter's contract is the one lift-6502 established: tag each instruction
// with an ABSTRACT op so an emitter translates INTENT without knowing Z80, and
// REFUSE anything not mechanically translatable rather than guessing. A wrong
// guess in a recompiler is a silent miscompile; a refusal is a line in the
// residue report.
//
// Plain JS ESM + JSDoc.

import {
  ABSTRACT, COND,
  irLabel, irReg, irBranch, irJump, irCall, irRet, irHwReg, irRefuse,
} from "./ir.js";

/**
 * The documented Z80 mnemonic set (base + CB/ED/DD/FD prefixed forms as
 * objdump renders them). Anything outside this is REFUSED — an undocumented
 * opcode, or a data byte that landed in the instruction stream.
 */
export const DOCUMENTED_Z80 = new Set([
  // 8/16-bit moves
  "ld", "push", "pop", "ex", "exx", "ldi", "ldir", "ldd", "lddr",
  // arithmetic / logic
  "add", "adc", "sub", "sbc", "and", "or", "xor", "cp", "inc", "dec",
  "daa", "cpl", "neg", "scf", "ccf",
  // rotates / shifts
  "rlca", "rrca", "rla", "rra", "rlc", "rrc", "rl", "rr",
  "sla", "sra", "srl", "sll", "rld", "rrd",
  // bit ops
  "bit", "set", "res",
  // control flow
  "jp", "jr", "djnz", "call", "ret", "reti", "retn", "rst",
  // compare/search + block I/O
  "cpi", "cpir", "cpd", "cpdr",
  "ini", "inir", "ind", "indr", "outi", "otir", "outd", "otdr",
  // I/O + misc
  "in", "out", "nop", "halt", "di", "ei", "im",
]);

/** mnemonic → abstract op. Control flow is handled structurally, not here. */
const ABSTRACT_OF = {
  ld: ABSTRACT.TRANSFER,
  push: ABSTRACT.PUSH, pop: ABSTRACT.PULL,
  ex: ABSTRACT.TRANSFER, exx: ABSTRACT.TRANSFER,
  add: ABSTRACT.ADD, adc: ABSTRACT.ADD,
  sub: ABSTRACT.SUB, sbc: ABSTRACT.SUB,
  and: ABSTRACT.AND, or: ABSTRACT.OR, xor: ABSTRACT.XOR,
  cp: ABSTRACT.CMP, bit: ABSTRACT.BIT,
  inc: ABSTRACT.INC, dec: ABSTRACT.DEC,
  rlc: ABSTRACT.ROL, rl: ABSTRACT.ROL, rlca: ABSTRACT.ROL, rla: ABSTRACT.ROL,
  rrc: ABSTRACT.ROR, rr: ABSTRACT.ROR, rrca: ABSTRACT.ROR, rra: ABSTRACT.ROR,
  sla: ABSTRACT.SHL, sll: ABSTRACT.SHL,
  sra: ABSTRACT.SHR, srl: ABSTRACT.SHR,
  scf: ABSTRACT.SET_FLAG, ccf: ABSTRACT.CLR_FLAG,
  di: ABSTRACT.CLR_FLAG, ei: ABSTRACT.SET_FLAG,
  cpl: ABSTRACT.XOR, neg: ABSTRACT.SUB, daa: ABSTRACT.ADD,
  nop: ABSTRACT.NOP,
  // `set`/`res` are bit writes; BIT is the closest abstract intent an emitter
  // can act on without knowing Z80's bit-addressing.
  set: ABSTRACT.BIT, res: ABSTRACT.BIT,
  // Block move/compare. These are LOOPS in one opcode (ldir copies BC bytes
  // from HL to DE) -- no single abstract op expresses that, but TRANSFER/CMP
  // carries the intent, and the mnemonic rides along on the node so an
  // emitter that knows Z80 re-emits it verbatim while one that does not can
  // still see "this moves memory" rather than refusing 8+ instructions per
  // kilobyte of real code.
  ldi: ABSTRACT.TRANSFER, ldir: ABSTRACT.TRANSFER,
  ldd: ABSTRACT.TRANSFER, lddr: ABSTRACT.TRANSFER,
  cpi: ABSTRACT.CMP, cpir: ABSTRACT.CMP,
  cpd: ABSTRACT.CMP, cpdr: ABSTRACT.CMP,
  // Nibble rotates through (HL) -- BCD helpers.
  rld: ABSTRACT.ROL, rrd: ABSTRACT.ROR,
  // Remaining misc with no state effect an emitter must model beyond the name.
  halt: ABSTRACT.NOP, im: ABSTRACT.NOP,
};

/**
 * Z80 condition code → ISA-neutral condition.
 *
 * Z80 spells its conditions as an OPERAND (`jr nz,$1234`), not as part of the
 * mnemonic the way 6502 does (`bne`). That difference is the main structural
 * work in this lifter.
 */
const COND_OF = {
  z: COND.EQ, nz: COND.NE,
  c: COND.CS, nc: COND.CC,
  m: COND.MI, p: COND.PL,
  pe: COND.VS, po: COND.VC,
};

const RE_COMMENT = /;.*$/;
const RE_LABEL_ONLY = /^\s*([A-Za-z_.$][\w.$]*):\s*$/;
const RE_DIRECTIVE = /^\s*\.([A-Za-z_]+)\b/;
const RE_INSTR = /^\s*(?:([A-Za-z_.$][\w.$]*):\s*)?([A-Za-z]+[A-Za-z0-9]*)\s*(.*)$/;

const stripComment = (s) => String(s ?? "").replace(RE_COMMENT, "");

/**
 * Parse one line of objdump-style Z80 assembly.
 * @param {string} rawLine
 */
export function parseZ80Line(rawLine) {
  const noComment = stripComment(rawLine);
  if (!noComment.trim()) return { kind: "blank", raw: "" };

  const mDir = noComment.match(RE_DIRECTIVE);
  if (mDir) {
    const name = mDir[1].toLowerCase();
    return { kind: /^(byte|word|addr|res|db|dw|ds)$/.test(name) ? "data" : "directive", raw: noComment };
  }

  const mLabel = noComment.match(RE_LABEL_ONLY);
  if (mLabel) return { kind: "label", raw: noComment, label: mLabel[1] };

  const mInstr = noComment.match(RE_INSTR);
  if (mInstr) {
    const mnem = mInstr[2].toLowerCase();
    return {
      kind: "instr", raw: noComment,
      label: mInstr[1] || undefined,
      mnemonic: mnem,
      operand: mInstr[3] ? mInstr[3].trim() : undefined,
    };
  }
  return { kind: "data", raw: noComment };
}

/**
 * Split a Z80 operand list into a leading CONDITION and the rest.
 * `ret nz` → {cond:'ne'}; `jp z,$1234` → {cond:'eq', rest:'$1234'};
 * `jp (hl)` → {cond:null, rest:'(hl)'}.
 *
 * The `c` ambiguity is the trap: in `jr c,$x` it is the CARRY condition, but in
 * `ld a,c` / `out (c),a` it is the REGISTER. Only a leading token followed by a
 * comma (or standing alone on ret/jp/call) can be a condition.
 */
export function splitCondition(mnemonic, operand) {
  const op = (operand ?? "").trim();
  if (!op) return { cond: null, rest: "" };
  const condCapable = mnemonic === "jp" || mnemonic === "jr"
    || mnemonic === "call" || mnemonic === "ret";
  if (!condCapable) return { cond: null, rest: op };

  const comma = op.indexOf(",");
  const head = (comma >= 0 ? op.slice(0, comma) : op).trim().toLowerCase();
  if (Object.prototype.hasOwnProperty.call(COND_OF, head)) {
    // `ret` takes a bare condition; the others need something after the comma.
    if (comma < 0 && mnemonic !== "ret") return { cond: null, rest: op };
    return { cond: COND_OF[head], rest: comma >= 0 ? op.slice(comma + 1).trim() : "" };
  }
  return { cond: null, rest: op };
}

/**
 * Is this operand an I/O port access — the Z80 hardware seam?
 *
 * Unlike the 6502 (where hardware is memory-mapped and the seam is an address
 * range), the Z80 reaches hardware through a SEPARATE I/O space via in/out.
 * That makes the seam exact rather than heuristic: every in/out is hardware,
 * nothing else is.
 *
 * Returns the port number when it is a literal, or null for `(c)` (the port is
 * whatever register C holds at runtime, which no static pass can know).
 */
export function seamPort(operand) {
  if (!operand) return null;
  const m = String(operand).match(/\(\s*(\$?[0-9A-Fa-f]{1,4}[Hh]?)\s*\)/);
  if (!m) return null;
  const tok = m[1];

  // THE REGISTER/HEX AMBIGUITY. Z80 register names are all valid hex digits:
  // `b c d e a` parse as 0x0B 0x0C 0x0D 0x0E 0x0A. Without this guard the
  // regex above matched `(c)` in `out (c),a` and returned port 12 with
  // via:'imm' -- a DYNAMIC port reported as a literal one, which is the
  // silent-miscompile this lifter exists to refuse. On SMS that is the
  // difference between "VDP control at $BF" and "port 12", and it made the
  // via:'c' branch in liftInstr unreachable for the very instructions it was
  // written for (every in/out (c) form in the ISA).
  //
  // A port literal must therefore CARRY a radix marker ($ prefix or h suffix)
  // unless it is unambiguous on its own -- a digit somewhere in it, which no
  // register name has.
  const marked = /^\$/.test(tok) || /[Hh]$/.test(tok);
  const bare = tok.replace(/^\$/, "").replace(/[Hh]$/, "");
  if (!marked && !/[0-9]/.test(bare)) return null;   // (c), (hl), (ix) -> dynamic

  const v = parseInt(bare, 16);
  return Number.isFinite(v) ? v : null;
}


/** Placeholder replaced with a unique local label when the node is emitted. */
export const SKIP_LABEL_MARK = "\u0000SKIP";

/** The logical inverse of a condition — what a branch-over expansion needs. */
function invertCond(c) {
  const INV = {
    [COND.EQ]: COND.NE, [COND.NE]: COND.EQ,
    [COND.CS]: COND.CC, [COND.CC]: COND.CS,
    [COND.MI]: COND.PL, [COND.PL]: COND.MI,
    [COND.VS]: COND.VC, [COND.VC]: COND.VS,
  };
  return INV[c] ?? c;
}

/** Lift one parsed instruction line to an IR node. */
function liftInstr(p) {
  const { mnemonic: m, operand, raw, label } = p;

  if (!DOCUMENTED_Z80.has(m)) {
    return irRefuse(`undocumented or unrecognized Z80 mnemonic '${m}'`, raw, label);
  }

  const { cond, rest } = splitCondition(m, operand);

  // ── control flow ────────────────────────────────────────────────────────
  if (m === "ret" || m === "reti" || m === "retn") {
    // reti/retn return from an interrupt; ret from a subroutine. An emitter
    // needs that difference (interrupt returns restore more state).
    const kind = m === "ret" ? "sub" : "interrupt";
    if (cond) {
      // A conditional return is "branch over a return". It has no single-node
      // IR form, but it is far too common in Z80 to refuse -- `ret nz` /
      // `ret z` guard the exit of a large share of real routines, and refusing
      // them would put most of a ROM in the residue.
      //
      // Expanded structurally, preserving semantics exactly:
      //     ret <cond>            ->    branch <!cond> to L
      //                                 ret
      //                             L:
      // The INVERTED condition is what makes this correct: the original
      // returns WHEN the condition holds, so the branch must skip the return
      // when it does NOT.
      return { expand: [
        irBranch(invertCond(cond), SKIP_LABEL_MARK, raw, label),
        irRet(kind, raw),
        irLabel(SKIP_LABEL_MARK),
      ] };
    }
    return irRet(kind, raw, label);
  }

  if (m === "call") {
    if (cond) {
      // Same expansion as the conditional return, for the same reason.
      return { expand: [
        irBranch(invertCond(cond), SKIP_LABEL_MARK, raw, label),
        irCall(rest, raw),
        irLabel(SKIP_LABEL_MARK),
      ] };
    }
    if (/\(/.test(rest)) return irRefuse("indirect call — target not statically known", raw, label);
    return irCall(rest, raw, label);
  }

  if (m === "rst") {
    // rst N is a call to a fixed low address -- normalizing it to a call lets
    // the reachability walk and the emitter treat it like any other.
    //
    // The operand is NOT always a literal: the disassembler labels the low
    // vectors, so real output carries `rst L000038`, not `rst $38`. Accepting
    // only hex refused every rst in the ROM (59 of 80 refusals on a 4KB
    // sample). A label is a perfectly good call target -- pass it through.
    const t = String(rest ?? "").trim();
    if (!t) return irRefuse("rst with no vector operand", raw, label);
    if (/^[A-Za-z_.$][\w.$]*$/.test(t)) return irCall(t, raw, label);
    const addr = parseInt(t.replace(/[$hH]/g, ""), 16);
    if (!Number.isFinite(addr)) return irRefuse(`rst with unparsable vector '${rest}'`, raw, label);
    return irCall(`$${addr.toString(16).padStart(2, "0")}`, raw, label);
  }

  if (m === "jp" || m === "jr") {
    // `jp (hl)` / `jp (ix)` is a computed jump: the destination lives in a
    // register at runtime. No static lifter can follow it -- and guessing is
    // how a recompiler silently drops half a dispatcher. Refuse, and point at
    // the tool that CAN resolve it.
    if (/\(/.test(rest)) {
      return irRefuse("computed jump (jp (hl)/(ix)/(iy)) — resolve arms with breakpoint({on:'jumptable'}) and re-lift with them as entries", raw, label);
    }
    if (cond) return irBranch(cond, rest, raw, label);
    return irJump(rest, raw, label);
  }

  if (m === "djnz") {
    // Decrement B and branch if non-zero. Two effects in one opcode; the
    // branch is the structural half an emitter must preserve.
    return irBranch(COND.NE, rest, raw, label);
  }

  // ── the hardware seam: Z80 I/O space ─────────────────────────────────────
  if (m === "in" || m === "out" || /^(ini|inir|ind|indr|outi|otir|outd|otdr)$/.test(m)) {
    const access = m.startsWith("in") ? "read" : "write";
    const port = seamPort(operand);
    if (port == null) {
      // `in a,(c)` / `out (c),a` — the port is dynamic. Still a seam, still
      // hardware; the emitter just cannot constant-fold which register.
      return irHwReg(access, null, "c", raw, label);
    }
    return irHwReg(access, port, "imm", raw, label);
  }

  // ── everything else: a register/ALU op ──────────────────────────────────
  const kind = ABSTRACT_OF[m];
  if (!kind) return irRefuse(`no abstract mapping for '${m}'`, raw, label);
  return irReg(kind, m, operand, raw, label);
}

/**
 * Lift a Z80 disassembly to IR.
 *
 * @param {string} z80Asm objdump-style Z80 assembly
 * @returns {{ir: Array<object>, equs: string[], instrCount: number, seamCount: number, entry: string|null}}
 */
export function liftZ80(z80Asm) {
  const lines = String(z80Asm ?? "").split("\n");
  const ir = [];
  const equs = [];
  let instrCount = 0;
  let seamCount = 0;
  let entry = null;
  let skipSeq = 0;
  const ENTRY_LABEL = "RECOMPILE_ENTRY";

  for (const raw of lines) {
    const p = parseZ80Line(raw);
    switch (p.kind) {
      case "blank":
      case "comment":
      case "directive":
        break;
      case "label":
        ir.push(irLabel(p.label));
        break;
      case "data":
        ir.push(irRefuse("data/.byte in code stream (data table or undocumented opcode)", p.raw));
        break;
      case "instr": {
        const lifted = liftInstr(p);
        if (!lifted) break;
        // A conditional call/return lifts to SEVERAL nodes (branch-over-X).
        // Give the skip label a unique name here, where the counter lives.
        if (lifted.expand) {
          const name = `Lz80_skip_${skipSeq++}`;
          for (const n of lifted.expand) {
            if (n.target === SKIP_LABEL_MARK) n.target = name;
            if (n.name === SKIP_LABEL_MARK) n.name = name;
          }
          if (entry == null) {
            const first = lifted.expand[0];
            if (first.label) entry = first.label;
            else { entry = ENTRY_LABEL; ir.push(irLabel(ENTRY_LABEL)); }
          }
          instrCount++;
          ir.push(...lifted.expand);
          break;
        }
        const node = lifted;
        // Anchor the entry on the first node, labelled or not: the emitter's
        // reset vector has to land on the routine's first instruction, and a
        // fall-through opener carries no label of its own.
        if (entry == null) {
          if (node.label) entry = node.label;
          else { entry = ENTRY_LABEL; ir.push(irLabel(ENTRY_LABEL)); }
        }
        if (node.op === "hwreg") seamCount++;
        if (node.op !== "refuse") instrCount++;
        ir.push(node);
        break;
      }
      default:
        break;
    }
  }
  return { ir, equs, instrCount, seamCount, entry };
}
