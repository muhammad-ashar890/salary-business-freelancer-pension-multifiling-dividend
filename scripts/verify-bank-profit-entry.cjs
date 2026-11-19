// Exercise the real server action, not a mirror of its pension-answer lookup.
// Only session/database/reconciliation/notification services are stubbed.
// No PostgreSQL, Gemini, browser, or live FBR connection is required.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const ts = require("typescript");
const { Prisma } = require("@prisma/client");

const root = path.resolve(__dirname, "..");
const compiled = new Map();
const FORMER_EMPLOYER = "former-employer-or-associate";
const FORMER_EMPLOYER_RULE = "TY2026-149IA-PENSION-FORMER-EMPLOYER-OR-ASSOCIATE";
const EXEMPT_PENSION_RULE = "TY2026-149IA-PENSION-UP-TO-10M";
const BELOW_70_PENSION_RULE = "TY2026-149IA-PENSION-ABOVE-10M-BELOW-AGE-70";

// Isolate each action's module cache and service doubles. The calculator,
// persisted-details parser, age rules, withholding, and Decimal helpers stay real.
function moduleLoader(mocks) {
  const cache = new Map();
  function load(name, parent = root) {
    if (Object.hasOwn(mocks, name)) return mocks[name];
    const absolute = name.startsWith("@/")
      ? path.join(root, name.slice(2))
      : name.startsWith(".")
        ? path.resolve(parent, name)
        : path.isAbsolute(name)
          ? name
          : null;
    if (!absolute) return require(name);
    const file =
      fs.existsSync(absolute) && fs.statSync(absolute).isFile()
        ? absolute
        : `${absolute}.ts`;
    if (file.endsWith(".json")) return JSON.parse(fs.readFileSync(file,"utf8"));
    if (cache.has(file)) return cache.get(file).exports;
    const module = { exports: {} };
    cache.set(file, module);
    if (!compiled.has(file)) {
      compiled.set(
        file,
        ts.transpileModule(fs.readFileSync(file, "utf8"), {
          compilerOptions: {
            module: ts.ModuleKind.CommonJS,
            target: ts.ScriptTarget.ES2020,
            esModuleInterop: true,
          },
          fileName: file,
        }).outputText,
      );
    }
    const context = vm.createContext({
      console,
      Date,
      exports: module.exports,
      module,
      require: (child) => load(child, path.dirname(file)),
    });
    vm.runInContext(compiled.get(file), context, { filename: file });
    return module.exports;
  }
  return (name) => load(path.join(root, name));
}


const fields=moduleLoader({})("lib/tax/bank-profit-certificate-fields.ts");
const L = fields.BANK_PROFIT_CERTIFICATE_LABELS;
const fixtureValues = {
  [L.taxYear]: 2026,
  [L.reportingPeriodStart]: "2025-07-01",
  [L.reportingPeriodEnd]: "2026-06-30",
  [L.bankName]: "Example Bank Limited",
  [L.bankNtn]: "1234567",
  [L.taxpayerName]: "Ayesha Example",
  [L.taxpayerCnic]: "42101-1234567-8",
  [L.taxpayerNtn]: null,
  [L.accountNumber]: "00123456789",
  [L.iban]: null,
  [L.instrumentCategory]: "Term Deposit",
  [L.printedSectionSubsection]: "Section 151(1)(b)",
  [L.grossAnnualProfit]: "1,000,000.00",
  [L.taxDeducted]: "150,000.00",
  [L.withholdingRate]: "15%",
  [L.atlStatus]: "ATL",
  [L.netProfitCredited]: "850,000.00",
  [L.currency]: "PKR",
  [L.sukukHolderType]: null,
  [L.sukukReturnBand]: null,
};
const makeFields = (values = fixtureValues) =>
  Object.entries(values).map(([label, value]) => ({ label, value }));


