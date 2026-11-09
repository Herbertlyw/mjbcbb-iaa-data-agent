import assert from 'node:assert/strict';
import test from 'node:test';
import { verifyDecimalCell } from '../src/decimal-cell-evidence.js';
import { verifyCell } from '../src/evidence.js';
import { persistedCells } from '../src/result-adapters.js';
import { loadKnowledge } from '../src/knowledge.js';
import type { QueryResource } from '../src/types.js';

const contract = loadKnowledge('knowledge/starhaven').contract_by_table.get('fact_activity_daily')!.contract!;
const version = 'sv_55c525926d882d7044f9';
const operation = {op:'sum', column:'active_devices', as:'dau_devices'} as const;
// Captured SQL shape and synthetic values from the DeepSeek VV run. No model
// text or credentials are used to decide the expected value.
function source(): QueryResource {
 const values = [['DE','breeze','2'],['DE','moss','1'],['DE','organic','1'],['JP','breeze','1'],['JP','moss','2'],['JP','organic','0'],['US','breeze','0'],['US','moss','4'],['US','organic','0']];
 return {
  resource_id:'res_fixture',session_id:'ses_fixture',job_id:'job_fixture',kind:'query_result',engine:'clickhouse-local',
  sql:"SELECT dataset_version, activity_date, app_id, acquisition_country_code, ua_channel_id, active_devices, completeness_state FROM fact_activity_daily WHERE activity_date = toDate('2026-11-07') AND app_id = 'stackjoy_android'",
  tables:['fact_activity_daily'], columns:['dataset_version','activity_date','app_id','acquisition_country_code','ua_channel_id','active_devices','completeness_state'],
  column_types:{dataset_version:'String',activity_date:'Date',app_id:'String',acquisition_country_code:'String',ua_channel_id:'String',active_devices:'Nullable(UInt64)',completeness_state:'String'},
  rows:values.map(([country,channel,value])=>({dataset_version:version,activity_date:'2026-11-07',app_id:'stackjoy_android',acquisition_country_code:country,ua_channel_id:channel,active_devices:value,completeness_state:'complete'})),
  time_range:{start:'2026-11-07',end:'2026-11-07',timezone:'UTC'},truncated:false,sql_limited:false,complete_population:true,
  coverage:{status:'known',expected_days:1,absent_dates:[],null_dates:[],zero_dates:['2026-11-07'],predicted_dates:[],actual_dates:['2026-11-07'],unknown_prediction_dates:[],groups:[]},
 } as unknown as QueryResource;
}

test('真实查询形状：UInt64 字符串精确重算并绑定契约与范围',()=>{
 const result=verifyDecimalCell(source(),contract,operation,'11');
 assert.equal(result?.value,'11');assert.equal(result?.column,'active_devices');assert.equal(result?.unit,'设备×App');
 assert.equal(result?.filters.app_id,'stackjoy_android');assert.equal(result?.range.start,'2026-11-07');
});

test('精确整数证据拒绝篡改、空值、缺失、类型不符与越界',()=>{
 const bad=(change:(r:QueryResource)=>void, expected='11')=>{const r=source();change(r);assert.equal(verifyDecimalCell(r,contract,operation,expected),null)};
 bad(r=>{r.rows[0]!.active_devices='3'});bad(r=>{r.rows[0]!.active_devices=null});bad(r=>{delete r.rows[0]!.active_devices});
 bad(r=>{r.column_types!.active_devices='Nullable(Int64)'});bad(r=>{r.rows[0]!.active_devices='18446744073709551616'});
 bad(r=>{r.truncated=true});bad(r=>{r.coverage.status='unknown'});bad(r=>{r.coverage.absent_dates=['2026-11-07']});
 bad(r=>{r.rows[0]!.app_id='other'});bad(r=>{r.rows=[]});bad(()=>{},'12');
});

test('UInt64 大于安全浮点范围仍精确验证，错误预测请求拒绝',()=>{
 const r=source();r.rows[0]!.active_devices='9007199254740993';
 assert.equal(verifyDecimalCell(r,contract,operation,'9007199254741002')?.value,'9007199254741002');
 assert.equal(verifyDecimalCell(r,contract,{...operation,predicted:'predicted_only'},'9007199254741002'),null);
});

