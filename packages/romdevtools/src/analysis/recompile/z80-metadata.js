// Metadata over the EXISTING binutils decoder, not a second length decoder.
// cc_* tables are generated from the bundled GPGX core. See the parity test.
import data from "./z80-cycle-tables.json" with { type: "json" };
export const CYCLE_PROVENANCE = { source: data.source, sourceSha256: data.sourceSha256, unit: data.unit };

export function z80Cycles(bytes) {
  const t = data.tables;
  let i = 0, prefixes = 0;
  while (bytes[i] === 0xdd || bytes[i] === 0xfd) { prefixes++; i++; }
  const op = bytes[i];
  if (op == null) return null;
  let base, extra = 0;
  if (op === 0xcb) {
    const code = bytes[i + (prefixes ? 2 : 1)];
    if (code == null) return null;
    base = (prefixes ? t.xycb[code] + 4 * (prefixes - 1) : t.cb[code]);
  } else if (op === 0xed) {
    const code = bytes[i + 1];
    if (code == null) return null;
    base = t.ed[code] + 4 * prefixes;
    // Export cc_ed's instruction cost, not the core's I/O callback scheduling
    // adjustments in cc_ex[a2/aa] or interrupt-entry accounting.
    if ([0xb0, 0xb1, 0xb2, 0xb3, 0xb8, 0xb9, 0xba, 0xbb].includes(code)) extra = t.ex[code];
  } else {
    base = prefixes ? t.xy[op] + 4 * (prefixes - 1) : t.op[op];
    // cc_ex also contains interrupt-entry overhead for RST; that is NOT the
    // cost of executing an ordinary RST instruction.
    if (op === 0x10 || [0x20, 0x28, 0x30, 0x38].includes(op)
      || (op & 0xc7) === 0xc0 || (op & 0xc7) === 0xc4) extra = t.ex[op];
  }
  return [base + extra, base]; // taken/repeating, not-taken/final iteration
}

const ALL = ["S", "Z", "Y", "H", "X", "PV", "N", "C"];
const WITHOUT_C = ALL.filter((f) => f !== "C");
const conditionFlag = { nz: "Z", z: "Z", nc: "C", c: "C", po: "PV", pe: "PV", p: "S", m: "S" };
export function z80Flags(mnemonic, ops) {
  const m = mnemonic.toLowerCase(), o = ops.toLowerCase().replace(/\s+/g, "");
  let read = [], written = [];
  if (["jp", "jr", "call", "ret"].includes(m)) {
    const condition = o.split(",")[0];
    if (conditionFlag[condition]) read = [conditionFlag[condition]];
  } else if (["adc", "sbc", "rl", "rr"].includes(m)) { read = ["C"]; written = ALL; }
  else if (["add", "sub", "and", "or", "xor", "cp", "neg", "rlc", "rrc", "sla", "sll", "sra", "srl"].includes(m)) {
    written = m === "add" && /^(hl|ix|iy),/.test(o) ? ["Y", "H", "X", "N", "C"] : ALL;
  } else if (["inc", "dec"].includes(m)) written = /^(bc|de|hl|sp|ix|iy)$/.test(o) ? [] : WITHOUT_C;
  else if (m === "bit" || m === "rld" || m === "rrd") written = WITHOUT_C;
  else if (m === "daa") { read = ["H", "N", "C"]; written = ALL.filter((f) => f !== "N"); }
  else if (["rlca", "rrca", "rla", "rra", "scf", "ccf"].includes(m)) {
    if (["rla", "rra", "ccf"].includes(m)) read = ["C"];
    written = ["Y", "H", "X", "N", "C"];
  } else if (m === "cpl") written = ["Y", "H", "X", "N"];
  else if (["ldi", "ldir", "ldd", "lddr"].includes(m)) written = ["Y", "H", "X", "PV", "N"];
  else if (["cpi", "cpir", "cpd", "cpdr"].includes(m)) written = WITHOUT_C;
  else if (/^(ini|inir|ind|indr|outi|otir|outd|otdr)$/.test(m)) written = ALL;
  else if (m === "in" && o.includes("(c)")) written = WITHOUT_C;
  else if (m === "ld" && /a,(i|r)$/.test(o)) written = WITHOUT_C;
  else if (m === "pop" && o === "af") written = ALL;
  else if (m === "push" && o === "af") read = ALL;
  else if (m === "ex" && o.startsWith("af,")) { read = ALL; written = ALL; }
  return { flagsRead: read, flagsWritten: written,
    flagsMeaning: "explicit flag inputs and overwritten flag bits; preserved bits are not listed as reads" };
}

export function z80Control(mnemonic, ops, addr, len) {
  const m = mnemonic.toLowerCase(), o = ops.toLowerCase().replace(/;.*$/, "").trim();
  const conditional = /^(nz|z|nc|c|po|pe|p|m)(,|$)/.test(o);
  let kind = "alu", targets = [], fallthrough = (addr + len) & 0xffff;
  if (["jp", "jr", "djnz", "call", "rst"].includes(m)) {
    const indirect = m === "jp" && o.includes("(");
    kind = indirect ? "indirect" : ["call", "rst"].includes(m) ? "call" : conditional || m === "djnz" ? "branch" : "jump";
    if (!indirect) {
      const matches = [...o.matchAll(/(?:0x|\$)([0-9a-f]+)/g)];
      if (matches.length) targets = [parseInt(matches.at(-1)[1], 16) & 0xffff];
    }
    if (kind === "jump" || kind === "indirect") fallthrough = null;
  } else if (["ret", "reti", "retn"].includes(m)) { kind = "ret"; if (!conditional) fallthrough = null; }
  else if (/^(in|out|ini|inir|ind|indr|outi|otir|outd|otdr)$/.test(m)) kind = "io";
  else if (/^(ld|ldi|ldir|ldd|lddr|push|pop|ex|exx)$/.test(m)) kind = "transfer";
  else if (m === "halt") kind = "halt";
  return { kind, targets, fallthrough, conditional: conditional || m === "djnz" };
}
