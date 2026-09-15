// assets.js — identify and ROUND-TRIP the non-code bytes.
//
// 7,238,640 bytes of this ROM (86.3%) sit in `bin` ranges the ledger can only
// call "raw". Some of that is compressed archives, some is textures, some is
// audio banks, some is microcode. Until a tool can unpack a range AND repack it
// byte-exactly, none of it can move out of the opaque bucket, and the project
// cannot answer whether the non-code half is "done".
//
// ROUND-TRIP IS THE ONLY ACCEPTANCE TEST. Unpacking alone proves nothing: a
// decoder that produces plausible pixels from the wrong offset is worse than no
// decoder, because it looks like progress. A format is only "recovered" when
// unpack -> repack reproduces the original bytes exactly, and this module
// reports the sha of both sides so the claim is checkable.
//
// Identification is by MAGIC and STRUCTURE, never by file extension or by a
// name in the splat yaml — a name is a label someone typed, not evidence.
//
// Plain JS ESM + JSDoc.

import { createHash } from "node:crypto";

export const ASSET_SCHEMA = "romdev-decomp-assets-v1";

const sha = (b) => createHash("sha256").update(b).digest("hex");

/** MIO0: "MIO0", uncompressed size, compressed-offset, raw-offset (big-endian). */
function tryMio0(buf) {
  if (buf.length < 16 || buf.toString("ascii", 0, 4) !== "MIO0") return null;
  const destSize = buf.readUInt32BE(4), compOff = buf.readUInt32BE(8), rawOff = buf.readUInt32BE(12);
  if (compOff < 16 || rawOff < compOff || compOff > buf.length || rawOff > buf.length) return null;
  return { format: "MIO0", destSize, compOffset: compOff, rawOffset: rawOff, headerBytes: 16 };
}

/** Yay0: same family, different header order. */
function tryYay0(buf) {
  if (buf.length < 16 || buf.toString("ascii", 0, 4) !== "Yay0") return null;
  const destSize = buf.readUInt32BE(4), linkOff = buf.readUInt32BE(8), chunkOff = buf.readUInt32BE(12);
  if (linkOff < 16 || chunkOff < linkOff || linkOff > buf.length) return null;
  return { format: "Yay0", destSize, linkOffset: linkOff, chunkOffset: chunkOff, headerBytes: 16 };
}

/** Decode an MIO0/Yay0 LZ stream. Both use the same layout/length encoding. */
function decodeMio0(buf, h) {
  const out = Buffer.alloc(h.destSize);
  let layoutPos = h.headerBytes;
  let compPos = h.compOffset ?? h.linkOffset;
  let rawPos = h.rawOffset ?? h.chunkOffset;
  let dst = 0, bitIdx = 0;

  // SEMANTICS TAKEN FROM THE PROJECT'S OWN libmio0.c, which is what its build
  // actually links — not from a guess, and not from tools/mio0_decompress.py,
  // whose bit polarity is inverted relative to this data.
  //
  // Four details, each of which silently corrupts output on its own, and none
  // of which "the decode reached destSize" can detect — four different WRONG
  // variants all produced exactly destSize bytes on real data here:
  //   * a SET layout bit is a LITERAL; a clear bit is a backref.
  //   * length   = ((vals[0] & 0xF0) >> 4) + 3
  //   * distance = ((vals[0] & 0x0F) << 8) + vals[1] + 1
  //   * the copy reads out[dst - distance] BYTE AT A TIME, because an
  //     overlapping run reads bytes this same loop is writing.
  while (dst < h.destSize) {
    const byteAt = layoutPos + (bitIdx >> 3);
    if (byteAt >= buf.length) return null;
    const isLiteral = (buf[byteAt] & (1 << (7 - (bitIdx % 8)))) !== 0;
    bitIdx++;
    if (isLiteral) {
      if (rawPos >= buf.length) return null;
      out[dst++] = buf[rawPos++];
    } else {
      if (compPos + 2 > buf.length) return null;
      const v0 = buf[compPos], v1 = buf[compPos + 1];
      compPos += 2;
      const length = ((v0 & 0xf0) >> 4) + 3;
      const distance = ((v0 & 0x0f) << 8) + v1 + 1;
      if (distance > dst) return null;
      for (let i = 0; i < length && dst < h.destSize; i++) { out[dst] = out[dst - distance]; dst++; }
    }
  }
  return out;
}

/** N64 image formats, by bytes-per-pixel. Identification needs dimensions. */
export const IMAGE_FORMATS = Object.freeze({
  rgba16: { bpp: 2, note: "5/5/5/1 RGBA" }, rgba32: { bpp: 4, note: "8/8/8/8 RGBA" },
  ia16: { bpp: 2, note: "8/8 intensity+alpha" }, ia8: { bpp: 1 }, ia4: { bpp: 0.5 },
  i8: { bpp: 1 }, i4: { bpp: 0.5 }, ci8: { bpp: 1, note: "needs a TLUT" }, ci4: { bpp: 0.5, note: "needs a TLUT" },
});

/**
 * Identify what a byte range is, by magic and structure only.
 *
 * Returns candidates with confidence. An unidentified range says so — a guess
 * dressed as an identification is the failure this module is built to avoid.
 */
