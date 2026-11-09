import {readFileSync,writeFileSync,renameSync,createWriteStream,readdirSync,realpathSync,existsSync,mkdirSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {spawn,execFile} from 'node:child_process';
import {createServer} from 'node:net';
import {setTimeout as delay} from 'node:timers/promises';
import {resolve,basename} from 'node:path';
import mysql from 'mysql2/promise';
import {assessSyntheticDaily,markInterruptedEvaluations,repeatedToolFailure,validateSyntheticEvaluationAttestation,waitForProviderSettlements} from '../src/synthetic-evaluation.js';
import {assessSyntheticGroupedRatio} from '../src/synthetic-grouped-evaluation.js';
import {loadKnowledge} from '../src/knowledge.js';
import {deepSeekKey} from '../src/deepseek-key.js';
import {GlobalBudget} from '../src/global-budget.js';
import {EvaluationQuestionBudget, syntheticQuestionKey} from '../src/evaluation-question-budget.js';
import assert from 'node:assert/strict';
import {promisify} from 'node:util';
const runtime=resolve('.local-runtime');
const out=resolve(process.argv[2] ?? '');
const batch=process.argv[3] ?? '';
const candidateName=process.argv[4] ?? '';
if (!out.startsWith(resolve(runtime,'acceptance')+'/') || realpathSync(out)!==out || !/^[a-z0-9_-]{1,40}$/.test(batch) || !/^candidate[0-9]{1,3}$/.test(candidateName)) throw Error('invalid_isolated_run_arguments');
const candidate=resolve(out,candidateName);
// New runs can bind the current generated synthetic contracts without
// rewriting a historical release. Do not accept an arbitrary external path.
const runKnowledge=resolve(out,'knowledge');
const knowledge=existsSync(runKnowledge)?runKnowledge:resolve('.local-runtime/acceptance/vv-deepseek-fix-20261109-154344/knowledge');
if(existsSync(runKnowledge) && realpathSync(runKnowledge)!==runKnowledge)throw Error('isolated_knowledge_required');
if (realpathSync(candidate)!==candidate) throw Error('isolated_candidate_required');
// The temporary candidate has exactly the local runtime sources, apart from
// its previously reviewed VV-only guard. Never send a credential to a stale
// or independently modified worker copy.
const hash=(file:string)=>createHash('sha256').update(readFileSync(file)).digest('hex');
function checkSources(dir:string):void { for(const entry of readdirSync(resolve('src',dir),{withFileTypes:true})) {
  const relative=dir ? `${dir}/${entry.name}` : entry.name;
  if(entry.isDirectory()) { if(relative!=='evaluation-dashboard')checkSources(relative); }
  else if(entry.isFile() && /\.(?:ts|mjs|js)$/u.test(relative) && !['config.ts','synthetic-evaluation.ts','evaluation-question-budget.ts'].includes(relative) && hash(resolve('src',relative))!==hash(resolve(candidate,'src',relative))) throw Error('candidate_source_mismatch');
}}
checkSources('');
const baselineGuard=readFileSync(resolve('.local-runtime/acceptance/vv-deepseek-fix-20261109-154344/candidate/src/config.ts'),'utf8');
const oldKnowledgeGuard='path.join(repoRoot(), ".local-runtime", "acceptance", "vv-deepseek-fix-20261109-154344", "knowledge")';
if(!/^[a-zA-Z0-9_-]{1,100}$/.test(basename(out)))throw Error('invalid_isolated_run_name');
const expectedGuard=existsSync(runKnowledge)
  ? baselineGuard.replace(oldKnowledgeGuard,`path.join(repoRoot(), ".local-runtime", "acceptance", ${JSON.stringify(basename(out))}, "knowledge")`)
  : baselineGuard;
if(!baselineGuard.includes(oldKnowledgeGuard) || readFileSync(resolve(candidate,'src/config.ts'),'utf8')!==expectedGuard)throw Error('candidate_guard_mismatch');
const read=(f:string)=>JSON.parse(readFileSync(f,'utf8'));
const c=read(readFileSync(out+'/connection-path.txt','utf8'));const reader=read(c.reader_file);
const fixture=validateSyntheticEvaluationAttestation(readFileSync(out+`/cases-${batch}.json`),read(out+`/oracle-db-check-${batch}.json`));
if(read(knowledge+'/release.json').dataset_version!==fixture.dataset_version)throw Error('synthetic_release_mismatch');
const evaluationKnowledge=loadKnowledge(knowledge);
const ch=new URL(reader.url);const dbname=String(reader.database ?? '');
if (ch.protocol!=='http:' || ch.hostname!=='127.0.0.1' || !ch.port || ch.port==='8123' || !['','/'].includes(ch.pathname) || ch.username || ch.password || ch.search || ch.hash || !/^starhaven_preflight_[a-f0-9]{10}$/.test(dbname) || reader.username!==dbname+'_reader' || c.mysql.host!=='127.0.0.1' || !Number.isInteger(Number(c.mysql.port)) || Number(c.mysql.port)<1 || Number(c.mysql.port)>65535 || Number(c.mysql.port)===3306 || !/^state_[a-f0-9]{10}$/.test(c.mysql.database) || !/^pf_[a-f0-9]{10}$/.test(c.mysql.user) || c.redis.host!=='127.0.0.1' || !Number.isInteger(Number(c.redis.port)) || Number(c.redis.port)<1 || Number(c.redis.port)>65535 || Number(c.redis.port)===6379) throw Error('isolated_synthetic_stack_required');
const taskTokens=Number(process.env.EVAL_TASK_MAX_TOKENS ?? '750000');
const batchTokens=Number(process.env.EVAL_BATCH_MAX_TOKENS ?? '3000000');
const requestLimit=Number(process.env.EVAL_BATCH_MAX_REQUESTS ?? '100');
const taskCalls=Number(process.env.EVAL_TASK_MAX_CALLS ?? '25');
if (!Number.isSafeInteger(taskTokens) || taskTokens<1 || taskTokens>10000000 || !Number.isSafeInteger(batchTokens) || batchTokens<1 || !Number.isSafeInteger(requestLimit) || requestLimit<1 || requestLimit>1000 || !Number.isSafeInteger(taskCalls) || taskCalls<1 || taskCalls>200) throw Error('invalid_evaluation_budget');
await promisify(execFile)(process.execPath,['--import','tsx',resolve('scripts/import-evaluation-question-budgets.ts'),out],{timeout:15000,maxBuffer:10000});
const file=resolve('.local-runtime/evaluations/records/'+basename(out)+'-'+batch+'.json');
mkdirSync(resolve('.local-runtime/evaluations/records'),{recursive:true,mode:0o700});
if(existsSync(file) || existsSync(file+'.tmp'))throw Error('evaluation_record_already_exists');
const scope={path:runtime+'/deepseek-budget.sqlite',budgetId:'vv-continuous-'+basename(out)+'-'+batch,maxRequests:requestLimit,maxTokens:batchTokens};
const s=createServer();await new Promise<void>((resolve,reject)=>{s.once('error',reject);s.listen(0,'127.0.0.1',resolve)});const port=(s.address() as any).port;await new Promise<void>(r=>s.close(()=>r()));const base=`http://127.0.0.1:${port}`;
const key=deepSeekKey({},runtime);if(!key)throw Error('deepseek_local_key_missing');
const questionBudget=new EvaluationQuestionBudget(resolve(runtime,'evaluations','question-budget.sqlite'));
let budget: GlobalBudget;
try { budget=await GlobalBudget.activate(scope); } catch(error) { questionBudget.close(); throw error; }
const env:any={PATH:process.env.PATH,HOME:process.env.HOME,HOST:'127.0.0.1',PORT:String(port),IDENTITY_MODE:'controlled_visitor',VISITOR_ALLOW_LOOPBACK_HTTP:'true',VISITOR_MAX_GLOBAL_ACTIVE:'1',MODEL_MODE:'pi',PI_PROVIDER:'deepseek',PI_MODEL:'deepseek-flash',PI_BASE_URL:'https://api.deepseek.com',PI_API_KEY:key,PI_ALLOW_REMOTE_HTTPS:'true',DEEPSEEK_SYNTHETIC_ONLY:'true',PI_CONTEXT_WINDOW:'128000',PI_MAX_OUTPUT_TOKENS:'2048',PI_REASONING:'off',PI_ENABLED_REASONING:'off',PI_PROTOCOL_SCRIPT:'',DEEPSEEK_BUDGET_ID:scope.budgetId,DEEPSEEK_BUDGET_MAX_REQUESTS:String(scope.maxRequests),DEEPSEEK_BUDGET_MAX_TOKENS:String(scope.maxTokens),DATAAGENT_TEST_GLOBAL_BUDGET_PATH:scope.path,STATE_MODE:'mysql',BUSINESS_ENGINE:'clickhouse',CLICKHOUSE_URL:reader.url,CLICKHOUSE_USER:reader.username,CLICKHOUSE_PASSWORD:reader.password,CLICKHOUSE_DATABASE:reader.database,CLICKHOUSE_LOCKED_READONLY:'true',KNOWLEDGE_DIR:knowledge,FRESHNESS_TARGETS_PATH:knowledge+'/freshness-targets.json',SIMULATED_TODAY:fixture.as_of,PUBLISH_FRESHNESS_ON_START:'false',RESEED_DATABASE:'false',MAX_KNOWN_TOKENS:String(taskTokens),MAX_MODEL_CALLS:String(taskCalls),MAX_TOOL_CALLS:'60',JOB_TIMEOUT_MS:'360000',LEASE_MS:'10000',HEARTBEAT_MS:'1000',RECOVERY_MS:'500'};
for(const [prefix,obj] of [['MYSQL',c.mysql],['REDIS',c.redis]] as any)for(const [k,v] of Object.entries(obj))env[prefix+'_'+k.toUpperCase()]=String(v);
env.VISITOR_ORIGIN=base;env.REDIS_QUEUE_KEY='vv:'+basename(out);const children:any[]=[];
function launch(file:string,name:string){const log=createWriteStream(out+'/'+name+'.log');const child=spawn(process.execPath,['--import','tsx',file],{cwd:candidate,env,stdio:['ignore','pipe','pipe']});child.stdout.pipe(log);child.stderr.pipe(log);children.push(child);return child;}
async function stop(p:any){if(p.exitCode!==null||p.signalCode!==null)return;p.kill('SIGTERM');await Promise.race([new Promise(r=>p.once('exit',r)),delay(5000)]);if(p.exitCode===null&&p.signalCode===null){p.kill('SIGKILL');await new Promise(r=>p.once('exit',r));}}
let cookie='',csrf='';async function request(p:string,body?:any){const headers:any={};if(cookie)headers.cookie=cookie;if(body!==undefined){headers.origin=base;headers['content-type']='application/json';if(csrf)headers['x-csrf-token']=csrf}const r=await fetch(base+p,body===undefined?{headers}:{method:'POST',headers,body:JSON.stringify(body)});const v=await r.json();if(!r.ok)throw Error(`api_${r.status}_${v?.error?.code??'unknown'}`);return v as any;}
const run:any={schema:'synthetic-eval-run-v1',synthetic:true,started_at:new Date().toISOString(),model:'deepseek-flash · 真实请求',dataset_version:fixture.dataset_version,scope:scope.budgetId,records:fixture.cases.map((q:any)=>({id:q.id,question:q.question,expected:q.oracle,verdict:'pending',judgement:'等待执行和独立核对。',steps:[],tools:[],dispatched:0}))};
function save(){const tmp=file+'.tmp';writeFileSync(tmp,JSON.stringify(run,null,2),{mode:0o600});renameSync(tmp,file);}
let db:any;let complete=false;
async function readSteps(jobId:string){
 const [steps]:any=await db.query('SELECT step_id,status,settlement,estimated_input,reserved_output,input_tokens,output_tokens,usage_source,error_code,duration_ms,created_at FROM provider_steps WHERE job_id=? ORDER BY created_at,step_id',[jobId]);
 return Promise.all(steps.map(async (step:any)=>{const global=await budget.step(step.step_id);return {...step,global_state:global?.state??null,cache_hit_tokens:global?.cache_hit_tokens??null,cache_miss_tokens:global?.cache_miss_tokens??null};}));
}
try{
 save();
 const probe=launch('src/freshness-probe.ts','freshness-'+batch);assert.equal(await new Promise(r=>probe.once('exit',r)),0,'freshness_probe_failed');
 db=await mysql.createConnection(c.mysql);launch('src/api.ts','api-'+batch);launch('src/dispatcher.ts','dispatcher-'+batch);launch('src/worker.ts','worker-'+batch);let ready=false;for(let i=0;i<200;i++){try{if((await request('/api/health')).ok){ready=true;break}}catch{}await delay(100)}assert.ok(ready,'api_not_ready');
 const vr=await fetch(base+'/api/visitor',{method:'POST',headers:{origin:base,'content-type':'application/json'},body:'{}'});assert.ok(vr.ok);cookie=vr.headers.get('set-cookie')!.split(';')[0]!;csrf=(await vr.json() as any).csrf_token;
 for(const [i,q] of fixture.cases.entries()){
  const before=await budget.stats();if(!before||before.requests_reserved>=scope.maxRequests||before.accounted_tokens>=scope.maxTokens){console.log('全局预算不足，停止');break}
  const rec=run.records[i];rec.verdict='running';rec.judgement='任务运行中；标准答案只保存在本地评测侧。';rec.started_at=new Date().toISOString();save();
  const attemptId=`${scope.budgetId}-${q.id}`;
  const reservation=questionBudget.reserve(syntheticQuestionKey(q.oracle,q.question),attemptId,taskTokens);
  if(!reservation.ok){rec.verdict='budget';rec.judgement=reservation.reason==='unresolved_attempt'?'此题有未结算或用量未知的历史请求；已停止，等待明确核对，不能自动重试。':`此题累计预留达到上限或本次额度超过剩余额度；剩余 ${reservation.remaining} token。`;save();continue;}
  const session=await request('/api/sessions',{creation_key:`create-${q.id}`});const sent=await request(`/api/sessions/${session.session_id}/messages`,{text:q.question,idempotency_key:`question-${q.id}`});rec.job_id=sent.job_id;rec.session_id=session.session_id;
  let job:any;let stoppedForRepeatedFailure:string|null=null;const end=Date.now()+390000;
  do{
   job=await request(`/api/jobs/${sent.job_id}`);
   rec.steps=await readSteps(sent.job_id);
   const after=await budget.stats();if(!after)throw Error('global_budget_stats_missing');rec.dispatched=after.dispatched_count-before.dispatched_count;rec.reasons=job.analysis?.server_reasons??[];rec.formal_answer=job.analysis?.answer??null;rec.draft=job.analysis?.model_draft??null;
   const [snap]:any=await db.query('SELECT body_json FROM agent_snapshots WHERE job_id=? ORDER BY snapshot_id DESC LIMIT 1',[sent.job_id]);
   if(snap[0]){const x=JSON.parse(snap[0].body_json);const seen=new Set<string>();const calls:any[]=[];const finished=new Map((job.events??[]).filter((event:any)=>event.type==='tool_finished').map((event:any)=>[event.payload.tool_call_id,event.payload]));for(const line of String(x.jsonl??'').split('\n')){if(!line.trim())continue;const m=JSON.parse(line).message;if(m?.role!=='assistant'||!Array.isArray(m.content))continue;for(const v of m.content){if(v.type!=='toolCall'||seen.has(v.id))continue;seen.add(v.id);const end=finished.get(v.id) as any;calls.push({name:v.name,arguments:v.arguments??{},status:end?.is_error?'failed':end?.is_error===false?'succeeded':'unknown',error:end?.is_error?(end.code??'错误代码未记录'):null,resource_id:end?.resource_id??null});}}rec.tools=calls;}
   save();if(!['queued','running'].includes(job.status))break;
   const repeated=repeatedToolFailure(job.events);
   if(repeated && !stoppedForRepeatedFailure){stoppedForRepeatedFailure=repeated;await request(`/api/jobs/${sent.job_id}/cancel`,{});}
   if(Date.now()>end)throw Error('job_observation_timeout');await delay(1500);
  }while(true);
  const settled=await waitForProviderSettlements(()=>readSteps(sent.job_id),15000);
  rec.steps=settled.steps;rec.settlement_wait_timed_out=settled.timedOut;
  const settledStats=await budget.stats();if(!settledStats)throw Error('global_budget_stats_missing');rec.dispatched=settledStats.dispatched_count-before.dispatched_count;save();
  const ids=[...new Set((job.events??[]).filter((x:any)=>x.type==='tool_finished'&&x.payload?.resource_id).map((x:any)=>x.payload.resource_id))];const resources=[];for(const id of ids){const [rows]:any=await db.query('SELECT body_json FROM resources WHERE resource_id=?',[id]);if(rows[0]){const resource=JSON.parse(rows[0].body_json);assert.equal(resource.job_id,job.job_id);assert.equal(resource.session_id,session.session_id);resources.push(resource)}}
  const raw={job,resources};writeFileSync(out+'/'+batch+'-'+q.id+'-result.json',JSON.stringify(raw,null,2),{mode:0o600});
  const assessed=q.oracle.kind==='channel_cpi'
    ? assessSyntheticGroupedRatio(q.oracle,job,resources,evaluationKnowledge,fixture.dataset_version)
    : assessSyntheticDaily(q.oracle,job,resources,fixture.dataset_version);
  rec.verdict=['failed','cancelled','timed_out'].includes(job.status)?'failed':assessed.verdict==='pending' && job.status==='partial'?'partial':assessed.verdict;
  rec.judgement=stoppedForRepeatedFailure?`连续出现相同工具错误 ${stoppedForRepeatedFailure}，已停止以便离线定位。`:job.error?.code?`任务错误：${job.error.code}`:assessed.reason;rec.job_status=job.status;save();
  const dispatched=rec.steps.filter((step:any)=>step.status!=='not_dispatched');
  const known=dispatched.length===rec.dispatched && dispatched.every((step:any)=>step.settlement==='settled' && step.global_state==='settled' && step.usage_source==='reported' && Number.isSafeInteger(step.input_tokens) && Number.isSafeInteger(step.output_tokens));
  questionBudget.settle(attemptId,known?dispatched.reduce((total:number,step:any)=>total+step.input_tokens+step.output_tokens,0):null);
  console.log(JSON.stringify({id:q.id,status:job.status,error:job.error?.code??null,dispatches:rec.dispatched,resources:resources.length,reasons:rec.reasons}));
  if(job.error?.code?.includes('global') || settled.timedOut || rec.steps.some((x:any)=>x.settlement==='held_unknown' || x.global_state==='held_unknown'))break;
 }
 complete=run.records.every((record:any)=>Boolean(record.job_status)||record.verdict==='budget');
}finally{
 if(!complete)markInterruptedEvaluations(run.records);
 let finalizationFailed=false;
 for(const p of children.reverse())try{await stop(p)}catch{finalizationFailed=true}
 if(db)try{await db.end()}catch{finalizationFailed=true}
 let closed: {ok:boolean;code:string}|undefined;
 try {
  const stats=await budget.stats();closed=await budget.closeScope();
  writeFileSync(out+'/budget-result-'+batch+'.json',JSON.stringify({stats,closed},null,2),{mode:0o600});
 } catch { finalizationFailed=true; }
 try{await budget.close()}catch{finalizationFailed=true}
 try{questionBudget.close()}catch{finalizationFailed=true}
 run.finished_at=new Date().toISOString();run.complete=complete;save();
 console.log('预算范围关闭',closed?.ok?'成功':'未关闭');
 // Unknown reservations remain held. A failed close requires an explicit
 // operator review; it must not look like a successful automated run.
 if(finalizationFailed || !closed?.ok)throw Error('evaluation_budget_finalization_failed');
}
