import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { pathToFileURL } from 'node:url';
import { inspect, summary, applyPatch, restorePatch, digest } from '../lib/patcher.js';
const defs=JSON.parse(fs.readFileSync(new URL('../lib/patches.json',import.meta.url),'utf8'));
const helpers=`
function flattenText(c) { return typeof c==='string'?c:(c||[]).filter(b=>b&&(b.type==='text'||b.type==='reasoning')).map(b=>b.text||'').join(''); }
function toolCalls(c) {return Array.isArray(c)?c.filter(b=>b&&['tool-call','tool_use','function_call'].includes(b.type)):[];}
function toolResults(c) {return Array.isArray(c)?c.filter(b=>b&&['tool-result','tool_result','function_call_output'].includes(b.type)):[];}
const callIdOf = c=>c.id||c.tool_call_id;
const extractImages=()=>[];
const toOpenAiImage=x=>x;
`;
function fixture(t,mask=0) {
 const base=fs.mkdtempSync(path.join(os.tmpdir(),'kimi-guard-test-')), root=path.join(base,'subscriptions');
 fs.mkdirSync(path.join(root,'lib/vendors'),{recursive:true});
 fs.writeFileSync(path.join(root,'package.json'),JSON.stringify({name:'@goodandready/dsh-subscriptions',version:'0.7.55',type:'module'}));
 fs.copyFileSync(new URL('./fixtures/sse.mjs',import.meta.url),path.join(root,'lib/sse.mjs'));
 for(let i=0;i<defs.length;i++) {
  const code=(mask&(1<<i))?defs[i].after:defs[i].before;
  const prefix=i===0?`import {iterateSse,jsonSse} from './sse.mjs';\nfunction openBlock(kind,index){return {kind,index,text:'',id:'',name:''};}\n`:i===1?helpers:`import {openaiMessages} from '../messages.js';\nexport const makeBody = options => ({\n`;
  fs.writeFileSync(path.join(root,defs[i].file),prefix+code+(i===2?'\n});\n':''));
 }
 t.after(()=>fs.rmSync(base,{recursive:true,force:true}));
 return {root,base,options:{target:root,backupDir:path.join(base,'backups')}};
}
function body(deltas,terminal=true,step=7) {
 let text=deltas.map(delta=>'data: '+JSON.stringify({choices:[{delta}]})+'\n\n').join('');
 if(terminal) text+='data: '+JSON.stringify({choices:[{delta:{},finish_reason:'stop'}]})+'\n\ndata: [DONE]\n\n';
 const bytes=new TextEncoder().encode(text);
 return new ReadableStream({start(c){for(let i=0;i<bytes.length;i+=step)c.enqueue(bytes.slice(i,i+step));c.close();}});
}
async function chunks(root,deltas,terminal=true,step=7) {
 const {openaiChatStream}=await import(pathToFileURL(path.join(root,'lib/wire.js')));
 const events=[]; for await(const e of openaiChatStream(body(deltas,terminal,step)))events.push(e); return events;
}
function assemble(events) {
 const blocks=new Map();
 for(const e of events) {
  if(e.type==='block-start') { assert.ok(!blocks.has(e.index),'block indices must never be reused'); blocks.set(e.index,{type:e.blockType,text:''}); }
  else if(e.type.endsWith('-delta')) {
   const block=blocks.get(e.index); assert.ok(block,'delta requires block-start');
   if(e.type==='reasoning-delta'||e.type==='text-delta') {assert.equal(block.type,e.type.replace('-delta',''));block.text+=e.text;}
   else {assert.equal(block.type,'tool-call');block.id=e.id;block.name=e.name||block.name;block.text+=e.argumentsDelta;}
  }
 }
 return [...blocks.values()];
}