export function identify(buf, { name } = {}) {
  const candidates = [];
  const m0 = tryMio0(buf); if (m0) candidates.push({ ...m0, confidence: "high", basis: "MIO0 magic + self-consistent header offsets" });
  const y0 = tryYay0(buf); if (y0) candidates.push({ ...y0, confidence: "high", basis: "Yay0 magic + self-consistent header offsets" });

  // An RSP microcode blob is a text/data pair of very specific sizes; without
  // the boundary we can only note the possibility.
  if (!candidates.length && buf.length >= 0x1000 && buf.length % 8 === 0) {
    const zeros = buf.subarray(0, 64).filter((b) => b === 0).length;
    if (zeros < 8) candidates.push({ format: "unknown-binary", confidence: "none", basis: "no recognised magic; dense non-zero head" });
  }
  if (!candidates.length) candidates.push({ format: "unidentified", confidence: "none", basis: "no recognised magic" });

  return {
    name: name ?? null, bytes: buf.length, sha256: sha(buf).slice(0, 16),
    candidates,
    note: candidates[0].confidence === "high" ? undefined
      : "NOT identified. This range stays in the opaque bucket: reporting a guess as a format would move bytes out of 'raw' without evidence.",
  };
}

/**
 * Unpack AND repack, and report whether the round trip is byte-exact.
 *
 * `repack` is supplied by the caller for formats romdev can only decode; when
 * absent the result says `roundTrip: "decode-only"` rather than implying the
 * format is recovered.
 */
export function roundTrip(buf, { name, repack } = {}) {
  const id = identify(buf, { name });
  const best = id.candidates[0];
  if (best.confidence !== "high") {
    return { ...id, roundTrip: "not-attempted", state: "raw",
      why: "the format was not identified, so there is nothing to round-trip" };
  }

  let decoded = null;
  try { decoded = decodeMio0(buf, best); } catch { decoded = null; }
  if (!decoded) {
    return { ...id, roundTrip: "decode-failed", state: "format-identified",
      why: `the ${best.format} header is self-consistent but the stream did not decode. The magic is evidence of the format; a failed decode is NOT evidence it is something else.` };
  }
  const decodedSha = sha(decoded);
  if (decoded.length !== best.destSize) {
    return { ...id, roundTrip: "decode-short", state: "format-identified",
      decodedBytes: decoded.length, expectedBytes: best.destSize,
      why: "the decode produced a different length than the header declares — treat the decode as unverified" };
  }

  if (typeof repack !== "function") {
    return { ...id, roundTrip: "decode-only", state: "format-identified",
      decodedBytes: decoded.length, decodedSha256: decodedSha.slice(0, 16),
      why: "decoded successfully, but no repacker was supplied. A format is only RECOVERED when unpack -> repack reproduces the original "
        + "bytes exactly; decode alone leaves this range at 'format-identified'." };
  }

  let repacked = null;
  try { repacked = repack(decoded); } catch (e) {
    return { ...id, roundTrip: "repack-failed", state: "format-identified", error: String(e?.message ?? e).slice(0, 200) };
  }
  const exact = Buffer.isBuffer(repacked) && repacked.length === buf.length && Buffer.compare(repacked, buf) === 0;
  return {
    ...id,
    roundTrip: exact ? "byte-exact" : "mismatch",
    state: exact ? "round-trip-tool" : "format-identified",
    originalSha256: sha(buf).slice(0, 16), repackedSha256: repacked ? sha(repacked).slice(0, 16) : null,
    decodedBytes: decoded.length, decodedSha256: decodedSha.slice(0, 16),
    why: exact
      ? "unpack -> repack reproduced the original bytes exactly: this range can move to 'round-trip-tool' in the ledger."
      : "the repack did NOT reproduce the original bytes, so the encoder is not yet faithful. The range stays at 'format-identified' — "
        + "a lossy round trip cannot be used to rebuild the ROM.",
  };
}

/**
 * Scan a ROM's bin ranges and report what is identifiable.
 * @param {Buffer} rom
 * @param {Array<{name:string,romStart:number,romEnd:number,type:string}>} ranges
 */
export function scanRanges(rom, ranges) {
  const out = [];
  let identified = 0, identifiedBytes = 0, opaqueBytes = 0;
  for (const r of ranges) {
    const size = Math.max(0, (r.romEnd ?? 0) - (r.romStart ?? 0));
    if (!size) continue;
    const buf = rom.subarray(r.romStart, r.romEnd);
    const id = identify(buf, { name: r.name });
    const known = id.candidates[0].confidence === "high";
    if (known) { identified++; identifiedBytes += size; } else opaqueBytes += size;
    out.push({ name: r.name, romStart: r.romStart, bytes: size, format: id.candidates[0].format, confidence: id.candidates[0].confidence });
  }
  return {
    schema: ASSET_SCHEMA,
    scanned: out.length, identified, identifiedBytes, opaqueBytes,
    ranges: out.sort((a, b) => b.bytes - a.bytes).slice(0, 60),
    note: "identification is by MAGIC and STRUCTURE only — never by the name in the splat yaml, which is a label someone typed. "
      + "`identifiedBytes` may still be far short of the opaque total; that is the honest state, not a failure of the scan.",
  };
}