const entry=require("../electron-connect/iris-bank-profit-entry");
const {FakeIrisBankProfit}=require("./lib/fake-iris-bank-profit.cjs");
function snapshot(){
 const documents=[{id:"cert",extractionStatus:"MAPPED",bankProfitSubcategory:"bank-or-financial-institution-deposit",extractedData:JSON.stringify({fields:makeFields()})}];
 const input={taxYear:2026,filerType:"myself",incomeSources:["bank_profit"],taxpayerCnic:"4210112345678",documents,selectedSubcategories:["bank-or-financial-institution-deposit"],ledgerEntries:[{entryType:"INCOME",category:"BANK_PROFIT",amount:850000}]};
 const load=moduleLoader({}),proof=load("lib/tax/bank-profit-evidence.ts").buildBankProfitEvidence(input);
 const plan=load("lib/tax/bank-profit-packet.ts").buildBankProfitPacketPlan({...input,calculationRevision:"r1",storedTaxWithheld:150000,calculationLines:[{source:"bank_profit",subcategory:"bank-or-financial-institution-deposit",taxBase:1000000,calculatedTax:150000,detailsJson:JSON.stringify({isFinalTax:true,bankProfitEvidenceFingerprint:proof.evidenceFingerprint})}]});assert.equal(plan.ok,true,plan.reason);
 return {filing:{taxYear:2026,filerType:"myself",incomeSources:["bank_profit"],taxCalculationRevision:"r1"},otherSources:{bankProfit:JSON.parse(JSON.stringify(plan.plan))},portalFieldMap:{wealthFields:[{irisCode:"7098",ourAmount:150000,rowDescriptionIncludes:"Income tax deducted u/s 151"}]}};
}
function fixture({chargeable=true,...options}={}){
 const fake=new FakeIrisBankProfit(options);fake.webContents.getURL=()=>"https://iris.fbr.gov.pk/nitr/workflow";fake.window.Element.prototype.getClientRects=()=>[{width:10,height:10}];
 // Synthetic portal-derived chargeable reaction; never written by the driver.
 if(chargeable)fake.document.addEventListener("change",()=>{const row=fake.rows().find(el=>el.classList.contains("section-detail-child-row"));const cells=row?.querySelectorAll("input");if(cells?.length===3&&cells[0].value==="1000000"&&cells[1].value==="150000")cells[2].value="150000";});
 return fake;
}
const options=()=>({mode:"live",beforeStep:async()=>{},verifyDocument:async()=>({ok:true}),ensureSection:async()=>({ok:true}),timeoutMs:20,sleep:async()=>{}});
test("Bank Profit envelope validates real packet plan and refuses stale/tampered contracts",()=>{
 assert.equal(entry.getBankProfitPacketRoute(snapshot()).active,true);
 for(const mutate of [s=>s.filing.taxYear=2025,s=>s.filing.incomeSources.push("salary"),s=>delete s.otherSources.bankProfit,s=>s.otherSources.bankProfit.rows[0].irisCode="64040053",s=>s.otherSources.bankProfit.rows[0].values.push({columnIndex:2,value:"150000"}),s=>s.otherSources.bankProfit.rows[0].taxChargeable.readOnly=false,s=>s.otherSources.bankProfit.wealth.netBankCredits=1,s=>s.portalFieldMap.wealthFields.push({...s.portalFieldMap.wealthFields[0]})]){const s=snapshot();mutate(s);assert.equal(entry.getBankProfitPacketRoute(s).active,false);}
});
test("Bank Profit numeric driver creates exact Investment, types only gross/WHT and reads derived chargeable",async()=>{
 const fake=fixture();const out=await entry.fillBankProfitEntries(fake,entry.getBankProfitPacketRoute(snapshot()),options());assert.equal(out.ok,true,JSON.stringify(out));assert.equal(out.results.length,2);assert.deepEqual(out.results.map(row=>row.columnIndex),[0,1]);assert.equal(fake.clicks.some(click=>/save|calculate|submit|payment/i.test(click.text)),false);assert.equal(fake.rows()[1].querySelectorAll("input")[2].value,"150000");
});
test("Bank Profit numeric driver refuses identity failure, absent header or required guards before clicks",async()=>{
 for(const tweak of [(fake,o)=>o.verifyDocument=async()=>({ok:false}),(fake,o)=>delete o.beforeStep,(fake,o)=>fake.document.getElementById("999919").remove()]){const fake=fixture(),o=options();tweak(fake,o);const out=await entry.fillBankProfitEntries(fake,entry.getBankProfitPacketRoute(snapshot()),o);assert.equal(out.ok,false);assert.equal(fake.clicks.length,0);}
});
test("Bank Profit missing computed chargeable blocks without Calculate or invented tax",async()=>{
 const fake=fixture({chargeable:false});const out=await entry.fillBankProfitEntries(fake,entry.getBankProfitPacketRoute(snapshot()),options());assert.equal(out.ok,false);assert.equal(out.reason,"bank_profit_derived_chargeable_unverified");assert.equal(fake.rows()[1].querySelectorAll("input")[2].value,"");assert.equal(fake.clicks.some(click=>/calculate/i.test(click.text)),false);
});
test("Bank Profit different existing Investment is never reused or overwritten",async()=>{
 const fake=fixture({preexistingRow:true});const out=await entry.fillBankProfitEntries(fake,entry.getBankProfitPacketRoute(snapshot()),options());assert.equal(out.ok,false);assert.equal(fake.clicks.length,0);
});

