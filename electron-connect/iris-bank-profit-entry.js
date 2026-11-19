"use strict";
const {readWealthTotals,checkPreviousReturn}=require("./iris-other-sources-wealth");
const setup = require("./iris-bank-profit-row-driver");
const TARGETS = Object.freeze({
 "bank-or-financial-institution-deposit":{code:"64040052",label:"Profit on Debt u/s 151(1)(b) from Bank Accounts / Deposits",detailMode:"investment"},
 "other-profit-on-debt":{code:"64040054",label:"151(1) (d) - Profit on Debt u/s 151 from Others",detailMode:"investment"},
 "sukuk-individual-aop-above-1m":{code:"64330055",label:"Return on Investment in Sukuks u/s 151(1A) @ 12.5%",detailMode:"direct"},
 "sukuk-individual-aop-below-1m":{code:"64330054",label:"Return on Investment in Sukuks u/s 151(1A) @ 10%",detailMode:"direct"},
});
const HEADERS = ["Taxable Amount","Tax Deducted","Tax Chargeable"];
function getBankProfitPacketRoute(snapshot) {
 let sources=snapshot?.filing?.incomeSources;
 try {if(typeof sources==="string")sources=JSON.parse(sources);}catch{sources=[];}
 const plan=snapshot?.otherSources?.bankProfit;
 const selected=Boolean(plan)||(Array.isArray(sources)&&sources.includes("bank_profit"));
 const fail=reason=>({selected,active:false,reason,rows:[]});
 if(!selected)return fail("not_selected");
 if(!Array.isArray(sources)||sources.length!==1||sources[0]!=="bank_profit"||snapshot?.filing?.taxYear!==2026||snapshot?.filing?.filerType!=="myself")return fail("unsupported_bank_profit_source_set");
 if(plan?.version!=="bank-profit-final-tax-v1"||!plan.calculationRevision||plan.calculationRevision!==snapshot.filing.taxCalculationRevision||typeof plan.evidenceFingerprint!=="string"||!plan.evidenceFingerprint.trim()||!Array.isArray(plan.rows)||!plan.rows.length)return fail("bank_profit_payload_missing_or_stale");
 let gross=0,tax=0;const seen=new Set(),documents=new Set();
 for(const row of plan.rows){
  const target=TARGETS[row?.subcategory];
  if(!target||row.irisCode!==target.code||row.label!==target.label||row.detailMode!==target.detailMode||seen.has(row.irisCode)||typeof row.documentId!=="string"||!row.documentId||documents.has(row.documentId))return fail("bank_profit_target_invalid_or_duplicate");
  seen.add(row.irisCode);documents.add(row.documentId);
  if(row.panelTitle!=="Final Tax"||row.headerRowId!=="999919"||JSON.stringify(row.headers)!==JSON.stringify(HEADERS)||!Array.isArray(row.values)||row.values.length!==2)return fail("bank_profit_grid_contract_invalid");
  for(let i=0;i<2;i++)if(row.values[i]?.columnIndex!==i||row.values[i]?.column!==HEADERS[i]||typeof row.values[i]?.value!=="string"||!/^\d+$/.test(row.values[i].value))return fail("bank_profit_cell_invalid");
  const g=Number(row.values[0].value),t=Number(row.values[1].value);
  if(!Number.isSafeInteger(g)||g<=0||!Number.isSafeInteger(t)||t<0||t>g||row.taxChargeable?.columnIndex!==2||row.taxChargeable.readOnly!==true||!Number.isSafeInteger(row.taxChargeable.expected)||row.taxChargeable.expected<0)return fail("bank_profit_amount_invalid");
  if(typeof row.investment!=="string"||!row.investment.trim()||row.investment.length>50||/[\r\n\x00-\x1f]/.test(row.investment)||typeof row.contents!=="string"||!row.contents.trim())return fail("bank_profit_investment_missing");
  gross+=g;tax+=t;if(!Number.isSafeInteger(gross)||!Number.isSafeInteger(tax))return fail("bank_profit_amount_overflow");
 }
 const wealth=plan.wealth;
 if(wealth?.finalTaxIncome?.irisCode!=="7033"||wealth.finalTaxIncome.readOnly!==true||wealth.finalTaxIncome.expected!==gross||wealth?.taxOutflow?.irisCode!=="7098"||wealth.taxOutflow.section!=="151"||wealth.taxOutflow.amount!==tax||wealth.netBankCredits!==gross-tax)return fail("bank_profit_wealth_proof_invalid");
 const map=snapshot.portalFieldMapDetailed??snapshot.portalFieldMap;
 const outflows=(Array.isArray(map)?map.filter(row=>row.sourceGroup==="wealthFields"):map?.wealthFields??[]).filter(row=>String(row.irisCode)==="7098");
 if(tax>0?outflows.length!==1||outflows[0].rowDescriptionIncludes!=="Income tax deducted u/s 151"||Number(outflows[0].ourAmount??outflows[0].value)!==tax:outflows.length!==0)return fail("bank_profit_outflow_invalid");
 return {selected:true,active:true,reason:"verified_bank_profit_contract",rows:plan.rows,wealth};
}

