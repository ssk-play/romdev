// semantic-gate.js — a byte-exact candidate is not automatically a correct one.
//
// THE DISTINCTION THIS FILE EXISTS TO PRESERVE. A permuter or sweep optimises a
// SCORE. It will happily reach zero by writing code that no human wrote and no
// human should ship: a self-assignment that claims a register, an empty branch
// that pads a delay slot, a comma-zero expression, an unused stack slot claimed
// to shift the frame. Those candidates are genuinely byte-exact. They are also
// artificial, and integrating one silently converts a matching build into a
// source tree nobody can maintain.
//
// So the gate NEVER erases the exactness result. It classifies:
//
//   byte-exact/plausible      reads like source a person would write
//   byte-exact/review-needed  something here needs a human's eyes
//   byte-exact/artificial     contains constructs whose only purpose is the
//                             byte match
//
// and it is advisory about semantics it cannot prove. A checker that claimed
// certainty about pointer provenance from a regex would be worse than no
// checker, so every finding carries its own confidence and the reason it fired.
//
// Plain JS ESM + JSDoc.

/** @typedef {{id:string, severity:"artificial"|"review"|"info", confidence:"high"|"medium"|"low", message:string, evidence?:string, line?:number}} Finding */

/** Strip strings, chars and comments so a lexical scan cannot fire inside them. */
function stripLiterals(src) {
  let out = "";
  let i = 0;
  const n = src.length;
  while (i < n) {
    const c = src[i], d = src[i + 1];
    if (c === "/" && d === "/") { while (i < n && src[i] !== "\n") { out += src[i] === "\n" ? "\n" : " "; i++; } continue; }
    if (c === "/" && d === "*") { i += 2; while (i < n && !(src[i] === "*" && src[i + 1] === "/")) { out += src[i] === "\n" ? "\n" : " "; i++; } i += 2; out += "  "; continue; }
    if (c === '"' || c === "'") {
      const q = c; out += " "; i++;
      while (i < n && src[i] !== q) { if (src[i] === "\\") { out += " "; i++; } out += src[i] === "\n" ? "\n" : " "; i++; }
      out += " "; i++; continue;
    }
    out += c; i++;
  }
  return out;
}

const lineOf = (src, index) => src.slice(0, index).split("\n").length;

/**
 * Lexical checks for the artificial constructs a score-optimiser produces.
 * These are HIGH confidence: each pattern has no legitimate purpose in
 * decompiled source, which is exactly why a mutation search reaches for them.
 */
