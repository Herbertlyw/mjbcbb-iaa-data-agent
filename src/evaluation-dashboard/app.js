import { displayStatus } from './status.js';
const $ = id => document.getElementById(id);
let entries = [], selected = null, lastDetail = '';
const statusNames = { correct: '已核对正确', incorrect: '结果错误', partial: '部分完成', failed: '执行失败', not_started: '未启动', clarification: '合理澄清', pending: '等待核对', running: '运行中', budget: '预算中断' };
const statusClass = { correct: 'ok', incorrect: 'bad', failed: 'bad', partial: 'partial', budget: 'partial' };
function el(tag, cls, text) { const n = document.createElement(tag); if (cls) n.className = cls; if (text !== undefined) n.textContent = String(text); return n; }
function show(value) { return value === null || value === undefined || value === '' ? '未知' : typeof value === 'string' ? value : JSON.stringify(value, null, 2); }
function expectedText(value) {
  if (!value || typeof value !== 'object') return show(value);
  if (value.kind === 'daily_sum') return `${value.value} ${value.unit}\n范围：${value.app_id}，${value.date}（UTC）\n独立来源：${value.source}，${value.rows} 行，${value.null_count} 个 NULL`;
  if (value.kind === 'daily_comparison') return `${value.first_date}：${value.first_value} ${value.unit}\n${value.second_date}：${value.second_value} ${value.unit}\n后者减前者：${value.difference_second_minus_first} ${value.unit}\n范围：${value.app_id}（UTC）`;
  if (value.kind === 'dimension_cost_group') return `${value.date}（UTC）· ${value.unit}\n${(value.groups || []).map(g=>`${g.game_name} / ${g.platform} / ${g.app_id}：${g.discounted_cost_usd}`).join('\n')}`;
  if (value.kind === 'channel_cpi') return `${value.app_id} · ${value.date}（UTC）\n${(value.groups || []).map(g=>`${g.ua_channel_id}：消耗 ${g.discounted_cost_usd} USD，注册 ${g.af_registers}，CPI ${g.cpi_usd_per_register ?? '未知（零分母）'}`).join('\n')}`;
  if (value.kind === 'cohort_retention') return `${value.app_id} · ${value.date} 安装队列（UTC）\n队列基数：${value.cohort_size} 设备\n次日留存：${value.retained_day1} / ${value.cohort_size} = ${value.rate_day1_percent}%\n第七日留存：${value.retained_day7} / ${value.cohort_size} = ${value.rate_day7_percent}%\n同一基数不跨观察日重复累加。`;
  if (value.kind === 'clarification') return value.expected;
  return show(value);
}
function badge(status) { return el('span', `badge ${statusClass[status] || ''}`, statusNames[status] || '等待核对'); }
function card(title, value) { const n=el('div','card'); n.append(el('h3','',title),el('p','',show(value))); return n; }
function section(title) { const n=el('section','section'); n.append(el('h3','',title)); return n; }
function renderList() {
  const query=$('search').value.trim().toLowerCase(); $('list').replaceChildren();
  const visible=entries.filter(x=>`${x.question || ''} ${x.model || ''} ${statusNames[x.verdict] || ''}`.toLowerCase().includes(query));
  if(!visible.length){$('list').append(el('div','empty-list',entries.length?'没有匹配的题目。':'还没有评测记录。运行评测后会自动出现在这里。'));return;}
  for(const item of visible){const button=el('button',`item ${selected===item.key?'selected':''}`);button.type='button';const meta=el('div','meta');meta.append(badge(item.verdict),el('span','minor',item.started_at || '时间未知'));button.append(meta,el('div','question',item.question || '未记录问题'),el('div','minor',`${item.model || '模型未知'} · ${item.steps?.length ?? 0} 条账本记录`));button.addEventListener('click',()=>{selected=item.key;lastDetail='';renderList();renderDetail();});$('list').append(button);}
}
function renderDetail(){
  const item=entries.find(x=>x.key===selected);if(!item)return;
  const signature=JSON.stringify(item);if(signature===lastDetail)return;lastDetail=signature;
  const root=$('detail');root.replaceChildren();const top=el('div','detail-top');top.append(badge(item.verdict),el('span','id',`${item.model || '模型未知'} · ${item.id || ''}`));root.append(top,el('h2','',item.question || '未记录问题'),el('p','id',`任务 ${item.job_id || '未知'}  /  会话 ${item.session_id || '未知'}`));
  const cards=el('div','grid');cards.append(card('独立预期 · 不发送给模型',expectedText(item.expected)),card('正式交付 · 服务端核验',item.formal_answer));root.append(cards);
  const judgement=section('核对结论');judgement.append(el('p','',show(item.judgement)));root.append(judgement);
  const note=el('div','section notice','任务完成不自动代表答案正确；部分结果、未核验的草稿与独立预期需要分别检查。实际费用请以供应商账单为准。');root.append(note);
  const usage=section('供应商调用记录');const steps=item.steps || [];
  if(!steps.length)usage.append(el('p','muted','没有供应商调用记录。'));
  else{const table=el('table','table');const head=el('tr');for(const t of ['序号','任务账本状态 / 结算','全局账本','输入 token','输出 token','缓存命中','耗时','错误'])head.append(el('th','',t));const thead=el('thead');thead.append(head);table.append(thead);const body=el('tbody');steps.forEach((s,i)=>{const row=el('tr');for(const v of [i+1,`${s.status || '未知'} / ${s.settlement || '未知'}`,s.global_state ?? '未记录',s.input_tokens,s.output_tokens,s.cache_hit_tokens,s.duration_ms==null?null:`${s.duration_ms} ms`,s.error_code || '—'])row.append(el('td','',v===null||v===undefined?'未知':v));body.append(row);});table.append(body);const wrapper=el('div','table-scroll');wrapper.append(table);usage.append(wrapper);}root.append(usage);
  const trace=section('工具与证据轨迹');const stack=el('div','trace');
  const calls=item.tools || []; if(!calls.length)stack.append(el('p','muted','此记录没有保存工具详情。'));
  for(const [i,call] of calls.entries()){const d=el('details');d.append(el('summary','',`${String(i+1).padStart(2,'0')}  ${call.name || call.type || '未知工具'}${call.error ? ' · '+call.error : ''}`));d.append(el('pre','',show(call)));stack.append(d);}trace.append(stack);root.append(trace);
  const reasons=section('限制与服务端原因');reasons.append(el('p','',show(item.reasons?.length?item.reasons:'未记录')));root.append(reasons);
  if(item.draft){const draft=section('模型草稿 · 未独立核验');draft.append(el('p','',item.draft));root.append(draft);}
}
async function load(){
  try{const response=await fetch('/api/runs',{cache:'no-store'});if(!response.ok)throw Error(`HTTP ${response.status}`);const data=await response.json();entries=data.runs.flatMap(run=>(run.records || []).map((r,i)=>({...r,verdict:displayStatus(r),model:r.model || run.model,started_at:r.started_at || run.started_at,key:`${run.id}:${r.id || i}`})));entries.sort((a,b)=>String(b.started_at||'').localeCompare(String(a.started_at||'')));$('total').textContent=entries.length;$('correct').textContent=entries.filter(x=>x.verdict==='correct').length;$('issues').textContent=entries.filter(x=>['incorrect','partial','failed','not_started','budget'].includes(x.verdict)).length;const counts=entries.map(x=>x.dispatched);$('calls').textContent=counts.some(v=>v===null||v===undefined)?'部分未知':counts.reduce((a,b)=>a+b,0);$('updated').textContent=`更新于 ${new Date().toLocaleTimeString('zh-CN')}`;if(!entries.some(x=>x.key===selected))selected=entries[0]?.key || null;renderList();renderDetail();}catch(error){$('updated').textContent='加载失败';$('list').replaceChildren(el('div','error',`读取失败：${error.message}。请重试。`));}
}
$('refresh').addEventListener('click',load);$('search').addEventListener('input',renderList);load();setInterval(load,10000);
