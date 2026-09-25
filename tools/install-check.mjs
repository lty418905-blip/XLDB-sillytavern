import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {pathToFileURL} from 'node:url';

const args=process.argv.slice(2);
const rootIndex=args.indexOf('--root');
const root=path.resolve(rootIndex>=0&&args[rootIndex+1]?args[rootIndex+1]:path.resolve(import.meta.dirname,'..'));
const quiet=args.includes('--quiet');
const diagnosticBase=path.resolve(root,'.local','install-check');
const diagnostic=path.join(diagnosticBase,crypto.randomUUID());

function packageVersion(base,name){
  return JSON.parse(fs.readFileSync(path.join(base,'node_modules',...name.split('/'),'package.json'),'utf8')).version;
}

try {
  assert.equal(process.platform,'win32','Windows is required');
  assert.equal(process.arch,'x64','Windows x64 Node.js is required');
  const version=process.versions.node.split('.').map(Number);
  assert.equal(version[0],24,'Node.js 24.x is required');
  assert.ok(version[1]>18||(version[1]===18&&version[2]>=1),'Node.js 24.18.1 or newer is required');
  const runtime=path.join(root,'.local','runtime');
  const tooling=path.join(root,'.local','tooling');
  assert.equal(packageVersion(runtime,'@lancedb/lancedb'),'0.39.0');
  assert.equal(packageVersion(runtime,'@lancedb/lancedb-win32-x64-msvc'),'0.39.0');
  assert.equal(packageVersion(tooling,'typescript'),'5.9.3');
  assert.equal(packageVersion(tooling,'@types/node'),'24.13.6');

  const lance=await import(pathToFileURL(path.join(runtime,'node_modules','@lancedb','lancedb','dist','index.js')));
  assert.equal(typeof lance.connect,'function');
  fs.mkdirSync(diagnostic,{recursive:true});
  const connection=await lance.connect(path.join(diagnostic,'lance'));
  if(typeof connection.close==='function')connection.close();
  const server=await import(pathToFileURL(path.join(root,'src','server.ts')));
  assert.equal(typeof server.createServer,'function','Tavern core server entry is unavailable');
  const assets=JSON.parse(fs.readFileSync(path.join(root,'tools','agent-assets.json'),'utf8'));
  const model=path.join(root,'.local','agentjev','model','model.safetensors');
  assert.equal(fs.statSync(model).size,assets.model.bytes,'AgentJev model is incomplete');
  const runtimeReceipt=fs.readFileSync(path.join(root,'.local','agentjev','release-runtime.sha256'),'utf8').trim();
  assert.equal(runtimeReceipt,assets.runtime.sha256,'AgentJev runtime receipt does not match the release assets');
  assert.ok(fs.existsSync(path.join(root,'.local','agentjev','runtime','python.exe')),'AgentJev runtime is missing');

  if(!quiet)process.stdout.write(JSON.stringify({status:'ready',root,node:{version:process.versions.node,architecture:process.arch},
    checks:{typescript:'5.9.3',lancedb:'0.39.0',lancedbNative:'0.39.0',tavernCore:'imported',agentjev:'assets_present'}})+'\n');
} finally {
  const resolved=path.resolve(diagnostic);
  if(!resolved.startsWith(`${diagnosticBase}${path.sep}`))throw new Error('invalid install-check cleanup path');
  fs.rmSync(resolved,{recursive:true,force:true});
}
