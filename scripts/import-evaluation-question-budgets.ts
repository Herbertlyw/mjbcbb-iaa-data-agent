import { readdirSync, readFileSync, mkdirSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import { EvaluationQuestionBudget, EVALUATION_QUESTION_TOKEN_LIMIT, syntheticQuestionKey } from '../src/evaluation-question-budget.js';

// One-time/idempotent migration of completed synthetic evaluation records.
// Unknown usage conservatively retains a full normal task reservation.
const runName=basename(resolve(process.argv[2] ?? ''));
if(!/^vv-continuous-[a-zA-Z0-9_-]{1,80}$/u.test(runName))throw new Error('invalid_evaluation_run');
const dir=resolve('.local-runtime/evaluations/records');mkdirSync(dir,{recursive:true,mode:0o700});
const ledger=new EvaluationQuestionBudget(resolve('.local-runtime/evaluations/question-budget.sqlite'));
let imported=0,unknown=0,skipped=0;
try {
  for(const name of readdirSync(dir).filter(name=>name.startsWith(runName) && /^[a-zA-Z0-9_-]+\.json$/u.test(name))) {
    const run=JSON.parse(readFileSync(resolve(dir,name),'utf8'));
    if(run?.schema!=='synthetic-eval-run-v1' || run.synthetic!==true || !Array.isArray(run.records) || typeof run.scope!=='string') { skipped++;continue; }
    for(const record of run.records) {
      if(!record.expected || typeof record.expected!=='object' || !record.job_id || typeof record.question!=='string') { skipped++;continue; }
      const id=`${run.scope}-${record.id}`;if(ledger.hasAttempt(id)){skipped++;continue;}
      const key=syntheticQuestionKey(record.expected,record.question);
      const steps=Array.isArray(record.steps)?record.steps.filter((step:any)=>step.status!=='not_dispatched'):[];
      const known=Boolean(run.finished_at) && Number.isSafeInteger(record.dispatched) && steps.length===record.dispatched && steps.every((step:any)=>step.settlement==='settled' && step.usage_source==='reported' && Number.isSafeInteger(step.input_tokens) && Number.isSafeInteger(step.output_tokens));
      const actual=known?steps.reduce((total:number,step:any)=>total+step.input_tokens+step.output_tokens,0):null;
      const wanted=Math.min(EVALUATION_QUESTION_TOKEN_LIMIT,actual===null?750000:Math.max(1,actual));
      if(!ledger.importHistorical(key,id,actual,wanted)) { skipped++;continue; }
      imported++;if(actual===null)unknown++;
    }
  }
  console.log(JSON.stringify({imported,unknown,skipped}));
} finally { ledger.close(); }