test("Bank Profit fresh readback is exact-detail and read-only, then detects post-Save value drift",async()=>{
 const fake=fixture(),route=entry.getBankProfitPacketRoute(snapshot());assert.equal((await entry.fillBankProfitEntries(fake,route,options())).ok,true);
 const before=fake.clicks.length;const good=await entry.readBankProfitEntries(fake,route,options());assert.equal(good.complete,true);assert.equal(good.checks.length,2);assert.equal(fake.clicks.length,before);
 fake.rows()[1].querySelectorAll("input")[0].value="999999";const drift=await entry.readBankProfitEntries(fake,route,options());assert.equal(drift.complete,false);assert.equal(drift.checks[0].status,"mismatch");assert.equal(fake.rows()[1].querySelectorAll("input")[0].value,"999999");assert.equal(fake.clicks.length,before);
});
test("Bank Profit exact existing detail with conflicting WHT is refused before either cell changes",async()=>{
 const fake=fixture({preexistingRow:true}),route=entry.getBankProfitPacketRoute(snapshot()),row=route.rows[0];fake.rows()[1].querySelector(".row-description-text").textContent=`${row.label} - ${row.investment} - ${row.contents}`;
 const inputs=fake.rows()[1].querySelectorAll("input");inputs[0].value="";inputs[1].value="1";
 const out=await entry.fillBankProfitEntries(fake,route,options());assert.equal(out.ok,false);assert.equal(inputs[0].value,"");assert.equal(inputs[1].value,"1");assert.equal(fake.clicks.length,0);
});
test("Bank Profit mutation guard is rechecked before every cell operation",async()=>{
 const fake=fixture(),route=entry.getBankProfitPacketRoute(snapshot());let allowed=true;
 const evaluate=fake.webContents.executeJavaScript;fake.webContents.executeJavaScript=async script=>{const out=await evaluate(script);if(script.includes('"op":"fill","columnIndex":0'))allowed=false;return out;};
 const out=await entry.fillBankProfitEntries(fake,route,{...options(),verifyDocument:async()=>({ok:allowed})});assert.equal(out.ok,false);assert.equal(fake.rows()[1].querySelectorAll("input")[1].value,"");
});

test("Bank Profit completion needs actual Save, unique post-Save document/cell matches, fresh7033 and zero703000",async()=>{
 const fake=fixture(),route=entry.getBankProfitPacketRoute(snapshot());assert.equal((await entry.fillBankProfitEntries(fake,route,options())).ok,true);
 const bankReadback=await entry.readBankProfitEntries(fake,route,options());
 const input=()=>({saveOutcome:{clicked:true},bankReadback:JSON.parse(JSON.stringify(bankReadback)),wealthTotals:{7033:"1,000,000",703000:"0"},otherReadbacksComplete:true});
 assert.equal(entry.checkBankProfitCompletion(route,input()).ok,true);
 for(const mutate of [o=>o.saveOutcome.clicked=false,o=>o.saveOutcome.dialog={closed:false},o=>o.bankReadback.complete=false,o=>o.bankReadback.checks.pop(),o=>o.bankReadback.checks.push({...o.bankReadback.checks[0]}),o=>o.bankReadback.checks[0].documentId="another-account",o=>o.wealthTotals[7033]="850000",o=>delete o.wealthTotals[703000],o=>o.wealthTotals[703000]="1",o=>o.otherReadbacksComplete=false]){const o=input();mutate(o);assert.equal(entry.checkBankProfitCompletion(route,o).ok,false);}
});