for(let mask=0;mask<8;mask++) test(`all partial-fix states: mask ${mask}`,t=>{
 const f=fixture(t,mask), before=defs.map(d=>fs.readFileSync(path.join(f.root,d.file),'utf8'));
 const result=applyPatch(f.options); assert.equal(result.changed,mask!==7);
 assert.ok(inspect(f.options).files.every(f=>f.state==='already-fixed'));
 assert.equal(applyPatch(f.options).changed,false,'idempotent');
 if(result.receipt) {
  restorePatch(result.receipt,f.options);
  defs.forEach((d,i)=>assert.equal(fs.readFileSync(path.join(f.root,d.file),'utf8'),before[i]));
 }
});

test('unknown source shape leaves all three files untouched',t=>{
 const f=fixture(t);fs.appendFileSync(path.join(f.root,'lib/wire.js'),'\n'+defs[0].before);
 const before=defs.map(d=>digest(fs.readFileSync(path.join(f.root,d.file))));
 assert.equal(inspect(f.options).compatible,false);assert.throws(()=>applyPatch(f.options),/Unsupported/);
 assert.deepEqual(defs.map(d=>digest(fs.readFileSync(path.join(f.root,d.file)))),before);
});
test('rollback refuses later updates before touching any file',t=>{
 const f=fixture(t),result=applyPatch(f.options);fs.appendFileSync(path.join(f.root,'lib/messages.js'),'\n// later update');
 const before=defs.map(d=>digest(fs.readFileSync(path.join(f.root,d.file))));
 assert.throws(()=>restorePatch(result.receipt,f.options),/edited or updated/);
 assert.deepEqual(defs.map(d=>digest(fs.readFileSync(path.join(f.root,d.file)))),before);
});
test('backup tampering is detected',t=>{
 const f=fixture(t),result=applyPatch(f.options);fs.appendFileSync(path.join(path.dirname(result.receipt),'0.original'),'tampered');
 assert.throws(()=>restorePatch(result.receipt,f.options),/digest mismatch/);
});
test('explicit profile resolves installed dependency',t=>{
 const f=fixture(t),profile=path.join(f.base,'profile');
 fs.mkdirSync(path.join(profile,'node_modules/@goodandready'),{recursive:true});
 fs.symlinkSync(f.root,path.join(profile,'node_modules/@goodandready/dsh-subscriptions'),'dir');
 assert.equal(inspect({profileDir:profile}).root,fs.realpathSync(f.root));
});
test('unrelated package is rejected',t=>{
 const f=fixture(t);fs.writeFileSync(path.join(f.root,'package.json'),'{"name":"other"}');
 assert.throws(()=>inspect(f.options),/Unexpected target/);
});
test('patch receipt exposes hashes, not source or credentials',t=>{
 const f=fixture(t);const s=summary(inspect(f.options));assert.equal(s.files[0].original,undefined);assert.equal(s.files[0].beforeHash.length,64);
});

test('failed second write restores the first changed file',t=>{
 const f=fixture(t), before=defs.map(d=>digest(fs.readFileSync(path.join(f.root,d.file))));
 const rename=fs.renameSync; let failed=false;
 const patched=mock.method(fs,'renameSync',(from,to)=>{
  if(!failed && to===fs.realpathSync(path.join(f.root,'lib/messages.js'))) {failed=true;throw new Error('injected write failure');}
  return rename(from,to);
 });
 try {assert.throws(()=>applyPatch(f.options),/injected write failure/);} finally {patched.mock.restore();}
 assert.deepEqual(defs.map(d=>digest(fs.readFileSync(path.join(f.root,d.file)))),before);
});
test('symlink outside package root is rejected',t=>{
 const f=fixture(t),file=path.join(f.root,'lib/wire.js'),outside=path.join(f.base,'outside.js');
 fs.renameSync(file,outside);fs.symlinkSync(outside,file);
 assert.throws(()=>inspect(f.options),/escaped/);
});

