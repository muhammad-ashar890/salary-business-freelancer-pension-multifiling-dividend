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
test("Bank Profit operation allowlist refuses Calculate, Save, payment, CG and unsupported taxpayer categories",()=>{
 for(const op of ["calculate","save","submit","payment"])assert.throws(()=>driver.buildPageScript({op}),/unsupported operation/);
 for(const code of ["64040053","64330056","64151351","64220158"])assert.throws(()=>driver.buildPageScript({op:"inspect",code}),/unsupported profit category/);
 assert.equal(driver.calculateBankProfitFinalTax,undefined);
});