test("main entrypoints refuse stale Bank Profit packets before acquiring worker window",async()=>{
 const source=fs.readFileSync(path.join(root,"electron-connect/main.js"),"utf8"),ast=ts.createSourceFile("main.js",source,ts.ScriptTarget.Latest,true,ts.ScriptKind.JS);
 for(const name of ["runLocalIrisNavigationCheck","runRealIrisAutofill"]){
  const fn=ast.statements.find(node=>ts.isFunctionDeclaration(node)&&node.name?.text===name).getText(ast);let windows=0;
  const context=vm.createContext({console,Date,Promise,assertNavigatorBuild:()=>{},pensionEntryHold:()=>null,getServicesPacketRoute:()=>({incomeSources:["bank_profit"]}),irisBankProfitEntry:entry,ensureWorkerWindow:async()=>{windows++;throw Error("worker must not open");}});vm.runInContext(fn,context);
  const s=snapshot();delete s.otherSources;const out=await context[name]({filingPacket:{snapshot:s}},{id:"job"},"live");assert.equal(out.paused,true);assert.equal(windows,0);assert.match(out.pauseMessage,/Bank Profit packet refused/);
 }
});
test("Bank Profit frame selection rejects unapproved origins and ambiguous portal frames",async()=>{
 for(const ambiguous of [false,true]){const fake=fixture();const wc=fake.webContents;wc.mainFrame={framesInSubtree:ambiguous?[{url:"https://iris.fbr.gov.pk/nitr/workflow",executeJavaScript:wc.executeJavaScript},{url:"https://iris.fbr.gov.pk/nitr/workflow",executeJavaScript:wc.executeJavaScript}]:[{url:"https://unapproved.example/",executeJavaScript:wc.executeJavaScript}]};
 const out=await entry.fillBankProfitEntries(fake,entry.getBankProfitPacketRoute(snapshot()),options());assert.equal(out.ok,false);assert.equal(out.reason,"bank_profit_frame_not_unique");assert.equal(fake.clicks.length,0);assert.equal(out.results.length,2);
 }
});
test("main wiring preserves protected build and packages both Bank modules",()=>{
 const source=fs.readFileSync(path.join(root,"electron-connect/main.js"),"utf8"),pkg=JSON.parse(fs.readFileSync(path.join(root,"electron-connect/package.json"),"utf8"));
 for(const file of ["iris-bank-profit-entry.js","iris-bank-profit-row-driver.js"])assert.ok(pkg.build.files.includes(file));
 assert.ok(source.includes('const AGENT_BUILD_TAG = "pension-services-multifiling-20261106a"'));
 assert.ok(source.includes('routePolicy: "services_save_once"'));
 assert.equal(require("../electron-connect/fbr-handoff-route").buildFbrHandoffRoute(["bank_profit"]).label,"Bank Profit / Sukuk");
});