function artificialConstructs(src) {
  /** @type {Finding[]} */
  const out = [];
  const s = stripLiterals(src);

  // `x = x;` — claims a register without changing anything.
  for (const m of s.matchAll(/(?<![\w.>])([A-Za-z_]\w*)\s*=\s*\1\s*;/g)) {
    out.push({ id: "self-assignment", severity: "artificial", confidence: "high",
      message: `'${m[1]} = ${m[1]};' is a self-assignment: it exists to claim a register, not to compute anything`,
      evidence: m[0], line: lineOf(s, m.index) });
  }
  // `if (...) { }` / `else { }` — an empty branch shifts scheduling only.
  for (const m of s.matchAll(/\b(if|else|while|for)\s*(\([^;{}]*\))?\s*\{\s*\}/g)) {
    out.push({ id: "empty-branch", severity: "artificial", confidence: "high",
      message: `empty '${m[1]}' body: it changes scheduling or block layout and nothing else`,
      evidence: m[0].replace(/\s+/g, " ").slice(0, 80), line: lineOf(s, m.index) });
  }
  // `(x, 0)` — a comma expression discarding its left operand.
  for (const m of s.matchAll(/\(\s*[A-Za-z_]\w*\s*,\s*0\s*\)/g)) {
    out.push({ id: "comma-zero", severity: "artificial", confidence: "high",
      message: "comma-zero expression: the left operand's value is discarded; this is a codegen lever, not logic",
      evidence: m[0], line: lineOf(s, m.index) });
  }
  // A declared local that is never read again — often a claimed stack slot.
  for (const m of s.matchAll(/\b(?:s32|u32|f32|s16|u16|s8|u8|int|float|void\s*\*)\s+(pad\w*|unused\w*|dummy\w*|sp[0-9A-Fa-f]+)\s*;/g)) {
    out.push({ id: "claimed-slot", severity: "review", confidence: "medium",
      message: `'${m[1]}' looks like a claimed stack slot rather than a real local`,
      evidence: m[0], line: lineOf(s, m.index) });
  }
  // A `FAKE`/`HACK` marker the author left behind.
  for (const m of s.matchAll(/\b(FAKE|HACK|BUG|NONMATCHING|PERMUTER)\b/g)) {
    out.push({ id: "author-marker", severity: "review", confidence: "high",
      message: `'${m[1]}' marker present: the author flagged this as not-real source`,
      evidence: m[0], line: lineOf(s, m.index) });
  }
  // A one-element array local. `Mtx m[1];` occupies a home and is addressed
  // like a scalar, so it is a common way to buy an offset without declaring
  // the object that actually lives there. REVIEW, not artificial: real code
  // does declare `[1]` arrays, and calling that automatically wrong would be
  // the same overreach as approving every cast.
  for (const m of s.matchAll(/\b([A-Za-z_]\w*)\s+([A-Za-z_]\w*)\s*\[\s*1\s*\]\s*;/g)) {
    out.push({ id: "one-element-array", severity: "review", confidence: "medium",
      message: `'${m[2]}[1]' is a one-element array: it claims a stack home with the alignment of ${m[1]}. Confirm the original declares an array, not a scalar`,
      evidence: m[0], line: lineOf(s, m.index) });
  }
  // A cast between two POINTER types, which can change what the callee is
  // handed. The reporter's own case: passing Mtx_t* where Mtx* is declared
  // matched the frame size but is a different contract with the callee.
  for (const m of s.matchAll(/\(\s*([A-Za-z_]\w*)\s*\*\s*\)\s*(?:&\s*)?([A-Za-z_]\w*)/g)) {
    out.push({ id: "pointer-cast", severity: "review", confidence: "low",
      message: `cast to '${m[1]} *': a pointer cast can change the contract with the callee (element size, alignment, or how many bytes it writes). Check the callee's declared parameter, not just the frame size`,
      evidence: m[0].replace(/\s+/g, " "), line: lineOf(s, m.index) });
  }
  return out;
}

/**
 * Checks that compare a candidate against the source it was derived from.
 * These are the behaviour-changing classes the reporter listed. They are
 * MEDIUM/LOW confidence by construction: proving them needs dataflow, and a
 * lexical pass that claimed otherwise would be the worse failure.
 */
