import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { EvaluationQuestionBudget, syntheticQuestionKey } from '../src/evaluation-question-budget.js';

test('同一题的跨进程持久 token 预留有上限，未知结果保守保留', () => {
  const dir=mkdtempSync(path.join(tmpdir(),'vv-question-budget-'));
  const file=path.join(dir,'budget.sqlite');const a=new EvaluationQuestionBudget(file);const b=new EvaluationQuestionBudget(file);
  try {
    const oracle={kind:'daily_sum',table:'fact_activity_daily',column:'active_devices',app_id:'fictional',date:'2026-11-01'};
    const key=syntheticQuestionKey(oracle,'第一种问法');assert.equal(key,syntheticQuestionKey(oracle,'换一种问法'));
    const comparison={kind:'daily_comparison',table:'t',column:'c',app_id:'a',first_date:'2026-11-01',second_date:'2026-11-02'};
    assert.equal(syntheticQuestionKey(comparison,'前后比较'),syntheticQuestionKey({...comparison,first_date:comparison.second_date,second_date:comparison.first_date},'倒序比较'));
    assert.equal(a.reserve(key,'attempt1',6_000_000).ok,true);
    assert.equal(b.reserve(key,'attempt2',5_000_000).ok,false);
    a.settle('attempt1',1_000_000);
    assert.equal(b.reserve(key,'attempt2',8_000_000).ok,true);
    b.settle('attempt2',null);
    assert.equal(a.reserve(key,'attempt3',1_000_001).ok,false);
    assert.deepEqual(a.reserve(key,'attempt3',1_000_000),{ok:false,remaining:1_000_000,reason:'unresolved_attempt'});
    const second=syntheticQuestionKey({...oracle,date:'2026-11-02'},'another');
    assert.equal(a.reserve(second,'attempt4',9_000_000).ok,true);a.settle('attempt4',9_000_000);
    assert.equal(b.reserve(second,'attempt5',1_000_001).reason,'limit');
    assert.equal(b.reserve(second,'attempt5',1_000_000).ok,true);
    assert.equal(a.reserve(second,'attempt6',1).reason,'unresolved_attempt');
    assert.equal(b.reserve(second,'attempt5',1).reason,'duplicate');
  } finally { a.close();b.close();rmSync(dir,{recursive:true,force:true}); }
});

test('历史导入不能因未知状态或超额而遗漏之前实际用量，且不能触发重试', () => {
  const dir=mkdtempSync(path.join(tmpdir(),'vv-question-import-'));const b=new EvaluationQuestionBudget(path.join(dir,'budget.sqlite'));
  try {
    const key=syntheticQuestionKey({kind:'cohort_retention',app_id:'a',date:'2026-10-01'},'q');
    assert.equal(b.importHistorical(key,'unknown',null,750_000),true);
    assert.equal(b.importHistorical(key,'known',9_500_000,9_500_000),true);
    assert.equal(b.importHistorical(key,'known',9_500_000,9_500_000),false);
    assert.deepEqual(b.reserve(key,'new',1),{ok:false,remaining:0,reason:'unresolved_attempt'});
  } finally { b.close();rmSync(dir,{recursive:true,force:true}); }
});

test('独立进程同时预留不会突破同一题的上限', async () => {
  const dir=mkdtempSync(path.join(tmpdir(),'vv-question-race-'));const file=path.join(dir,'budget.sqlite');
  const initialize=new EvaluationQuestionBudget(file);initialize.close();
  const key=syntheticQuestionKey({kind:'daily_sum',table:'t',column:'c',app_id:'a',date:'2026-11-01'},'q');
  const moduleUrl=new URL('../src/evaluation-question-budget.ts',import.meta.url).href;
  const code=`import {EvaluationQuestionBudget} from ${JSON.stringify(moduleUrl)};const b=new EvaluationQuestionBudget(process.argv[1]);try{console.log(JSON.stringify(b.reserve(process.argv[2],process.argv[3],2000000)))}finally{b.close()}`;
  const child=(id:string)=>new Promise<{ok:boolean}>((resolve,reject)=>{const p=spawn(process.execPath,['--import','tsx','--input-type=module','-e',code,file,key,id],{stdio:['ignore','pipe','pipe']});let out='',err='';p.stdout.on('data',x=>out+=String(x));p.stderr.on('data',x=>err+=String(x));p.on('error',reject);p.on('exit',code=>code===0?resolve(JSON.parse(out)):reject(new Error(err)));});
  try { const results=await Promise.all([child('race-a'),child('race-b')]);assert.equal(results.filter(item=>item.ok).length,1); }
  finally { rmSync(dir,{recursive:true,force:true}); }
});
