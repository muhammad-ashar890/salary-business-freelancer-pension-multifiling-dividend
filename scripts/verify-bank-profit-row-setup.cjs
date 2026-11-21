"use strict";
const {test}=require("node:test");
const assert=require("node:assert/strict");
const driver=require("../electron-connect/iris-bank-profit-row-driver");
const {FakeIrisBankProfit}=require("./lib/fake-iris-bank-profit.cjs");
const investment="Bank savings deposit";
const contents="1. 00123456789\n2. Bank savings deposit\n3. Example Bank Limited";
const run=(fake,extra={})=>driver.ensureBankProfitFinalTaxRow(fake,{mode:"live",code:fake.code,investment,contents,beforeStep:async()=>{},timeoutMs:20,sleep:async()=>{},...extra});
test("Bank Profit setup creates only approved Investment detail; never Save/Calculate/Submit",async()=>{
 const fake=new FakeIrisBankProfit();const r=await run(fake);assert.equal(r.ok,true,JSON.stringify(r));assert.equal(fake.rows().length,2);assert.ok(fake.rows()[1].textContent.includes("00123456789"));assert.equal(fake.clicks.some(click=>/save|calculate|submit|payment/i.test(click.text)),false);
});
test("Bank Profit setup refuses missing or failed identity guard before clicks",async()=>{
 for(const beforeStep of [undefined,async()=>{throw Error("wrong taxpayer");}]){const fake=new FakeIrisBankProfit();const r=await run(fake,{beforeStep});assert.equal(r.ok,false);assert.equal(fake.clicks.length,0);}
});
test("Bank Profit setup never reuses a different existing Investment detail",async()=>{
 const fake=new FakeIrisBankProfit({preexistingRow:true});const r=await run(fake);assert.equal(r.ok,false);assert.equal(fake.clicks.length,0);
});
test("Bank Profit setup reuses only the exact approved Investment/account/institution detail",async()=>{
 const fake=new FakeIrisBankProfit({preexistingRow:true});fake.rows()[1].querySelector(".row-description-text").textContent=`${fake.label} - ${investment} - ${contents}`;const r=await run(fake);assert.equal(r.ok,true,JSON.stringify(r));assert.equal(fake.clicks.length,0);
});
test("Bank Profit setup dry run and missing details never add a row",async()=>{
 for(const opts of [{mode:"dry"},{investment:""},{contents:""}]){const fake=new FakeIrisBankProfit();const r=await run(fake,opts);assert.equal(r.ok,false);assert.equal(fake.clicks.length,0);}
});
test("Bank Profit operation allowlist refuses non-Sukuk Calculate, Save, payment, CG and unsupported taxpayer categories",()=>{
 for(const op of ["calculate","save","submit","payment"])assert.throws(()=>driver.buildPageScript({op}),/unsupported operation/);
 assert.throws(()=>driver.buildPageScript({op:"calculate"},"64040054"),/unsupported operation/);
 for(const code of ["64040053","64330056","64151351","64220158"])assert.throws(()=>driver.buildPageScript({op:"inspect",code}),/unsupported profit category/);
 assert.equal(typeof driver.calculateBankProfitFinalTax,"function");
 assert.ok(driver.buildPageScript({op:"calculate"},"64330054"));
});
test("real IRIS capture fixture final-tax-row-after-add matches parent/detail contract",()=>{
 const fs=require("node:fs");
 const path=require("node:path");
 const {JSDOM}=require("jsdom");
 const afterAddHtml=fs.readFileSync(path.join(__dirname,"..","test-fixtures/iris/other-sources/final-tax-row-after-add.html"),"utf8");
 const dom=new JSDOM(afterAddHtml,{runScripts:"outside-only",pretendToBeVisual:true});
 const doc=dom.window.document;
 const panel=[...doc.querySelectorAll("mat-expansion-panel")].find(el=>el.querySelector("mat-panel-title")?.textContent.trim()==="Final Tax");
 assert.ok(panel);
 const rows=[...panel.querySelectorAll('.tableRows.dataRow[id="64040052"]')];
 assert.equal(rows.length,2);
 assert.equal(rows[0].classList.contains("section-detail-child-row"),false);
 assert.equal(rows[1].classList.contains("section-detail-child-row"),true);
 assert.equal(Boolean(rows[0].querySelector('#add-adjustable-tax-generic[title="Add"][fonticon="add"]')),true);
 const inspected=dom.window.eval(driver.buildPageScript({op:"inspect"},"64040052"));
 assert.equal(inspected.finalTaxPanelCount,1);
 assert.equal(inspected.finalTaxExpanded,true);
 assert.equal(driver.verifiedDetailRow(inspected),true);
});
test("guarded Sukuk Calculate requires live mode, identity guard, Sukuk code and blank col 2",async()=>{
 const sukukFake=new FakeIrisBankProfit({targetCode:"64330055",targetLabel:driver.BANK_PROFIT_TARGETS["64330055"]});
 const setupOut=await driver.ensureBankProfitFinalTaxRow(sukukFake,{mode:"live",code:"64330055",investment:"Sukuk",contents:"1. 123\n2. Sukuk\n3. Bank",beforeStep:async()=>{},timeoutMs:20,sleep:async()=>{}});
 assert.equal(setupOut.ok,true);
 assert.equal(driver.verifiedDirectSukukRow(sukukFake.window.eval(driver.buildPageScript({op:"inspect"},"64330055")),"64330055"),true);
 const noGuard=await driver.calculateBankProfitFinalTax(sukukFake,{mode:"live",code:"64330055",expectedChargeable:"12500",timeoutMs:20,sleep:async()=>{}});
 assert.equal(noGuard.ok,false);assert.equal(noGuard.status,"identity_guard_required");
 const nonSukuk=await driver.calculateBankProfitFinalTax(sukukFake,{mode:"live",code:"64040052",expectedChargeable:"12500",beforeStep:async()=>{},timeoutMs:20,sleep:async()=>{}});
 assert.equal(nonSukuk.ok,false);assert.equal(nonSukuk.status,"calculate_target_unverified");
 const inputs=sukukFake.rows()[0].querySelectorAll("input");inputs[0].value="100000";inputs[1].value="12500";
 const calcOut=await driver.calculateBankProfitFinalTax(sukukFake,{mode:"live",code:"64330055",expectedChargeable:"12500",beforeStep:async()=>{},timeoutMs:20,sleep:async()=>{}});
 assert.equal(calcOut.ok,true);assert.equal(calcOut.status,"calculated");assert.equal(inputs[2].value,"12500");
 assert.equal(sukukFake.clicks.filter(c=>/calculate/i.test(c.text)).length,1);
 const alreadyOut=await driver.calculateBankProfitFinalTax(sukukFake,{mode:"live",code:"64330055",expectedChargeable:"12500",beforeStep:async()=>{},timeoutMs:20,sleep:async()=>{}});
 assert.equal(alreadyOut.ok,true);assert.equal(alreadyOut.status,"already_calculated");
 assert.equal(sukukFake.clicks.filter(c=>/calculate/i.test(c.text)).length,1);
});
test("FBR-prepopulated MIS 64040052 row matches only when single detail row has exact approved Gross/Tax/Chargeable; blank or differing rows stay blocked",async()=>{
 for(const suffixFormat of [" - bank - mis","--123456-MCB BANK LIMITED"]){
  const fake=new FakeIrisBankProfit({preexistingRow:true,targetCode:"64040054",targetLabel:driver.BANK_PROFIT_TARGETS["64040054"]});
  const preRow=fake.rows().find(r=>r.classList.contains("section-detail-child-row"));
  assert.ok(preRow);
  preRow.querySelector(".row-description-text").textContent=`${driver.BANK_PROFIT_TARGETS["64040054"]}${suffixFormat}`;
  const inputs=preRow.querySelectorAll("input");
  inputs[0].value="2465";inputs[1].value="494";inputs[2].value="493";

  const exact=await driver.ensureBankProfitFinalTaxRow(fake,{
   mode:"live",code:"64040054",investment:"New Bank",contents:"New Details",
   expectedValues:["2465","494"],expectedChargeable:493,
   beforeStep:async()=>{},timeoutMs:20,sleep:async()=>{},
  });
  assert.equal(exact.ok,true,JSON.stringify(exact));
  assert.equal(exact.status,"row_present");
  assert.equal(exact.verifiedPrepopulatedMatch,true);
  assert.equal(fake.clicks.length,0);

  const differs=await driver.ensureBankProfitFinalTaxRow(fake,{
   mode:"live",code:"64040054",investment:"New Bank",contents:"New Details",
   expectedValues:["5000","750"],expectedChargeable:1000,
   beforeStep:async()=>{},timeoutMs:20,sleep:async()=>{},
  });
  assert.equal(differs.ok,false);
  assert.equal(differs.status,"row_layout_unverified");
  assert.equal(fake.clicks.length,0);

  inputs[0].value="";inputs[1].value="";inputs[2].value="";
  const blank=await driver.ensureBankProfitFinalTaxRow(fake,{
   mode:"live",code:"64040054",investment:"New Bank",contents:"New Details",
   expectedValues:["2465","494"],expectedChargeable:493,
   beforeStep:async()=>{},timeoutMs:20,sleep:async()=>{},
  });
  assert.equal(blank.ok,false);
  assert.equal(blank.status,"row_layout_unverified");
  assert.equal(fake.clicks.length,0);
 }
});