function behaviouralDeltas(baseline, candidate) {
  /** @type {Finding[]} */
  const out = [];
  if (!baseline) return out;
  const a = stripLiterals(baseline), b = stripLiterals(candidate);

  const count = (re, s) => (s.match(re) ?? []).length;

  // volatile is an ORDERING contract: dropping it lets the compiler move or
  // fold hardware accesses.
  const va = count(/\bvolatile\b/g, a), vb = count(/\bvolatile\b/g, b);
  if (vb < va) out.push({ id: "volatile-dropped", severity: "artificial", confidence: "high",
    message: `'volatile' count fell ${va} -> ${vb}: this changes the ordering guarantees of hardware or shared-memory accesses` });

  // A call disappearing changes observable behaviour even if bytes match by
  // coincidence of inlining.
  const callsA = new Set([...a.matchAll(/\b([A-Za-z_]\w*)\s*\(/g)].map((m) => m[1]));
  const callsB = new Set([...b.matchAll(/\b([A-Za-z_]\w*)\s*\(/g)].map((m) => m[1]));
  const KEYWORDS = new Set(["if", "while", "for", "switch", "return", "sizeof", "do"]);
  const lost = [...callsA].filter((n) => !callsB.has(n) && !KEYWORDS.has(n));
  if (lost.length) out.push({ id: "call-removed", severity: "review", confidence: "medium",
    message: `call(s) present in the baseline and absent from the candidate: ${lost.slice(0, 6).join(", ")}`,
    evidence: lost.slice(0, 6).join(", ") });

  // AN ARGUMENT THAT BECAME NULL, or a call that lost arguments.
  //
  // `call-removed` above only fires when a call DISAPPEARS. A call that
  // survives while one of its arguments is replaced with NULL -- or dropped
  // entirely -- is the case the reporter named: a helper that writes through an
  // output pointer is silently no longer given one. Bytes can still match; the
  // callee no longer writes where the original wrote.
  // Scan with a paren counter rather than a regex: `guMtxIdent((Mtx*)0)` has
  // parentheses INSIDE its argument list, and `\(([^()]*)\)` cannot match it —
  // so a cast NULL, the most natural way to write this defect in C, was
  // invisible while a bare NULL was caught.
  const callArgs = (src) => {
    const out2 = new Map();
    const re = /\b([A-Za-z_]\w*)\s*\(/g;
    let m;
    while ((m = re.exec(src))) {
      if (KEYWORDS.has(m[1])) continue;
      let depth = 1, i = re.lastIndex;
      for (; i < src.length && depth > 0; i++) {
        if (src[i] === "(") depth++;
        else if (src[i] === ")") depth--;
      }
      if (depth !== 0) continue;                 // unbalanced: skip rather than guess
      const inner = src.slice(re.lastIndex, i - 1);
      // Split on top-level commas only, so `f(g(a, b), c)` is two arguments.
      const args = [];
      let cur = "", d = 0;
      for (const ch of inner) {
        if (ch === "(") d++;
        else if (ch === ")") d--;
        if (ch === "," && d === 0) { args.push(cur.trim()); cur = ""; continue; }
        cur += ch;
      }
      if (cur.trim() !== "" || args.length) args.push(cur.trim());
      // Keep the FIRST occurrence: a call repeated with different arguments is
      // a different question, and guessing which one to compare would be worse
      // than comparing the one we can name.
      if (!out2.has(m[1])) out2.set(m[1], args);
    }
    return out2;
  };
  const argsA = callArgs(a), argsB = callArgs(b);
  // NULL in the spellings real source uses: NULL, 0, nullptr, and any of those
  // behind a cast -- `(Mtx*)0` is the same defect as `NULL` and was slipping
  // through a pattern that only allowed the cast in one position.
  const NULLISH = (x) => /^(?:\([^)]*\)\s*)*\(?\s*(?:\([^)]*\)\s*)*(?:NULL|0|0[xX]0+|nullptr)\s*\)?$/.test(String(x).trim());
  for (const [name, aArgs] of argsA) {
    const bArgs = argsB.get(name);
    if (!bArgs) continue;                       // handled by call-removed
    if (bArgs.length < aArgs.length) {
      out.push({ id: "call-argument-dropped", severity: "artificial", confidence: "high",
        message: `'${name}' is called with ${bArgs.length} argument(s) where the baseline passed ${aArgs.length}. If the dropped argument was an output pointer, the callee no longer writes where the original wrote`,
        evidence: `${name}(${aArgs.join(", ")}) -> ${name}(${bArgs.join(", ")})` });
      continue;
    }
    for (let i = 0; i < Math.min(aArgs.length, bArgs.length); i++) {
      if (aArgs[i] === bArgs[i]) continue;
      if (NULLISH(bArgs[i]) && !NULLISH(aArgs[i])) {
        out.push({ id: "output-argument-nulled", severity: "artificial", confidence: "high",
          message: `'${name}' argument ${i + 1} became ${bArgs[i]} where the baseline passed '${aArgs[i]}'. A helper given NULL instead of a destination does not write its result — the bytes can still match while the behaviour does not`,
          evidence: `${name}(... ${aArgs[i]} ...) -> ${name}(... ${bArgs[i]} ...)` });
      }
    }
  }

  // Signed/unsigned and division changes alter overflow and rounding.
  const ua = count(/\bunsigned\b|\bu(8|16|32)\b/g, a), ub = count(/\bunsigned\b|\bu(8|16|32)\b/g, b);
  if (ua !== ub) out.push({ id: "signedness-changed", severity: "review", confidence: "low",
    message: `unsigned-type mentions changed ${ua} -> ${ub}: check overflow, shift and division semantics` });
  const da = count(/[^/]\/[^/*=]|%/g, a), db = count(/[^/]\/[^/*=]|%/g, b);
  if (da !== db) out.push({ id: "division-changed", severity: "review", confidence: "low",
    message: `division/modulo operator count changed ${da} -> ${db}: check signed division and modulo-by-zero behaviour` });

  // && / || carry short-circuit semantics; converting to & / | evaluates both.
  const sa = count(/&&|\|\|/g, a), sb = count(/&&|\|\|/g, b);
  if (sb < sa) out.push({ id: "short-circuit-lost", severity: "artificial", confidence: "medium",
    message: `short-circuit operators fell ${sa} -> ${sb}: if && / || became & / |, the right operand is now ALWAYS evaluated` });

  // A WRITE to a global the baseline never wrote. Storing to a `D_`/`g`-prefixed
  // symbol to nudge register allocation changes memory another function reads;
  // the bytes can match while the game does not. Assignments only — a global
  // that is merely READ more often is not a behaviour change.
  const GLOBAL_WRITE = /\b((?:D_|g[A-Z])\w*)\s*(?:\[[^\]]*\]|\.\w+|->\w+)*\s*(?:=(?!=)|\+\+|--|[-+*/&|^]=|<<=|>>=)/g;
  const writesA = new Set([...a.matchAll(GLOBAL_WRITE)].map((m) => m[1]));
  const gained = [...new Set([...b.matchAll(GLOBAL_WRITE)].map((m) => m[1]))].filter((n) => !writesA.has(n));
  if (gained.length) out.push({ id: "global-write-added", severity: "artificial", confidence: "medium",
    message: `the candidate WRITES global(s) the baseline never wrote: ${gained.slice(0, 6).join(", ")}. A store to a global to influence register allocation changes what other functions read, even when the bytes match`,
    evidence: gained.slice(0, 6).join(", ") });

  return out;
}

/**
 * Gate a candidate.
 *
 * @param {{candidateText:string, baselineText?:string|null, exactFunctionMatch?:boolean, functionLocal?:string|null}} a
 */
export function semanticGate({ candidateText, baselineText = null, exactFunctionMatch = false, functionLocal = null }) {
  const findings = [
    ...artificialConstructs(candidateText ?? ""),
    ...behaviouralDeltas(baselineText, candidateText ?? ""),
  ];
  const artificial = findings.filter((f) => f.severity === "artificial");
  const review = findings.filter((f) => f.severity === "review");

  const isExact = !!exactFunctionMatch && functionLocal === "exact";
  const classification = !isExact ? "not-exact"
    : artificial.length ? "byte-exact/artificial"
    : review.length ? "byte-exact/review-needed"
    : "byte-exact/plausible";

  return {
    classification,
    // The exactness result is REPORTED, never overwritten. These are separate
    // dimensions: a candidate can be exact AND artificial, and collapsing them
    // is how an unmaintainable source tree gets integrated.
    exactFunctionMatch: !!exactFunctionMatch,
    functionLocal,
    integrationEligible: classification === "byte-exact/plausible",
    findings,
    counts: { artificial: artificial.length, review: review.length, total: findings.length },
    ...(baselineText ? {} : { baselineNote: "no baseline supplied: only the artificial-construct checks ran; behaviour-delta checks need the source the candidate was derived from" }),
    policy: "exactness and source quality are SEPARATE dimensions and this gate never erases the exactness result. "
      + "'byte-exact/artificial' means the bytes match and the source contains constructs whose only purpose is the match. "
      + "Behavioural findings are advisory: a lexical pass cannot prove pointer provenance or aliasing, and claiming otherwise "
      + "would be worse than not checking — each finding carries its own confidence.",
  };
}
