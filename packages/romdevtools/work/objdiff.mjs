// Object-level proof: for every member of every scrubbed archive, compare the
// ORIGINAL bytes to the SCRUBBED bytes and assert the ONLY differences fall
// inside the path strings we deliberately rewrote.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
const pairs = [
  ['/tmp/claude-1000/-home-monteslu-code-cliemu/b385558e-4962-4477-a8f0-b506cbbeacbf/scratchpad/libc.a.orig',
   'src/toolchains/sh-c/lib/libc.a'],
];
for (const [orig, now] of pairs) {
  const A = fs.readFileSync(orig), B = fs.readFileSync(now);
  console.log('size equal:', A.length === B.length);
  // Collect every differing byte index.
  const idx = [];
  for (let i = 0; i < A.length; i++) if (A[i] !== B[i]) idx.push(i);
  console.log('differing bytes:', idx.length);
  // Group into runs and show what each run was/is.
  const runs = [];
  for (const i of idx) {
    const last = runs[runs.length-1];
    if (last && i === last.end + 1) last.end = i; else runs.push({start:i, end:i});
  }
  console.log('differing runs:', runs.length);
  let allInsidePaths = true;
  for (const r of runs) {
    // Expand to the enclosing NUL-terminated string in the ORIGINAL.
    let s = r.start; while (s > 0 && A[s-1] !== 0) s--;
    let e = r.end;   while (e < A.length && A[e] !== 0) e++;
    const was = A.subarray(s,e).toString('latin1');
    const isNow = B.subarray(s,e).toString('latin1');
    if (!was.includes('/home/monteslu')) { allInsidePaths = false; console.log('  UNEXPECTED diff:', JSON.stringify(was.slice(0,80))); }
    else if (runs.indexOf(r) < 2) console.log('  ok:', JSON.stringify(was.slice(0,60)), '->', JSON.stringify(isNow.slice(0,60)));
  }
  console.log('every change was inside a builder-path string:', allInsidePaths);
}
