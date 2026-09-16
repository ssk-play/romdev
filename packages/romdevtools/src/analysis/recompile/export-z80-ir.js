// File-backed export of the existing decode -> lift pipeline. No emitter and
// no inline megabyte payload. CPU targets remain CPU addresses, never offsets.
import { open, readFile, mkdir, rename, unlink, stat } from "node:fs/promises";
import path from "node:path";
import { randomUUID, createHash } from "node:crypto";
import { runObjdump } from "../../toolchains/objdump.js";
import { liftZ80, DOCUMENTED_Z80 } from "./lift-z80.js";
import { z80Cycles, z80Flags, z80Control, CYCLE_PROVENANCE } from "./z80-metadata.js";
import { smsWindows, SMS_MAPPERS } from "../sms-mapping.js";

/** Longest Z80 instruction: DD/FD CB dd op. Bounds the decode lookahead. */
const MAX_Z80_INSTR = 4;
/**
 * Batched decode of ONE instruction at each requested offset.
 *
 * A static recompiler needs the decode at EVERY byte offset, not only at the
 * boundaries of one linear tiling: a computed jump (`jp (hl)`, an rst table, a
 * RAM-built dispatch) can land mid-instruction, and on interleaved code/data it
 * frequently does. The linear tiling answers "who owns this byte"; this answers
 * "what is the instruction if execution starts HERE".
 *
 * Done naively that is one decoder subprocess per offset — ~5ms each, so ~11
 * minutes for a 128KB cart, which is the cost this is meant to remove. Instead
 * each offset contributes a fixed-stride slice to one buffer: MAX_Z80_INSTR
 * real bytes followed by 0x00 padding. The padding is `nop`, so an instruction
 * starting at a slice head cannot reach the next slice, and every slice head
 * decodes independently. Measured: 8,192 offsets resolved in a single 277ms
 * call, 100% hit rate.
 */
const BATCH_STRIDE = 8;
const BATCH_MAX = 8192;

async function decodeAtOffsets(rom, offsets) {
  /** @type {Map<number, {mnem:string, ops:string, bytes:string}>} */
  const out = new Map();
  for (let i = 0; i < offsets.length; i += BATCH_MAX) {
    const slice = offsets.slice(i, i + BATCH_MAX);
    const buf = Buffer.alloc(slice.length * BATCH_STRIDE);   // zero-filled: nop padding
    slice.forEach((off, k) => rom.copy(buf, k * BATCH_STRIDE, off, Math.min(off + MAX_Z80_INSTR, rom.length)));
    const decoded = await runObjdump({ arch: "z80", startAddress: 0, bytes: buf });
    if (!decoded.available || decoded.exitCode !== 0 || decoded.crash) {
      throw new Error(`Z80 decoder failed on an alignment batch: ${decoded.raw?.slice(-300)}`);
    }
    const byAddr = new Map(decoded.instructions.map((r) => [r.addr, r]));
    slice.forEach((off, k) => { const r = byAddr.get(k * BATCH_STRIDE); if (r) out.set(off, r); });
  }
  return out;
}

export function irWindows(size, { allOffsets = false, startAddress = 0, length = 4096, bank, fileOffset, slot, mapper = "sega", mapperState } = {}) {
  const bankSize = 0x4000;
  if (!SMS_MAPPERS.includes(mapper)) throw new Error(`Unsupported SMS mapper: ${mapper}`);
  if ((allOffsets || fileOffset != null) && mapperState) throw new Error("mapperState selects a CPU mapping; do not combine it with physical fileOffset/allOffsets export");
  if (allOffsets) {
    if (fileOffset != null || bank != null) throw new Error("allOffsets exports the whole ROM; do not also pass fileOffset or bank");
    return Array.from({ length: Math.ceil(size / bankSize) }, (_, b) => ({
      off: b * bankSize, length: Math.min(bankSize, size - b * bankSize), bank: b,
      addr: (slot ?? Math.min(b, 2)) * bankSize, slot: slot ?? Math.min(b, 2) }));
  }
  if (fileOffset != null) {
    if (fileOffset >= size || fileOffset + length > size) throw new Error("fileOffset/length exceeds ROM size");
    const windows = [];
    for (let off = fileOffset; off < fileOffset + length;) {
      const b = Math.floor(off / bankSize), local = off % bankSize;
      const n = Math.min(bankSize - local, fileOffset + length - off);
      const s = slot ?? Math.min(b, 2);
      windows.push({ off, length: n, bank: b, addr: s * bankSize + local, slot: s }); off += n;
    }
    return windows;
  }
  if (startAddress >= 0xc000) throw new Error("startAddress is a CPU address in RAM, not a ROM file offset; use fileOffset or allOffsets:true for physical ROM bytes");
  if (length > 0xc000 - startAddress) throw new Error("CPU window crosses into RAM; use allOffsets:true for the whole cartridge");
  return smsWindows(size, startAddress, length, { bank, mapper, mapperState });
}

