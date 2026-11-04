import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { docker } from '../runner/dockerctl.mjs';
const base = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const root = join(base, 'results', 'parent-validation');
mkdirSync(root, { recursive: true });
const backend = `import http from 'node:http';
import fs from 'node:fs';
import {randomUUID} from 'node:crypto';
const file=process.env.DATA_DIR+'/jobs.json';fs.mkdirSync(process.env.DATA_DIR,{recursive:true});
let jobs=fs.existsSync(file)?JSON.parse(fs.readFileSync(file)):[];for(const j of jobs)if(j.state==='running')j.state='queued';
const save=()=>{fs.writeFileSync(file+'.tmp',JSON.stringify(jobs));fs.renameSync(file+'.tmp',file)};
let busy=false;
async function pump(){if(busy)return;busy=true;try{for(;;){const j=jobs.find(j=>j.state==='queued');if(!j)break;j.state='running';save();try{const r=await fetch(process.env.WORKER_URL,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({text:j.text})});j.result=(await r.json()).result;j.state='completed';}catch{j.state='queued';save();break;}save();}}finally{busy=false;}}
const server=http.createServer(async(req,res)=>{const send=(value,status=200)=>{res.writeHead(status,{'content-type':'application/json'});res.end(JSON.stringify(value));};try{
let body='';for await(const c of req)body+=c;const p=req.url.split('/').filter(Boolean);
if(req.method==='POST'&&req.url==='/jobs'){const b=JSON.parse(body);const old=jobs.find(j=>j.key===b.requestId);if(old)return send(old);const j={id:randomUUID(),key:b.requestId,text:b.text,state:'queued'};jobs.push(j);save();send(j);void pump();return;}
const j=jobs.find(j=>j.id===p[1]);if(!j)return send({error:'missing'},404);
if(p[2]==='cancel'){if(j.state==='queued')j.state='cancelled';save();}send(j);
}catch(e){send({error:String(e)},400);}});
server.listen(Number(process.env.PORT),'127.0.0.1',()=>void pump());process.on('SIGTERM',()=>process.exit(0));`;
const cli = `import {randomUUID} from 'node:crypto';
const [command,value,...flags]=process.argv.slice(2);const key=flags[0]==='--request-id'?flags[1]:randomUUID();
for(let attempt=0;attempt<3;attempt++){try{const submit=command==='submit';const url=process.env.JOB_URL+(submit?'/jobs':'/jobs/'+value+(command==='cancel'?'/cancel':''));
const response=await fetch(url,{method:submit||command==='cancel'?'POST':'GET',headers:{'content-type':'application/json'},...(submit?{body:JSON.stringify({text:value,requestId:key})}:{})});
if(!response.ok)throw Error('HTTP '+response.status);console.log(JSON.stringify(await response.json()));process.exit(0);
}catch(e){if(attempt===2){console.error(String(e));process.exit(1);}await new Promise(r=>setTimeout(r,50));}}`;
async function control(kind) {
  const project = mkdtempSync(join(root, `coding-${kind}-`));
  chmodSync(project, 0o755);
  for(const sub of ['backend','cli'])mkdirSync(join(project,sub));
  if(kind!=='empty') {
    const code=kind==='duplicate'?backend.replace('if(old)return send(old);',''):kind==='bad-cancel'?backend.replace("if(j.state==='queued')j.state='cancelled';",''):backend;
    writeFileSync(join(project,'backend/server.mjs'),code);writeFileSync(join(project,'cli/main.mjs'),cli);
  }
  const r=await docker(['run','--rm','--network','none','--read-only','--cap-drop','ALL','--security-opt','no-new-privileges:true','--memory','512m','--pids-limit','128','--tmpfs','/tmp:rw,size=64m,uid=10001','--mount',`type=bind,source=${project},target=/project,readonly`,'--mount',`type=bind,source=${join(base,'coding')},target=/tests,readonly`,'coord-eval-pi:pr2181-explicit-context','node','/tests/grade.mjs'],{timeoutMs:60000});
  const result=JSON.parse(r.stdout);writeFileSync(join(project,'grade.json'),JSON.stringify(result,null,2));return result;
}
test('coding grader: known-working control passes every outcome',async()=>{const r=await control('oracle');assert.equal(r.total,10);assert.equal(r.pass,true,JSON.stringify(r));});
test('coding grader: missing artifact fails with the same denominator',async()=>{const r=await control('empty');assert.equal(r.total,10);assert.equal(r.passed,0);assert.equal(r.pass,false);});
test('coding grader: duplicate execution is detected',async()=>{const r=await control('duplicate');assert.equal(r.checks.request_id_idempotent,false);assert.equal(r.checks.retry_after_lost_response_no_duplicate,false);});
test('coding grader: ineffective cancellation is detected',async()=>{const r=await control('bad-cancel');assert.equal(r.checks.queued_cancel_prevents_execution,false);});
