// Same program, but linked twice: once against the ORIGINAL archive and once
// against the SCRUBBED one. The bytes must be identical except for the string
// text itself. That proves the rewrite changed nothing the linker depends on.
import { buildShC } from '../src/toolchains/sh-c/sh-c.js';
import fs from 'node:fs';
const AR = 'src/toolchains/sh-c/lib/libc.a';
const S = '/tmp/claude-1000/-home-monteslu-code-cliemu/b385558e-4962-4477-a8f0-b506cbbeacbf/scratchpad/';
const source = `
#include "dc.h"
extern double strtod(const char*, char**);
volatile double v;
int main(void){ v = strtod("3.14159", 0); return (int)v; }
`;
const run = async (which) => {
  fs.copyFileSync(S + which, AR);
  const r = await buildShC({ source });
  return r;
};
const a = await run('libc.a.orig');
const b = await run('libc.a.scrubbed');
console.log('original  -> bytes:', a.binary?.length ?? 0, a.binary ? '' : String(a.log).slice(-300));
console.log('scrubbed  -> bytes:', b.binary?.length ?? 0, b.binary ? '' : String(b.log).slice(-300));
if (a.binary && b.binary) {
  const A = Buffer.from(a.binary), B = Buffer.from(b.binary);
  let diffs = 0; for (let i=0;i<Math.max(A.length,B.length);i++) if (A[i]!==B[i]) diffs++;
  console.log('same length:', A.length===B.length, '| differing bytes:', diffs);
  console.log('orig has builder path:', A.includes('/home/monteslu'), '| scrubbed has it:', B.includes('/home/monteslu'));
}