/** Runs in IRIS. No selectors, values or actions except this row's fixed contract. */
function bankProfitCellOp({row,op,columnIndex}) {
 const norm=value=>String(value??"").replace(/\s+/g," ").trim();
 const visible=el=>Boolean(el&&el.getClientRects().length&&getComputedStyle(el).visibility!=="hidden"&&getComputedStyle(el).display!=="none");
 const panels=Array.from(document.querySelectorAll("mat-expansion-panel")).filter(panel=>visible(panel)&&norm(panel.querySelector(":scope > mat-expansion-panel-header mat-panel-title")?.textContent)==="Final Tax");
 if(panels.length!==1)return {ok:false,reason:"final_tax_panel_not_unique"};
 const panel=panels[0];
 const headings=Array.from(panel.querySelectorAll(".heading-bar strong")).map(el=>norm(el.textContent)).filter(text=>text!=="Description"&&text!=="Code");
 if(JSON.stringify(headings)!==JSON.stringify(row.headers))return {ok:false,reason:"final_tax_headers_mismatch"};
 const all=Array.from(panel.querySelectorAll(".tableRows.dataRow[id]")).filter(visible);
 const header=Array.from(panel.querySelectorAll('[id="999919"]')).filter(visible);
 if(header.length!==1)return {ok:false,reason:"final_tax_999919_missing_or_duplicate"};
 if(op==="scope")return {ok:true,scope:true};
 const matches=all.filter(el=>el.id===row.irisCode);
 if(!matches.length)return {ok:true,present:false};
 const expected=row.detailMode==="investment"?`${row.label} - ${row.investment} - ${row.contents}`:row.label;
 if(op==="inspect"&&row.detailMode==="investment"&&matches.length===1&&!matches[0].classList.contains("section-detail-child-row")&&norm(matches[0].querySelector(".row-description-text")?.textContent)===row.label&&Array.from(matches[0].querySelectorAll("input")).every(el=>el.disabled))return {ok:true,present:false};
 const details=matches.filter(el=>norm(el.querySelector(".row-description-text")?.textContent)===norm(expected)&&el.classList.contains("section-detail-child-row")===(row.detailMode==="investment"));
 if(details.length!==1||matches.length!==(row.detailMode==="investment"?2:1))return {ok:false,reason:"approved_detail_not_unique_or_mismatched"};
 const target=details[0];
 if(norm(target.querySelector(".data-first-child")?.textContent)!==row.irisCode)return {ok:false,reason:"row_code_cell_mismatch"};
 if(row.detailMode==="investment"){
  const parents=matches.filter(el=>!el.classList.contains("section-detail-child-row"));
  if(parents.length!==1||norm(parents[0].querySelector(".row-description-text")?.textContent)!==row.label||Array.from(parents[0].querySelectorAll("input")).some(el=>!el.disabled))return {ok:false,reason:"parent_contract_mismatch"};
 }
 const inputs=Array.from(target.querySelectorAll('.columns-parent .data-middle-child-wapper input:not([type="hidden"])'));
 if(inputs.length!==3||inputs.slice(0,2).some(el=>el.disabled||el.readOnly))return {ok:false,reason:"writable_cells_unverified"};
 const digits=value=>String(value??"").trim().replace(/,/g,"");
 for(let i=0;i<2;i++){const value=digits(inputs[i].value);if(value!==""&&value!==row.values[i].value)return {ok:false,present:true,reason:"existing_value_conflict",columnIndex:i,values:inputs.map(el=>String(el.value??""))};}
 if(op==="fill"){
  if(columnIndex!==0&&columnIndex!==1)return {ok:false,reason:"column_not_allowlisted"};
  const el=inputs[columnIndex],value=row.values[columnIndex].value;
  if(digits(el.value)===value)return {ok:true,present:true,status:"already_correct",readback:el.value};
  const setter=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,"value")?.set;
  if(!setter)return {ok:false,reason:"native_setter_missing"};
  setter.call(el,value);el.dispatchEvent(new Event("input",{bubbles:true}));el.dispatchEvent(new Event("change",{bubbles:true}));el.blur();
  return {ok:digits(el.value)===value,present:true,status:"filled",readback:el.value,reason:"immediate_readback"};
 }
 if(op!=="inspect")return {ok:false,reason:"operation_not_allowlisted"};
 const values=inputs.map(el=>String(el.value??""));
 return {ok:true,present:true,values,chargeableVerified:digits(values[2])!==""&&Number(digits(values[2]))===row.taxChargeable.expected};
}

