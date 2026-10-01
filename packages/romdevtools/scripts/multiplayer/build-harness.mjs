// Stage a separate, read-only core test program into romdev-browser's dist.
// chiptoy serves this program as an asset; it never imports its implementation.
import {cpSync, mkdirSync, readFileSync, writeFileSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import path from 'node:path';
import {fourScoreRom} from './tool.mjs';
import {gbFixture} from '../../test/fixtures/multiplayer/gb-fixture.mjs';
const repo=path.resolve(import.meta.dirname,'../../../..');
const dist=process.argv[2];
if(!dist)throw Error('Usage: node build-harness.mjs <romdev-browser/dist>');
const out=path.join(dist,'m1');mkdirSync(out,{recursive:true});
for(const name of ['index.html','main.js','worker.js'])cpSync(path.join(import.meta.dirname,'harness',name),path.join(out,name));
const hostDir=path.join(repo,'packages/romdev-core-host');mkdirSync(path.join(out,'host'),{recursive:true});
for(const name of (await import('node:fs')).readdirSync(hostDir).filter(n=>n.endsWith('.js')&&!n.endsWith('.test.js')))cpSync(path.join(hostDir,name),path.join(out,'host',name));
const roms={nes:(await fourScoreRom()).outputs['pads.nes'],gb:gbFixture(false),gbc:gbFixture(true),'gb-offlcd':gbFixture(false,false,true),'gbc-offlcd':gbFixture(true,false,true)};
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const artifacts={};for(const [name,bytes]of Object.entries(roms)){writeFileSync(path.join(out,name+'.rom'),bytes);artifacts[name+'.rom']=hash(bytes);}
for(const core of ['gambatte','fceumm'])for(const ext of ['js','wasm']){
 const name=core+'_libretro.'+ext,src=path.join(repo,'packages',`romdev-core-${core}`,'wasm',name);cpSync(src,path.join(out,name));artifacts[name]=hash(readFileSync(src));
}
const sourceCommit=execFileSync('git',['rev-parse','HEAD'],{cwd:repo,encoding:'utf8'}).trim();
writeFileSync(path.join(out,'manifest.json'),JSON.stringify({milestone:'M1',sourceCommit,artifacts},null,2)+'\n');
cpSync(path.join(dist,'LICENSE'),path.join(out,'LICENSE'));
cpSync(path.join(dist,'NOTICE.md'),path.join(out,'NOTICE.md'));
cpSync(path.join(repo,'packages/romdevtools/LICENSE'),path.join(out,'LICENSE-host'));
console.log('M1 harness staged:',out,sourceCommit);
