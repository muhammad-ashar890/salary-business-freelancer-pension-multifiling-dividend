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
 const normDesc = value => String(value ?? "").replace(/\s+/g, " ").trim().toLowerCase();
 let gross=0,tax=0;const seenDirect=new Set(),seenDetailDescs=new Set(),documents=new Set();
 for(const row of plan.rows){
  const target=TARGETS[row?.subcategory];
  if(!target||row.irisCode!==target.code||row.label!==target.label||row.detailMode!==target.detailMode||typeof row.documentId!=="string"||!row.documentId||documents.has(row.documentId))return fail("bank_profit_target_invalid_or_duplicate");
  if(target.detailMode==="direct"&&seenDirect.has(row.irisCode))return fail("bank_profit_target_invalid_or_duplicate");
  if(target.detailMode==="direct")seenDirect.add(row.irisCode);
  documents.add(row.documentId);
  if(row.panelTitle!=="Final Tax"||row.headerRowId!=="999919"||JSON.stringify(row.headers)!==JSON.stringify(HEADERS)||!Array.isArray(row.values)||row.values.length!==2)return fail("bank_profit_grid_contract_invalid");
  for(let i=0;i<2;i++)if(row.values[i]?.columnIndex!==i||row.values[i]?.column!==HEADERS[i]||typeof row.values[i]?.value!=="string"||!/^\d+$/.test(row.values[i].value))return fail("bank_profit_cell_invalid");
  const g=Number(row.values[0].value),t=Number(row.values[1].value);
  if(!Number.isSafeInteger(g)||g<=0||!Number.isSafeInteger(t)||t<0||t>g||row.taxChargeable?.columnIndex!==2||row.taxChargeable.readOnly!==true||!Number.isSafeInteger(row.taxChargeable.expected)||row.taxChargeable.expected<0)return fail("bank_profit_amount_invalid");
  if(typeof row.investment!=="string"||!row.investment.trim()||row.investment.length>50||/[\r\n\x00-\x1f]/.test(row.investment)||typeof row.contents!=="string"||!row.contents.trim())return fail("bank_profit_investment_missing");
  if(target.detailMode==="investment"){
   const descKey=`${row.irisCode}::${normDesc(row.label)} - ${normDesc(row.investment)} - ${normDesc(row.contents)}`;
   if(seenDetailDescs.has(descKey))return fail("bank_profit_target_invalid_or_duplicate");
   seenDetailDescs.add(descKey);
  }
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
function bankProfitCellOp({row,op,columnIndex,expectedDescriptions,expectedFbrRows,allowIrisAutoReplace}) {
 const norm=value=>String(value??"").replace(/\s+/g," ").trim();
 const visible=el=>Boolean(el&&el.getClientRects().length&&getComputedStyle(el).visibility!=="hidden"&&getComputedStyle(el).display!=="none");
 const panels=Array.from(document.querySelectorAll("mat-expansion-panel")).filter(panel=>{
  if(!visible(panel))return false;
  const header=panel.querySelector(":scope > mat-expansion-panel-header");
  const title=header?.querySelector("mat-panel-title")||header;
  return Boolean(title&&norm(title.textContent)==="Final Tax");
 });
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
 const allowedSet=new Set((Array.isArray(expectedDescriptions)&&expectedDescriptions.length?expectedDescriptions:[expected]).map(norm));
 const digits=value=>String(value??"").trim().replace(/,/g,"");
 const isBlankOrZero=value=>!/[1-9]/.test(digits(value));
 let target;
 if(row.detailMode==="investment"){
  const parents=matches.filter(el=>!el.classList.contains("section-detail-child-row"));
  if(parents.length!==1||norm(parents[0].querySelector(".row-description-text")?.textContent)!==norm(row.label)||Array.from(parents[0].querySelectorAll("input")).some(el=>!el.disabled))return {ok:false,reason:"parent_contract_mismatch"};
  const allDetails=matches.filter(el=>el.classList.contains("section-detail-child-row"));
  const lblNorm=norm(row.label);
  const fbrCandidates=(Array.isArray(expectedFbrRows)&&expectedFbrRows.length?expectedFbrRows:[{values:row.values.map(v=>v.value),expectedChargeable:row.taxChargeable.expected}]).map(c=>({gross:String(c.values?.[0]??""),tax:String(c.values?.[1]??""),chargeable:Number(c.expectedChargeable??c.chargeableExpected)}));
  const matchUniqueFbrCandidateIndex=(el)=>{
   const d=norm(el.querySelector(".row-description-text")?.textContent);
   if(allowedSet.has(d))return -1;
   if(!(d===lblNorm||d.startsWith(`${lblNorm} -`)||d.startsWith(`${lblNorm}--`)||d.startsWith(`${lblNorm}-`)))return -1;
   const c=Array.from(el.querySelectorAll('.columns-parent .data-middle-child-wapper input:not([type="hidden"])'));
   if(c.length!==3||c.slice(0,2).some(inp=>inp.disabled||inp.readOnly))return -1;
   if(digits(c[2].value)==="")return -1;
   const matched=fbrCandidates.map((cand,idx)=>digits(c[0].value)===cand.gross&&digits(c[1].value)===cand.tax&&Number(digits(c[2].value))===cand.chargeable?idx:-1).filter(idx=>idx!==-1);
   return matched.length===1?matched[0]:-1;
  };
  const seenAllowed=new Set();
  const fbrByCandidate=new Map();
  for(const el of allDetails){
   const d=norm(el.querySelector(".row-description-text")?.textContent);
   if(allowedSet.has(d)){
    if(seenAllowed.has(d))return {ok:false,reason:"approved_detail_not_unique_or_mismatched"};
    seenAllowed.add(d);
   }else{
    const candIdx=matchUniqueFbrCandidateIndex(el);
    if(candIdx===-1||fbrByCandidate.has(candIdx))return {ok:false,reason:"approved_detail_not_unique_or_mismatched"};
    fbrByCandidate.set(candIdx,el);
   }
  }
  const exactDetails=allDetails.filter(el=>norm(el.querySelector(".row-description-text")?.textContent)===norm(expected));
  if(exactDetails.length>1)return {ok:false,reason:"approved_detail_not_unique_or_mismatched"};
  if(exactDetails.length===1){
   target=exactDetails[0];
  }else{
   const ownMatchingIndices=fbrCandidates.map((cand,idx)=>cand.gross===row.values[0].value&&cand.tax===row.values[1].value&&cand.chargeable===row.taxChargeable.expected?idx:-1).filter(idx=>idx!==-1);
   const fbrMatch=ownMatchingIndices.length===1?fbrByCandidate.get(ownMatchingIndices[0]):null;
   if(fbrMatch){
    target=fbrMatch;
   }else{
    if(op==="inspect")return {ok:true,present:false};
    return {ok:false,reason:"approved_detail_not_unique_or_mismatched"};
   }
  }
 }else{
  const details=matches.filter(el=>norm(el.querySelector(".row-description-text")?.textContent)===norm(expected)&&!el.classList.contains("section-detail-child-row"));
  if(details.length!==1||matches.length!==1)return {ok:false,reason:"approved_detail_not_unique_or_mismatched"};
  target=details[0];
 }
 if(norm(target.querySelector(".data-first-child")?.textContent)!==row.irisCode)return {ok:false,reason:"row_code_cell_mismatch"};
 const inputs=Array.from(target.querySelectorAll('.columns-parent .data-middle-child-wapper input:not([type="hidden"])'));
 if(inputs.length!==3||inputs.slice(0,2).some(el=>el.disabled||el.readOnly))return {ok:false,reason:"writable_cells_unverified"};
 for(let i=0;i<2;i++){
  if(op==="fill"&&i===columnIndex&&allowIrisAutoReplace)continue;
  const value=digits(inputs[i].value);
  if(!isBlankOrZero(value)&&value!==row.values[i].value)return {ok:false,present:true,reason:"existing_value_conflict",columnIndex:i,values:inputs.map(el=>String(el.value??""))};
 }
 if(op==="fill"){
  if(columnIndex!==0&&columnIndex!==1)return {ok:false,reason:"column_not_allowlisted"};
  const el=inputs[columnIndex],value=row.values[columnIndex].value;
  const curDigits=digits(el.value);
  if(curDigits===value||(value==="0"&&isBlankOrZero(curDigits)))return {ok:true,present:true,status:"already_correct",readback:el.value};
  const setter=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,"value")?.set;
  if(!setter)return {ok:false,reason:"native_setter_missing"};
  if(typeof el.focus==="function")el.focus();
  setter.call(el,value);
  el.dispatchEvent(new Event("input",{bubbles:true}));
  el.dispatchEvent(new Event("change",{bubbles:true}));
  if(typeof el.blur==="function")el.blur();
  el.dispatchEvent(new Event("blur",{bubbles:true}));
  return {ok:digits(el.value)===value,present:true,status:"filled",readback:el.value,reason:"immediate_readback"};
 }
 if(op!=="inspect")return {ok:false,reason:"operation_not_allowlisted"};
 const values=inputs.map(el=>String(el.value??""));
 return {ok:true,present:true,values,chargeableDisabled:Boolean(inputs[2].disabled||inputs[2].readOnly),chargeableValue:digits(values[2]),chargeableVerified:digits(values[2])!==""&&Number(digits(values[2]))===row.taxChargeable.expected};
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
  const expectedByCode=new Map();
  const fbrRowsByCode=new Map();
  for(const r of route.rows){
   const desc=r.detailMode==="investment"?`${r.label} - ${r.investment} - ${r.contents}`:r.label;
   const list=expectedByCode.get(r.irisCode)||[];list.push(desc);expectedByCode.set(r.irisCode,list);
   const fbrList=fbrRowsByCode.get(r.irisCode)||[];
   fbrList.push({values:r.values.map(v=>v.value),expectedChargeable:r.taxChargeable.expected});
   fbrRowsByCode.set(r.irisCode,fbrList);
  }
  const sleep=typeof options.sleep==="function"?options.sleep:(ms)=>new Promise(resolve=>setTimeout(resolve,ms));
  const run=async(row,op,columnIndex,extra={})=>{await guard();return surface.webContents.executeJavaScript(`(${bankProfitCellOp.toString()})(${JSON.stringify({row,op,columnIndex,expectedDescriptions:expectedByCode.get(row.irisCode),expectedFbrRows:fbrRowsByCode.get(row.irisCode),...extra})})`);};
  for(const row of route.rows){
   let state=await run(row,"inspect");if(!state.ok)return fail(state.reason);
   const established=await setup.ensureBankProfitFinalTaxRow(surface,{mode:"live",code:row.irisCode,investment:row.investment,contents:row.contents,allowedDetailDescriptions:expectedByCode.get(row.irisCode),allowedFbrPrepopulatedRows:fbrRowsByCode.get(row.irisCode),expectedValues:row.values.map(v=>v.value),expectedChargeable:row.taxChargeable.expected,beforeStep:guard,onStep:options.onStep,sleep:options.sleep,timeoutMs:options.timeoutMs});
   if(!established.ok)return fail(established.status);
   state=await run(row,"inspect");if(!state.ok||!state.present)return fail(state.reason||"bank_profit_row_missing_after_setup");
   const blankBefore=[0,1].map(i=>!/[1-9]/.test(String(state.values?.[i]??"").replace(/,/g,"").trim()));
   let typedEarlier=false;
   for(const cell of row.values){
    const filled=await run(row,"fill",cell.columnIndex,{allowIrisAutoReplace:Boolean(typedEarlier&&blankBefore[cell.columnIndex])});
    results.push({key:`bank_profit:${row.documentId}:${row.irisCode}:${cell.columnIndex}`,irisCode:row.irisCode,label:row.label,rowDescription:row.detailMode==="investment"?`${row.label} - ${row.investment} - ${row.contents}`:row.label,sourceGroup:"bankProfitFields",sectionId:"other_sources_tax_deductions",censusView:"Other Sources > Tax Deductions",columnIndex:cell.columnIndex,plannedValue:cell.value,readback:filled.readback,status:filled.ok?filled.status:"value_mismatch",bankProfitDocumentId:row.documentId});
    if(!filled.ok)return fail(filled.reason||"bank_profit_cell_readback_failed");
    if(filled.status==="filled")typedEarlier=true;
   }
   state=await run(row,"inspect");
   if(!state.ok)return fail(state.reason||"bank_profit_derived_chargeable_unverified");
   const isSukuk=setup.SUKUK_CODES.includes(row.irisCode);
   const maxPolls=isSukuk?4:12;
   const settleBudgetMs=Math.min(Number(options.timeoutMs)||8000,isSukuk?1000:3000);
   const settleDeadline=Date.now()+settleBudgetMs;
   let pollCount=0;
   while(state.ok&&!state.chargeableVerified&&pollCount<maxPolls&&Date.now()<settleDeadline){
    pollCount+=1;
    await sleep(250);
    state=await run(row,"inspect");
    if(!state.ok)return fail(state.reason||"bank_profit_derived_chargeable_unverified");
   }
   if(!state.chargeableVerified&&isSukuk&&state.chargeableDisabled&&state.chargeableValue===""){
    const calculated=await setup.calculateBankProfitFinalTax(surface,{mode:"live",code:row.irisCode,expectedChargeable:row.taxChargeable.expected,beforeStep:guard,onStep:options.onStep,sleep:options.sleep,timeoutMs:options.timeoutMs});
    if(!calculated.ok)return fail(calculated.status||"bank_profit_calculate_failed");
    state=await run(row,"inspect");
   }
   if(!state.ok||!state.chargeableVerified)return fail(state.reason||"bank_profit_derived_chargeable_unverified");
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
  const expectedByCode=new Map();
  const fbrRowsByCode=new Map();
  for(const r of route.rows){
   const desc=r.detailMode==="investment"?`${r.label} - ${r.investment} - ${r.contents}`:r.label;
   const list=expectedByCode.get(r.irisCode)||[];list.push(desc);expectedByCode.set(r.irisCode,list);
   const fbrList=fbrRowsByCode.get(r.irisCode)||[];
   fbrList.push({values:r.values.map(v=>v.value),expectedChargeable:r.taxChargeable.expected});
   fbrRowsByCode.set(r.irisCode,fbrList);
  }
  for(const row of route.rows){
   await options.beforeStep();if(!(await options.verifyDocument())?.ok)return {complete:false,reason:"bank_profit_readback_identity_unverified",checks};
   const state=await surface.webContents.executeJavaScript(`(${bankProfitCellOp.toString()})(${JSON.stringify({row,op:"inspect",expectedDescriptions:expectedByCode.get(row.irisCode),expectedFbrRows:fbrRowsByCode.get(row.irisCode)})})`);
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
 return {ok,finalTaxIncome,unreconciled,reason:ok?"bank_profit_wealth_verified":"Bank Profit Wealth readback requires certified gross on 7033 and zero 703000; missing or mismatched totals block completion. Nothing is plugged."};
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
