// C64 test ROMs - supplying Commodore's KERNAL/BASIC/CHARGEN at runtime.
//
// romdev builds VICE WITHOUT USE_EMBEDDED, so the core no longer carries
// Commodore's copyrighted ROMs (see scripts/patches/vice-no-embedded-roms.patch).
// That is a deliberate licensing decision, and it means a C64 host cannot boot
// until something supplies those three files.
//
// VICE resolves them as bare filenames at the emscripten FS ROOT (`/kernal-...`),
// NOT under the system directory - traced by instrumenting FS.open during a
// failing boot. `systemFiles` writes to /system and therefore does NOT satisfy
// it; the files have to land at "/".
//
// The ROMs are not in the repo and are not redistributable, so tests that need
// a booted C64 SKIP when they are absent rather than fail. They are present in
// a local VICE build tree, which is where a dev who ran scripts/build-vice.sh
// already has them.
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));

/** Candidate locations for VICE's C64 data dir, most-specific first. */
const CANDIDATES = [
  process.env.ROMDEV_C64_ROM_DIR,
  path.join(HERE, "..", "build", "vice_x64", "src", "vice", "data", "C64"),
].filter(Boolean);

/** The three files the C64 will not boot without. */
export const REQUIRED_ROMS = ["kernal-901227-03.bin", "basic-901226-01.bin", "chargen-901225-01.bin"];

/** @returns {string|null} a dir holding all three ROMs, or null. */
export function c64RomDir() {
  for (const d of CANDIDATES) {
    if (d && existsSync(d) && REQUIRED_ROMS.every((r) => existsSync(path.join(d, r)))) return d;
  }
  return null;
}

/** Skip reason for node:test `{ skip }`, or false when the ROMs are available. */
export function c64RomsMissing() {
  return c64RomDir()
    ? false
    : `C64 ROMs not available. romdev ships VICE without Commodore's embedded ROMs, so these tests need `
      + `${REQUIRED_ROMS.join(", ")} in a VICE data dir. Run scripts/build-vice.sh, or point ROMDEV_C64_ROM_DIR at one.`;
}

/**
 * Write VICE's C64 data files into a loaded host's wasm FS root.
 * Call AFTER loadCore and BEFORE loadMedia.
 * @param {object} host a LibretroHost with its core already loaded
 */
export function installC64Roms(host) {
  const dir = c64RomDir();
  if (!dir) throw new Error(c64RomsMissing());
  const mod = host._mod ?? host.mod ?? host.module;
  if (!mod?.FS) throw new Error("installC64Roms: host has no wasm FS - call loadCore first");
  const write = (from) => {
    for (const f of readdirSync(from)) {
      const p = path.join(from, f);
      if (!statSync(p).isFile()) continue;
      try { mod.FS.writeFile("/" + f, new Uint8Array(readFileSync(p))); } catch { /* already present */ }
    }
  };
  write(dir);
  // The 1541 DOS ROM lives in a sibling DRIVES/ dir and is just as embedded-by
  // default as the KERNAL was. Without it the drive never answers, so a .d64
  // autostarts to a READY. prompt instead of running the program - which looks
  // exactly like a working boot until you check whether anything ran.
  const drives = path.join(dir, "..", "DRIVES");
  if (existsSync(drives)) write(drives);
}
