"use strict";
const VIEW = "Other Sources > Tax Deductions";
function amount(value) {
  if (value === null || value === undefined || String(value).trim() === "") return 0;
  const text=String(value).trim().replace(/,/g, "");
  return /^-?\d+(\.\d+)?$/.test(text) && Number.isFinite(Number(text)) ? Number(text) : null;
}
/** Read-only comparison. Summary/detail repetitions are grouped, never added. */
function checkExistingDividendIncome(census, route) {
  const fail=reason=>({ok:false,reason,conflicts:[]});
  if(!route?.active)return fail("Dividend route is not verified.");
  const views=(census?.views||[]).filter(v=>v.key===VIEW);
  if(!census?.complete||views.length!==1||!views[0].ok||!Array.isArray(views[0].rows)||views[0].dialogsOpen)return fail("Existing IRIS income could not be checked completely. No values will be entered.");
  const planned=new Map(route.agentFields.map(f=>[String(f.irisCode), f.values]));
  const grouped=new Map();
  for(const row of views[0].rows){
    const code=String(row.code||"");
    if(!/^\d+$/.test(code))return fail("An IRIS tax row could not be identified.");
    if(code==='999918'||code==='999919')continue;
    const a=amount(row.cells?.[0]?.value), t=amount(row.cells?.[1]?.value);
    if(a===null||t===null)return fail("An existing IRIS amount could not be read safely.");
    if(!a&&!t)continue;
    const list=grouped.get(code)||[];list.push({code,description:row.description||code,gross:a,tax:t,detail:/--/.test(row.description||'')});grouped.set(code,list);
  }
  const conflicts=[];
  for(const [code,rows] of grouped){
    const summaries=rows.filter(r=>!r.detail);
    // Prefer one parent summary. Multiple detail-only rows need attribution.
    const row=summaries.length===1?summaries[0]:rows.length===1?rows[0]:null;
    if(!row){conflicts.push({...rows[0],reason:'multiple existing rows require review'});continue;}
    const values=planned.get(code);
    if(!values){conflicts.push({...row,reason:'not included in the approved Dividend-only packet'});continue;}
    const gross=Number(values.find(v=>v.columnIndex===0)?.value),tax=Number(values.find(v=>v.columnIndex===1)?.value);
    if(row.gross!==gross||row.tax!==tax)conflicts.push({...row,reason:'differs from the approved packet'});
  }
  return {ok:conflicts.length===0,reason:conflicts.length?'Existing IRIS income or withholding differs from this Dividend-only filing.':'Existing Other Sources tax rows match the packet or are empty.',conflicts};
}
module.exports={checkExistingDividendIncome,VIEW};