test("Multi-cert 64040052 matches existing FBR-prepopulated MIS row for cert 1 and safely adds sibling detail row for cert 2 (even with locked col 2)",async()=>{
 const fake=new FakeIrisBankProfit({preexistingRow:true,targetCode:"64040052",targetLabel:driver.BANK_PROFIT_TARGETS["64040052"]});
 const fbrRow=fake.rows().find(r=>r.classList.contains("section-detail-child-row"));
 fbrRow.querySelector(".row-description-text").textContent=`${driver.BANK_PROFIT_TARGETS["64040052"]}--MIS BANK`;
 const fbrInputs=fbrRow.querySelectorAll("input");
 fbrInputs[0].value="2465";fbrInputs[1].value="494";fbrInputs[2].value="493";fbrInputs[2].disabled=true;

 const sharedOpts={
  mode:"live",
  code:"64040052",
  allowedDetailDescriptions:[
   `${driver.BANK_PROFIT_TARGETS["64040052"]} - Cert 1 - 1. A`,
   `${driver.BANK_PROFIT_TARGETS["64040052"]} - Cert 2 - 1. B`,
  ],
  allowedFbrPrepopulatedRows:[
   {values:["2465","494"],expectedChargeable:493},
   {values:["4200000","630000"],expectedChargeable:840000},
  ],
  beforeStep:async()=>{},timeoutMs:20,sleep:async()=>{},
 };

 const cert1=await driver.ensureBankProfitFinalTaxRow(fake,{
  ...sharedOpts,
  investment:"Cert 1",contents:"1. A",
  expectedValues:["2465","494"],expectedChargeable:493,
 });
 assert.equal(cert1.ok,true,JSON.stringify(cert1));
 assert.equal(cert1.status,"row_present");
 assert.equal(cert1.verifiedPrepopulatedMatch,true);
 assert.equal(fake.clicks.length,0);

 const cert2=await driver.ensureBankProfitFinalTaxRow(fake,{
  ...sharedOpts,
  investment:"Cert 2",contents:"1. B",
  expectedValues:["4200000","630000"],expectedChargeable:840000,
 });
 assert.equal(cert2.ok,true,JSON.stringify(cert2));
 assert.equal(cert2.status,"row_detail_added");
 assert.equal(fake.rows().filter(r=>r.classList.contains("section-detail-child-row")).length,2);
});