function certifiedSnapshot(definitions){
 const documents=definitions.map((def,i)=>({id:`cert-${i}`,extractionStatus:"MAPPED",bankProfitSubcategory:def.category,extractedData:JSON.stringify({fields:makeFields({...fixtureValues,...def.values})})}));
 const net=definitions.reduce((sum,def)=>sum+Number(def.values?.[L.netProfitCredited]??850000),0),withheld=definitions.reduce((sum,def)=>sum+Number(def.values?.[L.taxDeducted]??150000),0);
 const input={taxYear:2026,filerType:"myself",incomeSources:["bank_profit"],taxpayerCnic:"4210112345678",documents,selectedSubcategories:definitions.map(def=>def.category),ledgerEntries:[{entryType:"INCOME",category:"BANK_PROFIT",amount:net}]};
 const load=moduleLoader({}),proof=load("lib/tax/bank-profit-evidence.ts").buildBankProfitEvidence(input);assert.equal(proof.ok,true,proof.reason);
 const plan=load("lib/tax/bank-profit-packet.ts").buildBankProfitPacketPlan({...input,calculationRevision:"r1",storedTaxWithheld:withheld,calculationLines:definitions.map(def=>({source:"bank_profit",subcategory:def.category,taxBase:proof.bySubcategory[def.category].grossAmount,calculatedTax:def.chargeable,detailsJson:JSON.stringify({isFinalTax:true,bankProfitEvidenceFingerprint:proof.evidenceFingerprint})}))});assert.equal(plan.ok,true,plan.reason);
 return {filing:{taxYear:2026,filerType:"myself",incomeSources:["bank_profit"],taxCalculationRevision:"r1"},otherSources:{bankProfit:JSON.parse(JSON.stringify(plan.plan))},portalFieldMap:{wealthFields:withheld?[{irisCode:"7098",ourAmount:withheld,rowDescriptionIncludes:"Income tax deducted u/s 151"}]:[]}};
}
function syntheticDerivedReaction(fake,route){
 fake.document.addEventListener("change",()=>{for(const row of route.rows){const nodes=Array.from(fake.document.querySelectorAll(".tableRows.dataRow")).filter(el=>el.id===row.irisCode);const node=nodes.find(el=>el.classList.contains("section-detail-child-row")===(row.detailMode==="investment"));const cells=node?.querySelectorAll("input");if(cells?.length===3&&cells[0].value===row.values[0].value&&cells[1].value===row.values[1].value)cells[2].value=String(row.taxChargeable.expected);}});
}
test("direct Sukuk uses only its two editable cells; disabled derived tax is never written or Calculated",async()=>{
 const s=certifiedSnapshot([{category:"sukuk-individual-aop-below-1m",chargeable:80000,values:{[L.instrumentCategory]:"Sukuk",[L.printedSectionSubsection]:"151(1A)",[L.sukukHolderType]:"Individual",[L.sukukReturnBand]:"Below PKR1M",[L.grossAnnualProfit]:800000,[L.taxDeducted]:80000,[L.netProfitCredited]:720000}}]);
 const route=entry.getBankProfitPacketRoute(s);assert.equal(route.active,true);const row=route.rows[0],fake=fixture({chargeable:false,targetCode:row.irisCode,targetLabel:row.label});syntheticDerivedReaction(fake,route);
 const out=await entry.fillBankProfitEntries(fake,route,options());assert.equal(out.ok,true,JSON.stringify(out));assert.equal(out.results.length,2);assert.equal(fake.rows().length,1);assert.equal(fake.rows()[0].querySelectorAll("input")[2].disabled,true);assert.equal(fake.clicks.some(click=>click.id==="add-adjustable-tax-generic"||/calculate|save|submit/i.test(click.text)),false);assert.equal((await entry.readBankProfitEntries(fake,route,options())).complete,true);
});
test("two category-bound Bank Investment rows fill and read back independently without code collisions",async()=>{
 const s=certifiedSnapshot([{category:"bank-or-financial-institution-deposit",chargeable:150000,values:{}},{category:"other-profit-on-debt",chargeable:150000,values:{[L.instrumentCategory]:"Other profit on debt",[L.printedSectionSubsection]:"151(1)(d)"}}]);const route=entry.getBankProfitPacketRoute(s);assert.equal(route.active,true);
 const fake=fixture({chargeable:false,targets:route.rows.map(row=>[row.irisCode,row.label])});syntheticDerivedReaction(fake,route);
 const out=await entry.fillBankProfitEntries(fake,route,options());assert.equal(out.ok,true,JSON.stringify(out));assert.equal(out.results.length,4);assert.equal(new Set(out.results.map(row=>row.key)).size,4);assert.equal((await entry.readBankProfitEntries(fake,route,options())).complete,true);assert.equal(fake.clicks.some(click=>/calculate|save|submit/i.test(click.text)),false);
});
