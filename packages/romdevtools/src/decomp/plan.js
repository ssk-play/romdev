// plan.js — work selection over the call graph, so related functions are
// decompiled together and type information is shared, and so the queue is
// ordered by expected payoff (code bytes) rather than by "shortest first",
// which inflates the function count while leaving most bytes untouched.
//
// The graph comes from the build's objects (relocation records: every
// R_MIPS_26 is a static call edge) and from the extracted asm of the
// functions still in assembly. Nothing is inferred from names.
import fs from "node:fs";
import path from "node:path";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dumpObject, symbolTable } from "./mips-obj.js";
import { parseSplatAsm } from "./splat-map.js";
import { VERIFIER_VERSION } from "./verdict.js";

/** Build (and cache by object mtimes) the static call graph of the project. */
export async function callGraph(project, { force = false } = {}) {
  const ld = await project.linkerMap();
  if (!ld) throw Object.assign(new Error("no linker map — build the project first"), { code: "NO_BUILD" });
  const cache = path.join(project.ws, "callgraph.json");
  const objects = [...ld.objects.keys()].filter((o) => o.startsWith(project.m.splat.buildPath + "/" + project.m.splat.srcPath + "/"));
  const stamp = objects.map((o) => { try { return fs.statSync(project.abs(o)).mtimeMs; } catch { return 0; } }).reduce((a, b) => a + b, 0);
  if (!force && fs.existsSync(cache)) {
    try { const c = JSON.parse(await readFile(cache, "utf8")); if (c.stamp === stamp) return c; } catch {}
  }
  const objdump = project.m.toolchain.objdump?.path ?? "mips-linux-gnu-objdump";
  const edges = new Map(); // caller → Set(callee)
  const sizes = new Map(), state = new Map(), objOf = new Map();
  const nonMatching = new Set([...ld.symbols.keys()].filter((n) => n.endsWith(".NON_MATCHING")).map((n) => n.slice(0, -13)));
  for (const s of ld.symbols.values()) if (s.section === ".text" && s.size && !s.name.endsWith(".NON_MATCHING")) { sizes.set(s.name, s.size); state.set(s.name, nonMatching.has(s.name) ? "asm" : "c"); objOf.set(s.name, s.object); }
  for (const o of objects) {
    const abs = project.abs(o);
    if (!fs.existsSync(abs)) continue;
    let dump;
    try { dump = await dumpObject({ objdump, objPath: abs, cwd: project.root, env: project.env }); } catch { continue; }
    for (const [name, sym] of dump.sections.get(".text") ?? []) {
      if (name.endsWith(".NON_MATCHING")) continue;
      for (const ins of sym.instructions) {
        if (ins.reloc && ins.reloc.type === "R_MIPS_26") { if (!edges.has(name)) edges.set(name, new Set()); edges.get(name).add(ins.reloc.symbol); }
      }
    }
  }
  const callers = new Map();
  for (const [a, set] of edges) for (const b of set) { if (!callers.has(b)) callers.set(b, new Set()); callers.get(b).add(a); }
  const out = { stamp, builtAt: new Date().toISOString(), functions: [...sizes.keys()].length,
    edges: Object.fromEntries([...edges].map(([k, v]) => [k, [...v]])), callers: Object.fromEntries([...callers].map(([k, v]) => [k, [...v]])),
    sizes: Object.fromEntries(sizes), state: Object.fromEntries(state), object: Object.fromEntries(objOf) };
  await mkdir(project.ws, { recursive: true });
  await writeFile(cache, JSON.stringify(out));
  return out;
}

/**
 * Rank the remaining asm functions and group them into batches that share
 * types: a batch is the asm functions of one TU that call or are called by
 * each other (connected components of the asm-only subgraph), plus their
 * already-C neighbours as context. Score = expected payoff.
 */