const cases=[
 ['reasoning then answer',[{reasoning_content:'思考甲'},{content:'正文乙'}],[{type:'reasoning',text:'思考甲'},{type:'text',text:'正文乙'}]],
 ['same packet',[{reasoning_content:'思考甲',content:'正文乙'}],[{type:'reasoning',text:'思考甲'},{type:'text',text:'正文乙'}]],
 ['late reasoning',[{reasoning_content:'思考甲'},{content:'正文乙'},{reasoning_content:'思考丙'},{content:'正文丁'}],[{type:'reasoning',text:'思考甲思考丙'},{type:'text',text:'正文乙正文丁'}]],
 ['answer first',[{content:'正文甲'},{reasoning_content:'思考乙'},{content:'正文丙'}],[{type:'text',text:'正文甲正文丙'},{type:'reasoning',text:'思考乙'}]],
 ['plain text',[{content:'正文'}],[{type:'text',text:'正文'}]],
 ['reasoning only',[{reasoning_content:'思考'}],[{type:'reasoning',text:'思考'}]],
 ['empty',[{}],[]],
];
for(const [name,deltas,expected] of cases) for(const size of [1,7,65536]) test(`channels / ${name} / ${size}-byte SSE chunks`,async t=>{
 const f=fixture(t);applyPatch(f.options);assert.deepEqual(assemble(await chunks(f.root,deltas,true,size)),expected);
});
test('tool arguments, late reasoning, and answer retain distinct blocks',async t=>{
 const f=fixture(t);applyPatch(f.options);
 const rows=assemble(await chunks(f.root,[{reasoning_content:'思考甲'},{tool_calls:[{index:0,id:'a',function:{name:'test',arguments:'{"x":'}}]},{reasoning_content:'思考乙'},{tool_calls:[{index:0,function:{arguments:'1}'}}]},{content:'正文'}]));
 assert.deepEqual(rows,[{type:'reasoning',text:'思考甲思考乙'},{type:'tool-call',text:'{"x":1}',id:'a',name:'test'},{type:'text',text:'正文'}]);
});
test('reasoning-only truncated stream reports INCOMPLETE',async t=>{
 const f=fixture(t);applyPatch(f.options);const events=await chunks(f.root,[{reasoning_content:'未完成'}],false);assert.equal(events.at(-1).reason.failure.code,'INCOMPLETE');
});
test('history isolates reasoning; Kimi explicitly replays separate field',async t=>{
 const f=fixture(t);applyPatch(f.options);
 const {openaiMessages}=await import(pathToFileURL(path.join(f.root,'lib/messages.js')));
 const options={messages:[{role:'assistant',content:[{type:'reasoning',text:'私有思考'},{type:'text',text:'最终正文'},{type:'tool-call',id:'t',name:'test',arguments:'{}'}]}]};
 const regular=openaiMessages(options)[0];assert.equal(regular.content,'最终正文');assert.equal(regular.reasoning_content,undefined);assert.equal(regular.tool_calls[0].id,'t');
 const {makeBody}=await import(pathToFileURL(path.join(f.root,'lib/vendors/kimi.js')));
 const kimi=makeBody(options).messages[0];assert.equal(kimi.content,'最终正文');assert.equal(kimi.reasoning_content,'私有思考');
 assert.equal(openaiMessages({messages:[{role:'assistant',content:'字符串正文'}]})[0].content,'字符串正文');
 const toolOnly=openaiMessages({messages:[{role:'assistant',content:[{type:'reasoning',text:'思考'},{type:'tool-call',id:'t',name:'test',arguments:'{}'}]}]},{includeReasoning:true})[0];assert.equal(toolOnly.content,null);assert.equal(toolOnly.reasoning_content,'思考');
});
test('original adapter reproduces missing reasoning block-start',async t=>{
 const f=fixture(t);const events=await chunks(f.root,[{reasoning_content:'思考'},{content:'正文'}]);assert.throws(()=>assemble(events),/block-start/);
});
