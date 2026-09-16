// Functional proof the scrubbed toolchain WASM still compiles: drive the real
// GBA C build end to end (cc1-arm -> as -> ld -> objcopy), all scrubbed files.
import { buildGbaC } from '../../romdev-platform-gba/build/gba-c/gba-c.js';
const r = await buildGbaC({ source: `
int main(void){ volatile int x=0; for(int i=0;i<10;i++) x+=i; return x; }
` });
console.log('gba build ok:', !!r.binary, '| bytes:', r.binary?.length ?? 0);
if (!r.binary) console.log(String(r.log).slice(-800));
