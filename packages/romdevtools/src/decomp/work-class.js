// work-class.js — the ONE place that decides what KIND of work a remaining
// function is.
//
// `progress` already separated game / library / handwritten-asm correctly while
// `plan` collapsed them into a single queue: 181 "remaining functions" that
// mixed game C targets with libultra routines, entry code, exception handlers
// and cache primitives. That contradicts the project's own stated policy —
// handwritten assembly is excluded from the decompilation denominator — and
// makes the queue impossible to read. Worse, the two tools could drift, because
// each had its own classifier.
//
// Classes (the reporter's vocabulary, kept verbatim so the two documents and
// the tool agree):
//
//   game-matching-c       the real target: game code that should become
//                         matching C. This is the DEFAULT queue.
//   libultra-known-source SDK code. Should be matched against published
//                         libultra sources BEFORE anyone decompiles it by hand.
//   handwritten-asm-retain  hasm/hcode subsegments and asm/ objects. Policy says
//                         these stay assembly: they belong in completion
//                         accounting, NOT in an automatic C-recovery queue.
//   rsp-source            RSP microcode. A different ISA and a different
//                         toolchain; never a CPU decompilation target.
//   asset-data            data/rodata/bss and bin ranges — not functions at all,
//                         tracked by the completion ledger rather than here.
//
// Plain JS ESM + JSDoc.

import path from "node:path";

/** @typedef {"game-matching-c"|"libultra-known-source"|"handwritten-asm-retain"|"rsp-source"|"asset-data"} WorkClass */

export const WORK_CLASSES = /** @type {WorkClass[]} */ ([
  "game-matching-c",
  "libultra-known-source",
  "handwritten-asm-retain",
  "rsp-source",
  "asset-data",
]);

/** The classes a default decompilation queue should contain. */
export const DEFAULT_QUEUE_CLASSES = /** @type {WorkClass[]} */ (["game-matching-c"]);

export const WORK_CLASS_POLICY = Object.freeze({
  "game-matching-c": "the decompilation target; counts in the denominator",
  "libultra-known-source": "match against published libultra sources first — decompiling by hand is the fallback, not the first move",
  "handwritten-asm-retain": "policy: stays assembly. Counts in completion accounting, never an automatic C-recovery task",
  "rsp-source": "RSP microcode: different ISA and toolchain, not a CPU decompilation target",
  "asset-data": "data/rodata/bss/bin: tracked by the completion ledger, not by the function queue",
});

/**
 * Build a classifier for one project.
 *
 * Returns `(objectPath, symbolName?) => WorkClass`. Classification is by the
 * splat subsegment type and the object path — never by guessing from a name,
 * because a name is not evidence.
 *
 * @param {{segments: Array<{name:string,subsegments:Array<{name:string,type:string}>}>}} splatMap
 * @param {{splat:{buildPath:string,srcPath:string}}} manifest
 */
export function makeWorkClassifier(splatMap, manifest) {
  const buildPath = manifest.splat.buildPath;
  const srcPath = manifest.splat.srcPath;

  // Subsegment type, keyed by BOTH the full subsegment path and its basename.
  //
  // splat names a subsegment by its path relative to the source root
  // ("sys/sys_utils"), while the linker map names the object by its build path
  // ("build/src/sys/sys_utils.o"). Matching on basename alone collides whenever
  // two directories hold the same file name, so the full relative path is tried
  // first and the basename is only a fallback.
  //
  // ONE NAME, SEVERAL SUBSEGMENTS. A single translation unit appears once per
  // section: "sys/sys_utils" is listed as `c`, `.rodata` AND `.bss`. A plain
  // Map.set therefore keeps whichever came LAST (.rodata here), and every one
  // of those objects then classified as data — misfiling 152 real game
  // functions as asset-data and emptying the queue entirely.
  //
  // The CODE-bearing type is the one that decides what kind of work an object
  // is, so a code type always wins over a data type for the same name.
  const CODE_TYPES = new Set(["c", "hasm", "hcode", "asm", "rsp"]);
  const subTypeByPath = new Map(), subTypeByBase = new Map();
  const put = (m, k, t) => {
    if (!m.has(k) || (CODE_TYPES.has(t) && !CODE_TYPES.has(m.get(k)))) m.set(k, t);
  };
  for (const seg of splatMap.segments ?? []) {
    for (const sub of seg.subsegments ?? []) {
      if (!sub?.name) continue;
      put(subTypeByPath, sub.name, sub.type);
      put(subTypeByBase, path.basename(sub.name), sub.type);
    }
  }

  const srcPrefix = buildPath + "/" + srcPath + "/";

  return function classify(objectPath, _symbol) {
    if (!objectPath) return "game-matching-c";
    const base = path.basename(objectPath, ".o");
    // "build/src/sys/sys_utils.o" -> "sys/sys_utils"
    const rel = objectPath.startsWith(srcPrefix) ? objectPath.slice(srcPrefix.length).replace(/\.o$/, "") : null;
    const type = (rel != null ? subTypeByPath.get(rel) : undefined) ?? subTypeByBase.get(base);

    // RSP microcode first: it is assembly AND a different ISA, and calling it
    // handwritten-asm would hide that no CPU toolchain applies to it at all.
    if (/(^|\/)rsp(\/|_)|\bucode\b|\bmicrocode\b/i.test(objectPath) || type === "rsp") return "rsp-source";

    // LIBRARY CODE IS CHECKED FIRST, because libultra objects are BUILT FROM
    // AN asm/ TREE on a real project: `build/asm/us/rev1/libultra/exceptasm.o`.
    // Testing the asm/ prefix before the libultra pattern therefore swallowed
    // all 27 remaining SDK functions into handwritten-asm-retain, emptying the
    // known-source lane the policy text tells you to search FIRST. The ledger
    // counted them as library the whole time, so the two disagreed.
    if (/(^|\/)libultra(\/|_)/.test(objectPath) || /(^|\/)ultra(\/)/.test(objectPath)) return "libultra-known-source";

    // Handwritten assembly: hasm/hcode subsegments, plus anything built out of
    // an asm/ tree rather than the source tree.
    if (type === "hasm" || type === "hcode" || type === "asm") return "handwritten-asm-retain";
    if (objectPath.startsWith(buildPath + "/asm/")) return "handwritten-asm-retain";

    // Pure data subsegments carry no functions; if one ever yields a symbol,
    // it is ledger material, not a decompilation task.
    if (type === "bin" || type === "hdata" || type === ".data" || type === ".rodata" || type === ".bss" || type === "bss" || type === "data" || type === "rodata") return "asset-data";

    // A `c` subsegment IS the game-matching-C target, and so is anything else
    // built from the source tree whose type we do not otherwise recognise.
    // Falling through to asset-data here misfiled 152 real game functions.
    return "game-matching-c";
  };
}

/** Empty per-class tally, in a stable order. */
export function emptyClassTally() {
  const out = {};
  for (const c of WORK_CLASSES) out[c] = { functions: 0, bytes: 0 };
  return out;
}