export async function planWork(project, { limit = 40, tu, evidence } = {}) {
  const g = await callGraph(project);
  const asm = Object.keys(g.state).filter((n) => g.state[n] === "asm" && (!tu || objectToTu(g.object[n], project) === tu));
  // Compute the CURRENT dependency hash of every TU that owns a remaining
  // function, so evidence is matched against the source tree as it is now
  // rather than against whichever result file was written most recently.
  // One hash per TU, not per function — the TUs are far fewer.
  const currentDependencyHashes = await currentDepHashes(project, asm, g);
  const hints = evidence ?? (await loadCandidateEvidence(project, { currentDependencyHashes }));
  const rows = asm.map((n) => {
    const size = g.sizes[n] ?? 0;
    const callees = g.edges[n] ?? [], callersOf = g.callers[n] ?? [];
    const asmCallees = callees.filter((c) => g.state[c] === "asm"), cCallees = callees.filter((c) => g.state[c] === "c");
    const asmCallers = callersOf.filter((c) => g.state[c] === "asm"), cCallers = callersOf.filter((c) => g.state[c] === "c");
    const h = hints[n] ?? {};
    // Uncertainty: what the last attempts told us (0 = never tried).
    const uncertainty = h.lastDistance == null ? 0.5 : Math.min(1, h.lastDistance / Math.max(1, size / 4)) ;
    const typedNeighbours = cCallees.length + cCallers.length;
    // Payoff: bytes recovered, discounted by uncertainty, boosted when typed C neighbours already pin the types.
    const payoff = Math.round(size * (1 - 0.5 * uncertainty) * (1 + 0.1 * Math.min(typedNeighbours, 5)));
    return { symbol: n, sizeBytes: size, object: g.object[n], tu: objectToTu(g.object[n], project), asmCallees, cCallees: cCallees.length, asmCallers, cCallers: cCallers.length, statically: callersOf.length === 0 ? "unreferenced (no static caller: a table/pointer target or dead)" : `${callersOf.length} static callers`,
      attempts: h.attempts ?? 0, lastDistance: h.lastDistance ?? null, lastCompile: h.lastCompile ?? null, placeholderPrototype: h.placeholderPrototype ?? null, payoff,
      // Evidence identity, so a score can be traced to the tree it was measured on.
      evidenceDependencyHash: h.dependencyHash ?? null,
      ...(h.historicalAttempts ? { historicalAttempts: h.historicalAttempts, historicalBestDistance: h.historicalBestDistance ?? null } : {}),
      ...(h.staleEvidenceWarning ? { staleEvidenceWarning: h.staleEvidenceWarning } : {}) };
  }).sort((a, b) => b.payoff - a.payoff);
  // Batches: connected components over asm↔asm edges within one TU.
  const byName = new Map(rows.map((r) => [r.symbol, r]));
  const seen = new Set(); const batches = [];
  for (const r of rows) {
    if (seen.has(r.symbol)) continue;
    const comp = []; const stack = [r.symbol];
    while (stack.length) {
      const n = stack.pop(); if (seen.has(n) || !byName.has(n)) continue;
      seen.add(n); comp.push(n);
      const row = byName.get(n);
      for (const m of [...row.asmCallees, ...row.asmCallers]) if (byName.has(m) && byName.get(m).tu === row.tu) stack.push(m);
    }
    const bytes = comp.reduce((s, n) => s + byName.get(n).sizeBytes, 0);
    batches.push({ tu: r.tu, functions: comp, bytes, payoff: comp.reduce((s, n) => s + byName.get(n).payoff, 0), reason: comp.length > 1 ? "call each other inside one TU — decompile together so the shared struct/prototype fixes land once" : "isolated in its TU" });
  }
  batches.sort((a, b) => b.payoff - a.payoff);
  return { functionsRemaining: rows.length, bytesRemaining: rows.reduce((s, r) => s + r.sizeBytes, 0), queue: rows.slice(0, limit), batches: batches.slice(0, Math.max(10, Math.ceil(limit / 3))),
    evidencePolicy: `Ranking uses ONLY evidence whose dependency hash matches the TU's CURRENT hash (${currentDependencyHashes.size} live TU hashes). Attempts measured against a different source tree appear as historicalAttempts/historicalBestDistance and never affect payoff — a stale best that still looks good is what misranks a queue. \`lastCompile\` is the newest compatible attempt, not the last file read.`,
    scoring: "payoff = bytes × (1 − 0.5 × uncertainty) × (1 + 0.1 × min(typed C neighbours, 5)); uncertainty = 0.5 untried, else lastDistance / instruction count. Static caller counts come from R_MIPS_26 relocations in the built objects; 'unreferenced' means no static jal — a jump-table or function-pointer target, or dead code — NOT proof of unreachability." };
}