async function resolveBankProfitSurface(windowInstance,route) {
 const navigation=require("./iris-navigation");
 const wc=windowInstance.webContents;
 const frames=wc.mainFrame?Array.from(wc.mainFrame.framesInSubtree||[wc.mainFrame]):[wc];
 const found=[];
 for(const frame of frames){
  const url=frame.url||(wc.getURL&&wc.getURL());if(!navigation.isAllowedPortalUrl(url))continue;
  try{const state=await frame.executeJavaScript(`(${bankProfitCellOp.toString()})(${JSON.stringify({row:route.rows[0],op:"scope"})})`);if(state?.ok&&state.scope)found.push(frame);}catch{}
 }
 return found.length===1?{webContents:found[0]}:null;
}

async function fillBankProfitEntries(windowInstance,route,options={}) {
 const results=[];const fail=reason=>{
  if(route?.active&&Array.isArray(route.rows))for(const row of route.rows)for(const cell of row.values){
    const key=`bank_profit:${row.documentId}:${row.irisCode}:${cell.columnIndex}`;
    if(!results.some(result=>result.key===key))results.push({key,irisCode:row.irisCode,label:row.label,columnIndex:cell.columnIndex,plannedValue:cell.value,bankProfitDocumentId:row.documentId,sourceGroup:"bankProfitFields",sectionId:"other_sources_tax_deductions",status:"unverified_target",sectionStatus:reason});
  }
  return {ok:false,reason,results};
 };
 if(!route?.active)return fail("bank_profit_route_not_verified");
 if(typeof options.beforeStep!=="function"||typeof options.verifyDocument!=="function"||typeof options.ensureSection!=="function")return fail("bank_profit_required_guards_missing");
 if(options.mode!=="live")return fail("bank_profit_not_live");
 const guard=async()=>{await options.beforeStep();const identity=await options.verifyDocument();if(!identity?.ok)throw Error("bank_profit_identity_year_section_unverified");};
 try{
  await guard();const section=await options.ensureSection();if(!section?.ok)return fail("bank_profit_navigation_unverified");
  const surface=await resolveBankProfitSurface(windowInstance,route);if(!surface)return fail("bank_profit_frame_not_unique");
  const run=async(row,op,columnIndex)=>{await guard();return surface.webContents.executeJavaScript(`(${bankProfitCellOp.toString()})(${JSON.stringify({row,op,columnIndex})})`);};
  for(const row of route.rows){
   let state=await run(row,"inspect");if(!state.ok)return fail(state.reason);
   const established=await setup.ensureBankProfitFinalTaxRow(surface,{mode:"live",code:row.irisCode,investment:row.investment,contents:row.contents,beforeStep:guard,onStep:options.onStep,sleep:options.sleep,timeoutMs:options.timeoutMs});
   if(!established.ok)return fail(established.status);
   state=await run(row,"inspect");if(!state.ok||!state.present)return fail(state.reason||"bank_profit_row_missing_after_setup");
   for(const cell of row.values){
    const filled=await run(row,"fill",cell.columnIndex);
    results.push({key:`bank_profit:${row.documentId}:${row.irisCode}:${cell.columnIndex}`,irisCode:row.irisCode,label:row.label,rowDescription:row.detailMode==="investment"?`${row.label} - ${row.investment} - ${row.contents}`:row.label,sourceGroup:"bankProfitFields",sectionId:"other_sources_tax_deductions",censusView:"Other Sources > Tax Deductions",columnIndex:cell.columnIndex,plannedValue:cell.value,readback:filled.readback,status:filled.ok?filled.status:"value_mismatch",bankProfitDocumentId:row.documentId});
    if(!filled.ok)return fail(filled.reason||"bank_profit_cell_readback_failed");
   }
   state=await run(row,"inspect");if(!state.ok||!state.chargeableVerified)return fail(state.reason||"bank_profit_derived_chargeable_unverified");
  }
  return {ok:true,results};
 }catch(error){return fail(String(error?.message||error));}
}
/** Fresh exact-detail, read-only cell check for post-tab and post-Save use. */
async function readBankProfitEntries(windowInstance,route,options={}) {
 const checks=[];
 if(!route?.active||typeof options.beforeStep!=="function"||typeof options.verifyDocument!=="function")return {complete:false,reason:"bank_profit_readback_guards_missing",checks};
 try{
  await options.beforeStep();if(!(await options.verifyDocument())?.ok)return {complete:false,reason:"bank_profit_readback_identity_unverified",checks};
  const surface=await resolveBankProfitSurface(windowInstance,route);if(!surface)return {complete:false,reason:"bank_profit_frame_not_unique",checks};
  for(const row of route.rows){
   await options.beforeStep();if(!(await options.verifyDocument())?.ok)return {complete:false,reason:"bank_profit_readback_identity_unverified",checks};
   const state=await surface.webContents.executeJavaScript(`(${bankProfitCellOp.toString()})(${JSON.stringify({row,op:"inspect"})})`);
   for(const cell of row.values){const seen=state.values?.[cell.columnIndex];checks.push({key:`bank_profit:${row.documentId}:${row.irisCode}:${cell.columnIndex}`,irisCode:row.irisCode,columnIndex:cell.columnIndex,documentId:row.documentId,expected:cell.value,afterTabValue:seen,status:!state.present||seen===undefined?"not_seen":String(seen).replace(/,/g,"").trim()===cell.value?"match":"mismatch",detail:state.reason});}
   if(!state.ok||!state.present||!state.chargeableVerified)return {complete:false,reason:state.reason||"bank_profit_chargeable_readback_unverified",checks};
  }
  return {complete:checks.length===route.rows.length*2&&checks.every(check=>check.status==="match"),checks};
 }catch(error){return {complete:false,reason:String(error?.message||error),checks};}
}