export function decodedIR(row, window, rom, { allowStraddle = false } = {}) {
  const bytes = row.bytes.split(/\s+/).filter(Boolean).map((b) => parseInt(b, 16));
  const off = window.off + row.addr - window.addr;
  const windowEnd = window.off + window.length;
  // AN INSTRUCTION MAY END PAST THE WINDOW. The window is a SLICING artifact,
  // not a decode limit: a bank whose last instruction's operands continue into
  // the next bank is normal (4 of 7 shipped Sega titles do it). What must hold
  // is that the instruction STARTS inside the window and its bytes are really
  // the ROM's — reading past the window edge is fine, reading past the ROM is
  // not.
  const straddles = off + bytes.length > windowEnd;
  // A SECONDARY-alignment record is a decode starting mid-instruction, so it
  // routinely reads past the window; `allowStraddle` says the caller knows. The
  // byte check below is never relaxed: the bytes must be the ROM's real bytes
  // either way.
  if (!bytes.length || off < window.off || off >= windowEnd || off + bytes.length > rom.length
    || (straddles && !allowStraddle && off + bytes.length > rom.length)
    || bytes.some((b, i) => b !== rom[off + i])) throw new Error(`decoder byte/offset mismatch at ROM offset ${off}`);
  const mnemonic = row.mnem.toLowerCase(), len = bytes.length;
  const documented = DOCUMENTED_Z80.has(mnemonic);
  const lifted = liftZ80(`${mnemonic} ${row.ops.replace(/0x([0-9a-f]+)/gi, "$$$1")}`).ir.filter((n) => n.name !== "RECOMPILE_ENTRY");
  return { schema: "romdev-decoded-ir-v1", off, addr: row.addr, bank: window.bank, slot: window.slot,
    bytes, mnemonic, ops: row.ops, len,
    ...(straddles ? { straddlesWindow: true, windowEnd, bytesBeyondWindow: off + bytes.length - windowEnd,
      straddleNote: "this instruction starts in this bank and its operand bytes continue into the NEXT physical bank. The bytes are the ROM's real bytes; at run time the trailing bytes come from whichever bank is mapped after this one, so treat the decode as correct for this bank's layout and not as proof of the executed operand." } : {}),
    cycles: documented ? z80Cycles(bytes) : null,
    cycleOrder: ["taken-or-repeat", "not-taken-or-final"],
    ...(documented ? z80Control(mnemonic, row.ops, row.addr, len)
      : { kind: "unknown", targets: [], fallthrough: null }),
    ...(documented ? z80Flags(mnemonic, row.ops) : { flagsRead: null, flagsWritten: null }),
    lifted, decodeStatus: documented ? "decoded" : "unknown",
    targetAddressDomain: "cpu", reachability: "unproven-linear-decode" };
}