/**
 * The dependency hash each remaining function's TU hashes to RIGHT NOW.
 *
 * compile.js keys every stored result on this hash, so it is the only honest
 * way to ask "was this evidence measured against the tree I have?". Computed
 * per TU (there are far fewer TUs than functions) and best-effort: a TU whose
 * hash cannot be computed simply contributes nothing, and evidence for it
 * falls back to the newest-written group.
 */
async function currentDepHashes(project, symbols, g) {
  const { dependencyHash } = await import("./project.js");
  const tus = new Set();
  for (const n of symbols) { const t = objectToTu(g.object[n], project); if (t) tus.add(t); }
  const hashes = new Set();
  await Promise.all([...tus].map(async (tuRel) => {
    try {
      const inv = await project.compileInvocation(tuRel);
      const dep = await dependencyHash(project, tuRel, inv);
      if (dep?.hash) hashes.add(dep.hash);
    } catch { /* unbuildable/missing TU: no current hash to match against */ }
  }));
  return hashes;
}

function objectToTu(obj, project) {
  if (!obj) return null;
  const b = project.m.splat.buildPath + "/";
  return obj.startsWith(b) ? obj.slice(b.length).replace(/\.o$/, ".c") : obj;
}

/** What every stored compare result says about a function, in one line per function. */
export async function loadCandidateEvidence(project, { currentDependencyHashes } = {}) {
  const dir = path.join(project.ws, "candidates");
  const out = {};
  if (!fs.existsSync(dir)) return out;
  // A result's identity lives in its FILENAME: `<dependencyHash>-<candidateSha>-v<verifier>`.
  // (compile.js builds exactly that key, so the cache already honours it.)
  const ID = /^([0-9a-f]+)-([0-9a-f]+)-v(\d+)\.result\.json$/;
  const currentSet = currentDependencyHashes ? new Set(currentDependencyHashes) : null;

  for (const sym of fs.readdirSync(dir)) {
    const d = path.join(dir, sym);
    let placeholder = null;
    // Per dependency hash, so evidence from a different source tree can never
    // be mixed into the current score.
    const byDep = new Map();
    let unidentified = 0;

    for (const f of fs.readdirSync(d)) {
      if (f.endsWith(".result.json")) {
        const m = ID.exec(f);
        let mtime = 0;
        try { mtime = fs.statSync(path.join(d, f)).mtimeMs; } catch {}
        try {
          const r = JSON.parse(fs.readFileSync(path.join(d, f), "utf8"));
          const dep = m?.[1] ?? null;
          if (!dep) { unidentified++; continue; }   // pre-identity file: countable, never rankable
          if (!byDep.has(dep)) byDep.set(dep, { dep, attempts: 0, best: null, lastCompile: null, newestMs: 0 });
          const e = byDep.get(dep);
          e.attempts++;
          // `lastCompile` must be the NEWEST attempt, not whichever file the
          // directory happened to yield last.
          if (mtime >= e.newestMs) { e.newestMs = mtime; e.lastCompile = r.compileSucceeded; }
          if (r.distance && (e.best == null || r.distance.value < e.best)) e.best = r.distance.value;
          if (r.verdict?.functionLocal === "exact" && r.verifierVersion === VERIFIER_VERSION) e.best = 0;
        } catch {}
      } else if (/^gen-\d+\.json$/.test(f)) {
        try { const g = JSON.parse(fs.readFileSync(path.join(d, f), "utf8")); if (g.contextPrototype?.placeholderPointerTypes != null) placeholder = g.contextPrototype.placeholderPointerTypes; } catch {}
      }
    }

    const groups = [...byDep.values()].sort((a, b) => b.newestMs - a.newestMs);
    // WHICH GROUP IS "CURRENT". When the caller knows the TU's dependency hash
    // (planWork computes it), that is authoritative. Otherwise fall back to the
    // most recently written group, which is the best available proxy.
    const current = (currentSet && groups.find((g) => currentSet.has(g.dep))) ?? groups[0] ?? null;
    const historical = groups.filter((g) => g !== current);

    out[sym] = {
      // Ranking fields describe the CURRENT tree only.
      attempts: current?.attempts ?? 0,
      lastDistance: current?.best ?? null,
      lastCompile: current?.lastCompile ?? null,
      placeholderPrototype: placeholder,
      dependencyHash: current?.dep ?? null,
      // Everything else stays VISIBLE but out of the score. A stale best that
      // still looks good is exactly what misranks the queue: on this workspace
      // func_801EB4F4 scored 6.8 from an old header layout while the current
      // tree gives 82.45 — a 12x misranking that would send a permuter budget
      // at a function that is not close.
      historicalAttempts: historical.reduce((s, g) => s + g.attempts, 0),
      historicalBestDistance: historical.length ? Math.min(...historical.map((g) => g.best).filter((v) => v != null)) : null,
      dependencyHashesSeen: groups.length,
      ...(unidentified ? { unidentifiedResults: unidentified } : {}),
      ...(historical.length && current?.best != null
        && historical.some((g) => g.best != null && g.best < current.best)
        ? { staleEvidenceWarning: "an OLDER dependency hash scored better; that evidence is excluded from ranking because it was measured against a different source tree" }
        : {}),
    };
  }
  return out;
}

