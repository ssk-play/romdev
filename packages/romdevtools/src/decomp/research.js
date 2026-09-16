// research.js - DISCOVERY/HISTORY, kept strictly apart from measurement.
//
// The reporter's §6 failure mode, in their words: "Several queue entries with
// no recorded attempts already had extensive local drafts and experiments.
// Some newer research notes themselves said 'never attempted' while much
// better older drafts existed."
//
// That is expensive in a specific way: it does not merely waste time, it
// causes an agent to rebuild from a worse starting point than one already on
// disk. The unused number renderer had 548-byte SDK-macro drafts with ONE
// difference while another directory was reconstructing it from raw commands.
//
// The model this file implements keeps three things separate, because
// collapsing them is what produced the failure:
//
//   DISCOVERY   what exists on disk: drafts, notes, claims, ancestry.
//   VALIDITY    whether a measurement is still meaningful for the CURRENT
//               tree (romdev's dependency hashing already does this; nothing
//               here may weaken it).
//   DECISION    accepted / rejected / superseded / needs-refresh /
//               inconclusive, with a reason.
//
// The rule that makes this safe: NOTHING imported here is a verified result.
// A note claiming exactness is a CLAIM. It is recorded as a claim, it is
// labelled stale until re-measured, and it can never outrank a failed build or
// differing ROM bytes. Importing research must make a queue better informed,
// never more credulous.