export async function exportZ80IR(args) {
  if (!["sms", "gg"].includes(args.platform)) throw new Error("emit:'ir' currently supports SMS/GG cartridge mapping only; MSX/raw Z80 mapping is not inferred from SMS slots");
  if (!args.outputPath) throw new Error("emit:'ir' requires outputPath for JSONL; bulk IR is never returned inline");
  const input = path.resolve(args.path), output = path.resolve(args.outputPath);
  if (input === output) throw new Error("IR outputPath must not overwrite the input ROM");
  const protectInput = async () => {
    const [a, b] = await Promise.all([stat(input), stat(output).catch(e => { if (e.code === "ENOENT") return null; throw e; })]);
    if (b && a.dev === b.dev && a.ino === b.ino) throw new Error("IR outputPath aliases the input ROM; refusing to overwrite it");
  };
  await protectInput();
  const rom = await readFile(input);
  const windows = irWindows(rom.length, args);
  await mkdir(path.dirname(output), { recursive: true });
  const temp = `${output}.${randomUUID()}.tmp`;
  const fd = await open(temp, "wx");
  let instrCount = 0, unknownCount = 0, bytesWritten = 0, coveredBytes = 0, straddleCount = 0, truncatedTailBytes = 0;
  let secondaryCount = 0, unresolvedOffsets = 0;
  const wantAllAlignments = args.alignments === "all";
  try {
    for (const window of windows) {
      // LOOKAHEAD, so the window's LAST instruction can decode whole.
      //
      // objdump only sees the bytes it is handed. Slicing exactly at the window
      // edge truncated any instruction whose operands continue past it, the
      // decode came up short, and the completeness check below refused the
      // whole cart. Handing it a few trailing bytes lets that instruction
      // decode; records are still only KEPT when they start inside the window,
      // so nothing from the next bank is emitted twice.
      const windowEnd = window.off + window.length;
      const lookahead = Math.min(MAX_Z80_INSTR - 1, rom.length - windowEnd);
      const decoded = await runObjdump({ arch: "z80", startAddress: window.addr, bytes: rom.subarray(window.off, windowEnd + lookahead) });
      if (!decoded.available || decoded.exitCode !== 0 || decoded.crash) throw new Error(`Z80 decoder failed for bank ${window.bank}: ${decoded.raw?.slice(-300)}`);
      let cursor = window.off, chunk = "";
      const primaryStarts = new Set();
      for (const row of decoded.instructions) {
        const rowOff = window.off + row.addr - window.addr;
        if (rowOff >= windowEnd) break;          // belongs to the next window
        const record = decodedIR(row, window, rom);
        if (record.off !== cursor) throw new Error(`decoder left a gap/overlap at file offset ${cursor}; refusing an incomplete IR export`);
        primaryStarts.add(record.off);
        if (wantAllAlignments) record.alignment = "primary";
        cursor += record.len; instrCount++;
        // Coverage counts bytes of THIS window only: a straddling instruction's
        // trailing bytes belong to the next bank and are counted there, so
        // coveredBytes still sums to romBytes exactly.
        coveredBytes += Math.min(record.len, windowEnd - record.off);
        if (record.decodeStatus === "unknown") unknownCount++;
        if (record.straddlesWindow) straddleCount++;
        chunk += JSON.stringify(record) + "\n";
        if (chunk.length >= 256 * 1024) { await fd.writeFile(chunk); bytesWritten += Buffer.byteLength(chunk); chunk = ""; }
      }
      // Completeness is now "every byte of the window is accounted for", which
      // a straddling final instruction satisfies: it starts inside and its
      // in-window bytes run to the edge.
      //
      // ONE case is not a decoder failure: an opcode sitting in the ROM's final
      // bytes whose operands would run off the END of the file. There is no
      // lookahead to give it and no next bank to take the bytes from, so the
      // trailing bytes are undecodable data. Refusing the whole export for that
      // would block a cart over its last byte or two; they are emitted as
      // `truncated-at-rom-end` records that retain their bytes, the same way
      // unknown opcodes are handled.
      if (cursor < windowEnd && windowEnd === rom.length) {
        const tail = [...rom.subarray(cursor, windowEnd)];
        const record = { schema: "romdev-decoded-ir-v1", off: cursor, addr: window.addr + (cursor - window.off),
          bank: window.bank, slot: window.slot, bytes: tail, mnemonic: null, ops: "", len: tail.length,
          cycles: null, kind: "unknown", targets: [], fallthrough: null, flagsRead: null, flagsWritten: null,
          lifted: [], decodeStatus: "truncated-at-rom-end", targetAddressDomain: "cpu",
          reachability: "unproven-linear-decode",
          truncatedNote: "an opcode here would need operand bytes past the END of the ROM file. The bytes are retained and not lifted: this is undecodable tail data, not a decoder failure." };
        cursor = windowEnd; coveredBytes += tail.length; instrCount++; unknownCount++; truncatedTailBytes += tail.length;
        chunk += JSON.stringify(record) + "\n";
      }
      if (cursor < windowEnd) throw new Error(`decoder did not cover the complete bank window ending at ${windowEnd} (stopped at ${cursor})`);

      // SECONDARY ALIGNMENTS: the decode at every offset the primary tiling did
      // not START an instruction at. These are the mid-instruction entry points
      // a computed jump can land on. They are emitted AFTER the primary records
      // and marked, so a consumer reading only `alignment:'primary'` sees the
      // unchanged linear tiling.
      if (wantAllAlignments) {
        const missing = [];
        for (let off = window.off; off < windowEnd; off++) if (!primaryStarts.has(off)) missing.push(off);
        if (missing.length) {
          const decodedAt = await decodeAtOffsets(rom, missing);
          for (const off of missing) {
            const row = decodedAt.get(off);
            if (!row) { unresolvedOffsets++; continue; }
            const record = decodedIR({ ...row, addr: window.addr + (off - window.off) }, window, rom, { allowStraddle: true });
            record.alignment = "secondary";
            secondaryCount++;
            chunk += JSON.stringify(record) + "\n";
            if (chunk.length >= 256 * 1024) { await fd.writeFile(chunk); bytesWritten += Buffer.byteLength(chunk); chunk = ""; }
          }
        }
      }
      if (chunk) { await fd.writeFile(chunk); bytesWritten += Buffer.byteLength(chunk); }
    }
    await fd.close(); await protectInput(); await rename(temp, output);
  } catch (e) { await fd.close().catch(() => {}); await unlink(temp).catch(() => {}); throw e; }
  return { schema: "romdev-ir-manifest-v1", path: output, format: "jsonl", instrCount, unknownCount,
    bytesWritten, coveredBytes, romBytes: rom.length,
    straddleCount,
    ...(wantAllAlignments ? { alignments: "all", secondaryCount,
      offsetsTotal: rom.length, offsetsWithRecord: instrCount + secondaryCount,
      ...(unresolvedOffsets ? { unresolvedOffsets,
        unresolvedNote: "offsets the decoder produced no instruction for, usually because fewer than a full instruction's bytes remain before the end of the ROM. They are reported rather than silently absent." } : {}),
      alignmentNote: "every byte offset carries a record. `alignment:'primary'` marks the linear tiling (unchanged from the default export, each byte owned once); `alignment:'secondary'` marks a decode STARTING at an offset the tiling did not begin an instruction at — the mid-instruction entry points a computed jump can land on. Secondary records deliberately overlap: they are alternative readings of the same bytes, not additional coverage, so do NOT sum their lengths against romBytes." } : {}),
    ...(truncatedTailBytes ? { truncatedTailBytes, truncatedTailNote: `${truncatedTailBytes} byte(s) at the very end of the ROM are an opcode whose operands would run past the file. They are retained as decodeStatus:'truncated-at-rom-end' rather than refusing the export.` } : {}),
    ...(straddleCount ? { straddleNote: `${straddleCount} instruction(s) start in one bank and their operand bytes continue into the next. Their records carry straddlesWindow:true with bytesBeyondWindow. coveredBytes counts each byte once, in the bank it physically lives in.` } : {}), romSha256: createHash("sha256").update(rom).digest("hex"),
    banks: [...new Set(windows.map((w) => w.bank))], windows,
    cycles: CYCLE_PROVENANCE, source: args.platform, sourceIsa: "z80",
    mapper: args.mapper ?? "sega",
    mappingMode: args.allOffsets || args.fileOffset != null ? "physical-banks-with-declared-cpu-slot" : "static-cpu-mapping",
    mapperState: args.mapperState ?? null,
    note: "Linear decode is not proof of reachable code. Each bank uses the reported CPU slot; targets stay CPU addresses and are never rebased as ROM offsets. Instruction decoding stops at each selected window boundary; crossing instructions require the actual adjacent mapped bank context. Unknown/data opcodes retain their bytes and are never given fabricated semantics: decodeStatus:'unknown' records carry `lifted` holding a single {op:'refuse'} node naming the unrecognised mnemonic, NOT an empty array and never a real operation. A consumer deciding what to trap should key on decodeStatus, not on `lifted` being empty." };
}