/**
 * Run generate → compare for every function of a batch (bounded), sharing
 * one context. Returns per-function verdicts; never integrates.
 */
export async function runBatch(project, symbols, { maxFunctions = 12, timeBudgetS = 600 } = {}) {
  const { generateCandidate } = await import("./m2c.js");
  const { compileAndCompare } = await import("./compile.js");
  const started = Date.now();
  const results = [];
  for (const sym of symbols.slice(0, maxFunctions)) {
    if ((Date.now() - started) / 1000 > timeBudgetS) { results.push({ symbol: sym, skipped: "time budget exhausted" }); continue; }
    const t0 = Date.now();
    try {
      const fn = await project.resolveFunction({ symbol: sym });
      const g = await generateCandidate(project, fn);
      const r = await compileAndCompare(project, fn, { candidateText: g.code, candidatePath: g.candidatePath, label: "batch" });
      results.push({ symbol: sym, sizeBytes: fn.sizeBytes, candidatePath: g.candidatePath, compileSucceeded: r.compileSucceeded, exactFunctionMatch: r.exactFunctionMatch, functionLocal: r.verdict?.functionLocal ?? r.verification?.functionLocal ?? null, verdictReasons: r.verdict?.reasons ?? [], romLinked: r.romLinked?.status ?? null, distance: r.distance?.value ?? null, kinds: r.differenceKinds ?? [], hint: r.hint, placeholderPrototype: g.contextPrototype?.placeholderPointerTypes ?? null, missingDeclarations: g.missingDeclarations.map((m) => m.name), ms: Date.now() - t0, cacheHit: r.cacheHit });
    } catch (e) { results.push({ symbol: sym, error: `${e.code ?? "ERROR"}: ${e.message.slice(0, 200)}`, ms: Date.now() - t0 }); }
  }
  const exact = results.filter((r) => r.exactFunctionMatch && r.functionLocal === "exact").length;
  return { functions: results.length, exactMatches: exact, compiled: results.filter((r) => r.compileSucceeded).length, elapsedMs: Date.now() - started, results,
    sharedBlockers: summarizeBlockers(results) };
}

function summarizeBlockers(results) {
  const counts = {};
  for (const r of results) {
    const k = r.error ? "error" : r.functionLocal === "exact" ? "exact" : r.compileSucceeded ? (r.functionLocal ?? "mismatch") : r.hint ? "compile-failed: " + r.hint.split(":")[0] : r.missingDeclarations?.length ? "compile-failed: undeclared symbols the draft needs (missingDeclarations)" : "compile-failed";
    counts[k] = (counts[k] ?? 0) + 1;
  }
  return counts;
}