import { readFile, readdir, stat, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";

export const RESEARCH_SCHEMA = "romdev-decomp-research-index-v1";

const sha = (t) => createHash("sha256").update(t).digest("hex");

/** Source files worth indexing as candidate drafts. */
const DRAFT_RE = /\.(c|c\.txt|h)$/i;
const NOTE_RE = /\.(md|txt)$/i;

/** A symbol mentioned in a filename or note body. */
const SYMBOL_RE = /\b((?:func|D)_[A-Za-z0-9_]+)\b/g;

/**
 * Claims a note makes, classified by how much they are worth trusting.
 *
 * "never attempted" is singled out because it is the claim that actively
 * misleads: it is the one assertion whose falsity causes work to be redone.
 */
export function extractClaims(text) {
  const claims = [];
  const t = String(text ?? "");
  const push = (kind, m, confidence) => claims.push({ kind, evidence: m.slice(0, 200), confidence });

  for (const m of t.matchAll(/[^.\n]*\b(never attempted|not attempted|no attempts|untouched)\b[^.\n]*/gi)) {
    push("never-attempted", m[0].trim(), "claim-only");
  }
  for (const m of t.matchAll(/[^.\n]*\b(byte[- ]exact|exact match|matches exactly|fully matching)\b[^.\n]*/gi)) {
    push("claims-exact", m[0].trim(), "claim-only");
  }
  // Counts appear as digits AND as words: the motivating note reads "one
  // strict/linked mismatch" and "five strict/linked differences". Matching
  // only digits missed the single most important lead in the corpus.
  for (const m of t.matchAll(/[^.\n]*\b(\d+|one|two|three|four|five|six|seven|eight|nine|ten)\s+(?:strict\/linked |linked |strict )?(?:difference|mismatch|diff)(?:e?s)?\b[^.\n]*/gi)) {
    push("claims-distance", m[0].trim(), "claim-only");
  }
  for (const m of t.matchAll(/[^.\n]*\b(integrated|integration succeeded|full[- ]rom)\b[^.\n]*/gi)) {
    push("claims-integrated", m[0].trim(), "claim-only");
  }
  return claims;
}

/** Symbols a note or filename refers to. */
export function symbolsIn(text) {
  return [...new Set([...String(text ?? "").matchAll(SYMBOL_RE)].map((m) => m[1]))];
}

/**
 * Walk a research directory and index what is there.
 *
 * Deliberately shallow in judgement: this records what EXISTS. Whether any of
 * it is currently true is decided later, against the live tree.
 */
export async function scanResearch(root, { maxFiles = 20000, maxDepth = 8 } = {}) {
  /** @type {Array<any>} */
  const entries = [];
  let scanned = 0, skipped = 0;
  // A cap that is hit SILENTLY is worse than no cap: the index looks complete
  // and the missing half is exactly the older research this feature exists to
  // surface. Truncation is recorded and reported.
  let truncated = false;

  async function walk(dir, depth) {
    if (depth > maxDepth || scanned >= maxFiles) return;
    let names = [];
    try { names = await readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const d of names) {
      if (scanned >= maxFiles) { skipped++; truncated = true; continue; }
      const p = path.join(dir, d.name);
      if (d.isDirectory()) { await walk(p, depth + 1); continue; }
      if (!DRAFT_RE.test(d.name) && !NOTE_RE.test(d.name)) continue;
      scanned++;
      let text = "", size = 0, mtime = null;
      try {
        const st = await stat(p);
        size = st.size; mtime = new Date(st.mtimeMs).toISOString();
        if (size > 2_000_000) { skipped++; continue; }
        text = await readFile(p, "utf8");
      } catch { skipped++; continue; }

      const isDraft = DRAFT_RE.test(d.name);
      const symbols = [...new Set([...symbolsIn(d.name), ...symbolsIn(text)])];
      entries.push({
        path: p, kind: isDraft ? "draft" : "note", bytes: size, mtime,
        sha256: sha(text).slice(0, 16),
        symbols: symbols.slice(0, 24),
        ...(isDraft ? {} : { claims: extractClaims(text) }),
        ...(isDraft ? { definedFunctions: definedFunctions(text) } : {}),
      });
    }
  }
  await walk(root, 0);
  return { root, entries, scanned, skipped, truncated,
    ...(truncated ? { truncatedNote: `the scan stopped at maxFiles=${maxFiles} and ${skipped} file(s) were not indexed. The index is INCOMPLETE - raise maxFiles, because the files it missed are exactly the older research this index exists to surface.` } : {}) };
}

/** Function definitions a draft actually contains (not merely mentions). */
export function definedFunctions(src) {
  const out = [];
  for (const m of String(src ?? "").matchAll(/^[A-Za-z_][\w \t*]*\b(func_[A-Za-z0-9_]+)\s*\([^;{}]*\)\s*\{/gm)) {
    out.push(m[1]);
  }
  return [...new Set(out)];
}

/**
 * Group an index by symbol, so a queue entry can be asked "what already exists
 * for this function?" - the question that was previously unanswerable.
 */
export function bySymbol(index) {
  /** @type {Map<string, {drafts:Array, notes:Array}>} */
  const map = new Map();
  for (const e of index.entries) {
    // A draft is attributed to the functions it DEFINES; a note to the
    // functions it mentions. Attributing a draft by mere mention would let a
    // file that merely calls a function claim to implement it.
    const targets = e.kind === "draft" ? (e.definedFunctions?.length ? e.definedFunctions : e.symbols) : e.symbols;
    for (const sym of targets) {
      if (!map.has(sym)) map.set(sym, { drafts: [], notes: [] });
      map.get(sym)[e.kind === "draft" ? "drafts" : "notes"].push(e);
    }
  }
  return map;
}

/**
 * Conflicting notes about one symbol, pointing at the actual candidates.
 *
 * The concrete case: one directory's README said the number renderer had never
 * been attempted while another recorded a one-difference draft. Both notes are
 * kept; the conflict is reported rather than resolved by recency, because the
 * newer note was the WRONG one.
 */
export function conflicts(map) {
  const out = [];
  for (const [symbol, g] of map) {
    const neverAttempted = g.notes.filter((n) => n.claims?.some((c) => c.kind === "never-attempted"));
    if (neverAttempted.length && (g.drafts.length || g.notes.some((n) => n.claims?.some((c) => c.kind === "claims-distance")))) {
      out.push({
        symbol, kind: "never-attempted-contradicted",
        claim: neverAttempted.map((n) => n.path),
        contradictedBy: [...g.drafts.map((d) => d.path), ...g.notes.filter((n) => n.claims?.some((c) => c.kind === "claims-distance")).map((n) => n.path)].slice(0, 8),
        why: "a note says this function was never attempted, but drafts or measured results for it exist. Recency does not settle this: the newer note was the wrong one in the case that motivated this check.",
      });
    }
  }
  return out;
}

/**
 * Turn the index into per-symbol RESEARCH LEADS, each with an explicit
 * decision state and the reason for it.
 *
 * `state` is never "verified". The best this function can say is
 * `needs-refresh`: a promising draft that has not been measured against the
 * current tree.
 */
export function leadsFor(map, { measuredSymbols = new Set() } = {}) {
  const leads = [];
  for (const [symbol, g] of map) {
    if (!g.drafts.length && !g.notes.length) continue;
    const distanceClaims = g.notes.flatMap((n) => (n.claims ?? []).filter((c) => c.kind === "claims-distance").map((c) => ({ note: n.path, evidence: c.evidence })));
    const exactClaims = g.notes.flatMap((n) => (n.claims ?? []).filter((c) => c.kind === "claims-exact").map((c) => ({ note: n.path, evidence: c.evidence })));
    // The smallest claimed difference count anywhere in the notes, as a HINT
    // for ordering refresh work. It is a claim, not a measurement.
    const WORD_NUM = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10 };
    let bestClaimed = null;
    for (const c of distanceClaims) {
      const m = /\b(\d+|one|two|three|four|five|six|seven|eight|nine|ten)\s+(?:strict\/linked |linked |strict )?(?:difference|mismatch|diff)/i.exec(c.evidence);
      if (m) {
        const raw = m[1].toLowerCase();
        const n = /^\d+$/.test(raw) ? Number(raw) : WORD_NUM[raw];
        if (n != null && (bestClaimed == null || n < bestClaimed)) bestClaimed = n;
      }
    }
    leads.push({
      symbol,
      drafts: g.drafts.map((d) => ({ path: d.path, bytes: d.bytes, mtime: d.mtime, sha256: d.sha256 })),
      notes: g.notes.map((n) => ({ path: n.path, mtime: n.mtime, claims: n.claims })),
      claimedBestDistance: bestClaimed,
      claimsExact: exactClaims.length > 0,
      state: measuredSymbols.has(symbol) ? "has-current-measurement" : g.drafts.length ? "needs-refresh" : "notes-only",
      stateReason: measuredSymbols.has(symbol)
        ? "a measurement against the CURRENT tree exists; these research files are history and do not override it"
        : g.drafts.length
          ? "drafts exist on disk but none has been measured against the current tree: refresh before trusting any number in the notes"
          : "notes only, no draft source found: treat every number here as a claim",
      policy: "IMPORTED RESEARCH IS NEVER A VERIFIED RESULT. A note claiming exactness cannot override a failed build or differing ROM bytes.",
    });
  }
  // Most promising first: a small claimed distance is the best refresh lead.
  leads.sort((a, b) => (a.claimedBestDistance ?? 1e9) - (b.claimedBestDistance ?? 1e9));
  return leads;
}

/**
 * Import a research directory into the project workspace.
 *
 * Writes an index that `plan` can consult so a queue entry can say "drafts
 * exist" instead of "never attempted".
 */
export async function importResearch(project, { root, maxFiles = 20000, measuredSymbols = new Set() } = {}) {
  if (!root) throw Object.assign(new Error("decomp({op:'research', action:'import'}): `root` (a directory to index) is required."), { code: "BAD_ARGS" });
  const index = await scanResearch(root, { maxFiles });
  const map = bySymbol(index);
  const leads = leadsFor(map, { measuredSymbols });
  const conflictList = conflicts(map);

  const dir = path.join(project.ws, "research");
  await mkdir(dir, { recursive: true });
  const outPath = path.join(dir, `index-${sha(root).slice(0, 12)}.json`);
  const doc = {
    schema: RESEARCH_SCHEMA, root, importedAt: new Date().toISOString(),
    files: index.entries.length, scanned: index.scanned, skipped: index.skipped,
    complete: !index.truncated, ...(index.truncated ? { truncated: true, truncatedNote: index.truncatedNote } : {}),
    symbols: map.size, leads, conflicts: conflictList,
  };
  await writeFile(outPath, JSON.stringify(doc, null, 1));
  return { ...doc, indexPath: outPath, leads: leads.slice(0, 40), leadsTotal: leads.length };
}

/** Load every stored research index for a project. */
export async function loadResearch(project) {
  const dir = path.join(project.ws, "research");
  let names = [];
  try { names = (await readdir(dir)).filter((f) => f.startsWith("index-") && f.endsWith(".json")); } catch { return []; }
  const out = [];
  for (const n of names) {
    try { out.push(JSON.parse(await readFile(path.join(dir, n), "utf8"))); } catch {}
  }
  return out;
}

/**
 * Research leads keyed by symbol, for `plan` to fold into its queue.
 * Returns a Map so a queue row can answer "is there prior art?" in O(1).
 */
export async function researchBySymbol(project) {
  const map = new Map();
  for (const doc of await loadResearch(project)) {
    for (const lead of doc.leads ?? []) {
      const prev = map.get(lead.symbol);
      if (!prev || (lead.claimedBestDistance ?? 1e9) < (prev.claimedBestDistance ?? 1e9)) map.set(lead.symbol, lead);
    }
  }
  return map;
}