test('真实复验形状：UInt64 明细的 NULL 和真实零计数保持可验证的整数',()=>{
 const r=source();
 const missing={op:'count_null',column:'active_devices',as:'null_active_devices'} as const;
 const zero={op:'count_zero',column:'active_devices',as:'zero_active_devices'} as const;
 const table={columns:[{name:'null_active_devices',type:'decimal',unit:'行',label:'NULL',scale:0},{name:'zero_active_devices',type:'decimal',unit:'行',label:'零',scale:0}],rows:[{null_active_devices:'0',zero_active_devices:'3'}]} as const;
 assert.deepEqual(persistedCells(r,structuredClone(table) as any,[missing,zero]),{null_active_devices:0,zero_active_devices:3});
 assert.equal(verifyCell(r,contract,missing,0)?.value,0);
 assert.equal(verifyCell(r,contract,zero,3)?.value,3);
 r.rows[0]!.active_devices='18446744073709551616';
 assert.equal(verifyCell(r,contract,missing,0),null);
 assert.equal(verifyCell(r,contract,zero,3),null);
});

test('Decimal 字符串的 NULL 与零计数精确验证，拒绝伪造类型和越界',()=>{
 const revenueContract=loadKnowledge('knowledge/starhaven').contract_by_table.get('fact_cohort_revenue_daily')!.contract!;
 const r=source();r.tables=['fact_cohort_revenue_daily'];
 r.sql="SELECT revenue_source, revenue_usd FROM fact_cohort_revenue_daily WHERE revenue_date = toDate('2026-11-07') AND app_id = 'blockfall_ios' AND revenue_source = 'sdk'";
 r.columns=['revenue_source','revenue_usd'];r.column_types={revenue_source:'String',revenue_usd:'Nullable(Decimal(24, 6))'};
 r.decimal_types={'fact_cohort_revenue_daily.revenue_usd':'Nullable(Decimal(24, 6))'};
 r.rows=[{revenue_source:'sdk',revenue_usd:'1.5977'},{revenue_source:'sdk',revenue_usd:'0.000000'},{revenue_source:'sdk',revenue_usd:'-0'},{revenue_source:'sdk',revenue_usd:null}];
 const missing={op:'count_null',column:'revenue_usd',as:'missing'} as const;
 const zero={op:'count_zero',column:'revenue_usd',as:'zero'} as const;
 assert.equal(verifyCell(r,revenueContract,missing,1)?.value,1);
 assert.equal(verifyCell(r,revenueContract,zero,2)?.value,2);
 const invalid=(change:(x:QueryResource)=>void)=>{const x=structuredClone(r);change(x);assert.equal(verifyCell(x,revenueContract,missing,1),null);assert.equal(verifyCell(x,revenueContract,zero,2),null);};
 invalid(x=>{x.rows[0]!.revenue_usd='0.0000001'});
 invalid(x=>{x.rows[0]!.revenue_usd='1000000000000000000.000000'});
 invalid(x=>{x.rows[0]!.revenue_usd='NaN'});
 invalid(x=>{x.rows[0]!.revenue_usd=1.5977});
 invalid(x=>{x.column_types!.revenue_usd='Nullable(Decimal(20, 6))'});
 invalid(x=>{x.decimal_types!['fact_cohort_revenue_daily.revenue_usd']='Nullable(Decimal(20, 6))'});
});

test('来源不可相加：SDK 与 AF 同表明细不能认证为收入合计，单一来源仍可认证',()=>{
 const c=loadKnowledge('knowledge/starhaven').contract_by_table.get('fact_cohort_revenue_daily')!.contract!;
 const r=source();r.tables=[c.table];r.sql="SELECT revenue_source, revenue_usd FROM fact_cohort_revenue_daily WHERE revenue_date = toDate('2026-10-31') AND app_id = 'blockfall_ios'";
 r.columns=['revenue_source','revenue_usd'];r.column_types={revenue_source:'String',revenue_usd:'Nullable(Decimal(24, 6))'};
 r.decimal_types={'fact_cohort_revenue_daily.revenue_usd':'Nullable(Decimal(24, 6))'};
 r.time_range={start:'2026-10-31',end:'2026-10-31',timezone:'UTC'};
 r.coverage={status:'known',reason:'synthetic fixture',expected_days:1,absent_dates:[],null_dates:[],zero_dates:[],predicted_dates:[],actual_dates:['2026-10-31'],unknown_prediction_dates:[],groups:[]};
 r.rows=[{revenue_source:'sdk',revenue_usd:'1.266092'},{revenue_source:'af',revenue_usd:'1.139478'}];
 const sum={op:'sum',column:'revenue_usd',as:'total'} as const;
 assert.equal(verifyDecimalCell(r,c,sum,'2.405570'),null,'不同来源的值不能认证成业务收入总额');
 r.sql += " AND revenue_source = 'sdk'";r.rows=[r.rows[0]!];
 assert.equal(verifyDecimalCell(r,c,sum,'1.266092')?.value,'1.266092');
});
