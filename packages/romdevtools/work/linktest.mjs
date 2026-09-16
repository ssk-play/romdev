// Functional proof the scrubbed archives still link: this program calls sprintf
// with a %f, which pulls in dtoa.o / mprec.o -- the exact members whose .rodata
// strings were rewritten.
import { buildShC } from '../src/toolchains/sh-c/sh-c.js';
const source = `
#include "dc.h"
extern int sprintf(char*, const char*, ...);
char buf[64];
int main(void){ sprintf(buf, "%f", 1.5); return buf[0]; }
`;
const r = await buildShC({ source });
console.log('ok:', r.ok ?? !!r.binary);
console.log('binary bytes:', r.binary?.length ?? 0);
if (r.log && !(r.binary?.length)) console.log(String(r.log).slice(-1200));
