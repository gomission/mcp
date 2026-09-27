import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {fileURLToPath} from 'node:url';
const root=fileURLToPath(new URL('..',import.meta.url));
const manifest=JSON.parse(fs.readFileSync(new URL('./fixtures/stable-release-manifest.json',import.meta.url),'utf8'));
test('stable source exactly matches the published 13-file runtime without beta modules',()=>{
 for(const entry of manifest.files){
  const bytes=fs.readFileSync(path.join(root,entry.path));
  assert.equal(bytes.length,entry.bytes,entry.path);
  assert.equal(crypto.createHash('sha256').update(bytes).digest('hex'),entry.sha256,entry.path);
 }
 for(const dir of ['src','bin']){
  const actual=fs.readdirSync(path.join(root,dir)).map(file=>`${dir}/${file}`).sort();
  const expected=manifest.files.map(file=>file.path).filter(file=>file.startsWith(dir+'/')).sort();
  assert.deepEqual(actual,expected);
 }
 const server=JSON.parse(fs.readFileSync(path.join(root,'server.json'),'utf8'));
 assert.equal(server.version,'0.2.3');assert.equal(server.packages[0].version,'0.2.3');
 assert.deepEqual(server.packages[0].packageArguments,[{type:'positional',value:'serve'}]);
 assert.equal(server.remotes,undefined);
});
