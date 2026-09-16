// The other scrubbed toolchains: m68k (Genesis), z80/sdcc, mips, sh.
const tries = [];
try {
  const { buildGenesisC } = await import('../../romdev-toolchain-m68k-gcc/build/genesis-c/genesis-c.js');
  const r = await buildGenesisC({ source: 'int main(void){ volatile int x=1; while(1) x++; return 0; }' });
  tries.push(['m68k/genesis-c', !!r.binary, r.binary?.length ?? 0, r.binary?null:String(r.log).slice(-200)]);
} catch(e){ tries.push(['m68k/genesis-c','ERR',0,e.message.slice(0,140)]); }
try {
  const { buildMipsC } = await import('../src/toolchains/mips-c/mips-c.js');
  const r = await buildMipsC({ source: 'int main(void){ volatile int x=0; for(int i=0;i<4;i++) x+=i; return x; }', platform:'n64' });
  tries.push(['mips-c', !!r.binary, r.binary?.length ?? 0, r.binary?null:String(r.log).slice(-200)]);
} catch(e){ tries.push(['mips-c','ERR',0,e.message.slice(0,140)]); }
for (const [n,ok,len,err] of tries) console.log(n.padEnd(18), 'ok:', ok, 'bytes:', len, err?('| '+err):'');
