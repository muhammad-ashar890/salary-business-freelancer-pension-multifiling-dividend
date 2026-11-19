"use strict";
const {test}=require("node:test");
const assert=require("node:assert/strict");
const {buildFbrHandoffRoute}=require("../electron-connect/fbr-handoff-route");
const {checkDividendCompletion}=require("../electron-connect/iris-dividend-entry");
const route={active:true,agentFields:[{values:[{},{}]}],wealth:{finalTaxIncome:{expected:100000}}};
function fixture(){return {saveOutcome:{clicked:true},censusAfterSave:{complete:true,views:[{key:"116 - Wealth Statement > Reconciliation of Net Assets",rows:[{code:"7033",cells:[{value:"100000"}]},{code:"703000",cells:[{value:"0"}]}]}]},results:[0,1].map(columnIndex=>({censusView:"Other Sources > Tax Deductions",columnIndex})),census:{compareTypedEntries:()=>[{status:"match"},{status:"match"}],collectTotals:()=>({7033:"100000",703000:"0"}),parseIrisAmount:Number}};}
test("Dividend handoff identity is additive and excludes Capital Gains",()=>{
 assert.deepEqual(buildFbrHandoffRoute(["dividend"]),{id:"dividend",label:"Dividend",incomeSources:["dividend"]});
 assert.equal(buildFbrHandoffRoute(["services","pension","business","salary"]).id,"salary_business_pension_services");
 assert.equal(buildFbrHandoffRoute(["capital_gains"]).id,"unscoped");
});
test("Dividend completion requires Save, every cell and fresh Wealth proof",()=>{
 assert.equal(checkDividendCompletion(route,fixture()).ok,true);
 for(const mutate of [f=>f.saveOutcome.clicked=false,f=>f.saveOutcome.dialog={closed:false},f=>f.censusAfterSave.complete=false,f=>f.results.pop(),f=>f.census.compareTypedEntries=()=>[{status:"match"},{status:"not_seen"}],f=>f.censusAfterSave.views[0].rows[0].cells[0].value="85000",f=>f.censusAfterSave.views[0].rows[1].cells[0].value="1"]){const f=fixture();mutate(f);assert.equal(checkDividendCompletion(route,f).ok,false);}
});
