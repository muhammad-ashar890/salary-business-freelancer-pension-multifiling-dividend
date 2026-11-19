"use strict";
const {test}=require("node:test"),assert=require("node:assert/strict");
const {readWealthTotals}=require("../electron-connect/iris-other-sources-wealth");
const fixture=()=>({complete:true,views:[{key:"116 - Wealth Statement > Reconciliation of Net Assets",rows:[{code:"7033",cells:[{value:"100,000"}]},{code:"703000",cells:[{value:"0"}]}]}]});
test("Other Sources Wealth proof records exact view/row/cell and explicit zero",()=>{const result=readWealthTotals(fixture());assert.equal(result.ok,true);assert.equal(result.totals[7033],100000);assert.equal(result.totals[703000],0);assert.equal(result.evidence[7033].columnIndex,0);});
for(const [name,mutate]of[["wrong view",f=>f.views[0].key="Other Sources > Tax Deductions"],["duplicate view",f=>f.views.push(f.views[0])],["incomplete tour",f=>f.complete=false],["duplicate row",f=>f.views[0].rows.push(f.views[0].rows[0])],["ambiguous amount columns",f=>f.views[0].rows[0].cells.push({value:"85000"})],["blank zero",f=>f.views[0].rows[1].cells[0].value=""],["invalid amount",f=>f.views[0].rows[0].cells[0].value="not-money"]])test(`Other Sources Wealth proof refuses ${name} instead of first-filled guessing`,()=>{const f=fixture();mutate(f);const r=readWealthTotals(f);assert.equal(r.ok,false);assert.deepEqual(r.totals,{});});

for(const raw of ["PKR 100000","100000 pending","1e5","100,00","--0","0.000"])test(`strict Wealth lexical proof rejects ${raw} even with permissive portal parser`,()=>{const f=fixture();f.views[0].rows[0].cells[0].value=raw;assert.equal(readWealthTotals(f,require("../electron-connect/iris-tour-census").parseIrisAmount).ok,false);});

for(const name of ["dividend","bank-profit"]){
 const entry=require(`../electron-connect/iris-${name}-entry`);
 const snapshot=()=>({filing:{taxYear:2026},wealthExpectations:{previousYearNetAssets:{irisCode:"703002",expected:1500000,previousReturnTaxYear:2025,source:"approved_previous_return_703001"}}});
 const priorTour=()=>{const f=fixture();f.views[0].rows.push({code:"703002",cells:[{value:"1,500,000"}]});return f;};
 test(`${name} Previous Return exact opening wealth is independent of current income`,()=>{const proof=entry.checkPreviousReturn(snapshot(),priorTour());assert.equal(proof.ok,true);assert.equal(proof.actual,1500000);assert.equal(entry.checkPreviousReturn({filing:{taxYear:2026}},fixture()).required,false);});
 for(const [reason,edit]of [["missing row",f=>f.views[0].rows.pop()],["one rupee mismatch",f=>f.views[0].rows[2].cells[0].value="1499999"],["duplicate row",f=>f.views[0].rows.push(f.views[0].rows[2])],["ambiguous columns",f=>f.views[0].rows[2].cells.push({value:"0"})],["blank amount",f=>f.views[0].rows[2].cells[0].value=""]])test(`${name} refuses Previous Return ${reason}`,()=>{const f=priorTour();edit(f);assert.equal(entry.checkPreviousReturn(snapshot(),f).ok,false);});
 test(`${name} refuses conflicting carry-forward metadata without writing a plug`,()=>{const s=snapshot();s.wealthCarryForward={previousReturnTaxYear:2025,totalAssets:2000000,totalLiabilities:0,netAssets:1500000};assert.equal(entry.checkPreviousReturn(s,priorTour()).ok,false);});
}