function checkBankProfitWealth(route,totals,parseAmount) {
 if(!route?.active)return {ok:false,reason:"bank_profit_route_not_verified"};
 const read=code=>{const raw=totals?.[code];if(raw===null||raw===undefined||!String(raw).trim())return null;const value=typeof parseAmount==="function"?parseAmount(raw):Number(String(raw).replace(/,/g,""));return Number.isFinite(value)?value:null;};
 const finalTaxIncome=read("7033"),unreconciled=read("703000");
 const ok=finalTaxIncome===route.wealth.finalTaxIncome.expected&&unreconciled===0;
 return {ok,finalTaxIncome,unreconciled,reason:ok?"bank_profit_wealth_verified":"Bank Profit Wealth readback requires certified gross on7033 and zero703000; missing or mismatched totals block completion. Nothing is plugged."};
}
function checkBankProfitCompletion(route,{saveOutcome,bankReadback,wealthTotals,parseAmount,otherReadbacksComplete}) {
 if(!route?.active)return {ok:false,reason:"bank_profit_route_not_verified"};
 const fail=reason=>({ok:false,reason});
 if(!saveOutcome?.clicked||saveOutcome.dialog&&!saveOutcome.dialog.closed)return fail("Bank Profit requires one verified draft Save and closed dialogs before completion.");
 if(!otherReadbacksComplete||!bankReadback?.complete)return fail("Bank Profit needs complete post-Save exact-detail and Wealth readback.");
 const expected=new Set(route.rows.flatMap(row=>row.values.map(cell=>`${row.documentId}:${row.irisCode}:${cell.columnIndex}`)));
 const seen=new Set();
 for(const check of bankReadback.checks||[]){const key=`${check.documentId}:${check.irisCode}:${check.columnIndex}`;if(!expected.has(key)||seen.has(key)||check.status!=="match")return fail("Bank Profit post-Save cells are missing, duplicated or mismatched.");seen.add(key);}
 if(seen.size!==expected.size)return fail("Bank Profit post-Save cells are incomplete.");
 const wealth=checkBankProfitWealth(route,wealthTotals,parseAmount);
 return {ok:wealth.ok,reason:wealth.ok?"bank_profit_post_save_verified":wealth.reason,wealth};
}

module.exports={readWealthTotals,checkPreviousReturn,getBankProfitPacketRoute,fillBankProfitEntries,readBankProfitEntries,checkBankProfitWealth,checkBankProfitCompletion,bankProfitCellOp};
