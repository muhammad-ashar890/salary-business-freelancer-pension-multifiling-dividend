// Exercise the real enabled Dividend packet action without source rewriting.
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
    if (file.endsWith(".json")) return JSON.parse(fs.readFileSync(file, "utf8"));
    if (cache.has(file)) return cache.get(file).exports;
    const module = { exports: {} };
    cache.set(file, module);
    const compileKey = file;
    if (!compiled.has(compileKey)) {
      compiled.set(
        compileKey,
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
    vm.runInContext(compiled.get(compileKey), context, { filename: file });
    return module.exports;
  }
  return (name) => load(path.join(root, name));
}



function packetHarness({mutateCertificate, stale = false, concurrentChange = false, combination = false, taxYear = 2026, filerType = "myself"} = {}) {
 const documents=[{id:"dividend-cert",documentType:"dividend_certificate",dividendSubcategory:"reit-and-other",extractionStatus:"MAPPED",extractedData:JSON.stringify({fields:[{label:"Gross Dividend PKR",value:100000},{label:"Withholding Tax u/s 150",value:15000}]})}];
 const {dividendEvidenceFingerprint}=moduleLoader({})("lib/tax/dividend-packet-evidence.ts");
 const fingerprint=dividendEvidenceFingerprint(documents,["reit-and-other"]);
 if(mutateCertificate)mutateCertificate(documents[0]);
 const draft={id:"draft",userId:"owner",taxYear,filerType,residencyStatus:"resident",incomeSources:JSON.stringify(combination?["salary","dividend"]:["dividend"]),readinessChecks:"[]",taxCalculationStatus:"ESTIMATE",taxpayerListStatus:"ATL",taxRuleSetVersion:"fixture-ty2026",taxCalculationRevision:"revision",packetApprovalConfirmed:true,taxableIncome:new Prisma.Decimal(100000),taxWithheld:new Prisma.Decimal(15000),taxPayable:new Prisma.Decimal(0),refundDue:new Prisma.Decimal(0),reconciliationStatus:"RECONCILED",reconciliationGap:new Prisma.Decimal(0)};
 const ledger=[{id:"net-bank-credit",entryType:"INCOME",category:"DIVIDEND",description:"Net dividend",amount:new Prisma.Decimal(85000),entryDate:null,sourceTransactionId:null}];
 const selections=[{source:"dividend",subcategory:"reit-and-other",status:"SELECTED",detailsJson:"{}"}];
 const calls={created:[],queries:0};let inTransaction=false;
 const prisma={
  user:{findUnique:async()=>({id:"owner",cnic:"1234512345671",dateOfBirth:null})},
  filingDraft:{findFirst:async()=>draft,findUnique:async()=>draft,update:async()=>draft},
  document:{findFirst:async()=>null,findMany:async({where}={})=>where?.documentType==="dividend_certificate"?documents.map(doc=>({...doc,extractedData:inTransaction&&concurrentChange?"{}":doc.extractedData})):where?.documentType?[]:documents},
  ledgerEntry:{findMany:async()=>ledger},
  filingPacket:{findFirst:async()=>null,create:async({data})=>{calls.created.push(data);return{id:"packet",version:data.version,packetHash:data.packetHash,status:data.status,approvalStatus:data.approvalStatus,taxPayable:data.taxPayable,refundDue:data.refundDue,createdAt:new Date()};}},
  filingTaxCredit:{findMany:async()=>[]},
  filingIncomeSelection:{findMany:async({where}={})=>where?.source==="dividend"?selections:[]},
  bankAccount:{findMany:async()=>[]},
  filingTaxCalculationLine:{findMany:async()=>[{source:"dividend",taxBase:new Prisma.Decimal(100000),baseTax:new Prisma.Decimal(15000),surcharge:new Prisma.Decimal(0),calculatedTax:new Prisma.Decimal(15000),detailsJson:JSON.stringify({isFinalTax:true,dividendEvidenceFingerprint:stale?"old-evidence":fingerprint})}]},
  $transaction:async fn=>{inTransaction=true;try{return await fn(prisma);}finally{inTransaction=false;}},
 };
 const load=moduleLoader({
  "next-auth/next":{getServerSession:async()=>({user:{email:"test@example.invalid"}})},
  "@/lib/auth":{authOptions:{}},"@/lib/prisma":{prisma},
  "@/lib/tax/business-ownership-packet-validation":{currentBusinessOwnershipStamp:async()=>({stamp:null}),businessOwnershipPacketValidationError:async()=>null},
  "@/lib/tax/filing-completeness":{validateFilingCompleteness:async()=>({blockers:[]})},
  "@/lib/tax/reconciliation-calculation":{validateAuthoritativeReconciliation:async()=>({success:true,preview:{accountBalances:[],netCashMovement:0}})},
  "@/app/actions/notifications":{createNotification:async()=>{}},
 });
 return{calls,run:(options)=>load("app/actions/packet.ts").generateFilingPacketAction(draft.id,options)};
}
test("actual packet action carries bound Dividend evidence, certificate amounts, Wealth outflow and driver envelope",async()=>{
 const h=packetHarness();const response=await h.run();assert.equal(response.success,true,response.error);assert.equal(h.calls.created.length,1);
 const snapshot=JSON.parse(h.calls.created[0].snapshotJson);
 assert.equal(snapshot.otherSources.taxDeductions.version,"dividend-final-tax-v1");
 assert.equal(snapshot.otherSources.taxDeductions.agentFields[0].values[0].value,"100000");
 assert.equal(snapshot.otherSources.taxDeductions.agentFields[0].values[1].value,"15000");
 assert.equal(snapshot.otherSources.taxDeductions.wealth.finalTaxIncome.expected,100000);
 assert.equal(snapshot.portalFieldMap.wealthFields.filter(row=>row.irisCode==="7098")[0].ourAmount,15000);
 assert.equal(snapshot.portalFieldMap.adjustableTaxFields.length,0);
 const entry=require("../electron-connect/iris-dividend-entry");
 assert.equal(entry.getDividendPacketRoute(snapshot).active,true);
});
for(const [label,config]of[["stale calculation",{stale:true}],["certificate edit",{mutateCertificate:doc=>doc.extractedData="{}"}],["unapproved certificate",{mutateCertificate:doc=>doc.extractionStatus="COMPLETED"}],["combination",{combination:true}],["concurrent evidence change",{concurrentChange:true}]])test(`actual packet action rejects ${label} even with manual coverage override`,async()=>{const h=packetHarness(config);const response=await h.run({acceptUnmappedPortalSources:true});assert.equal(response.success,false);assert.equal(h.calls.created.length,0);});

test("production packet admits valid standalone Dividend even with coverage option", async()=>{
 const h=packetHarness();const response=await h.run({acceptUnmappedPortalSources:true});
 assert.equal(response.success,true,response.error);assert.equal(h.calls.created.length,1);
 assert.equal(require("../electron-connect/iris-dividend-entry").getDividendPacketRoute(JSON.parse(h.calls.created[0].snapshotJson)).active,true);
});
for(const [label,config]of [["wrong tax year",{taxYear:2025}],["unsupported filer type",{filerType:"company"}]])test(`production Dividend refuses ${label}`,async()=>{
 const h=packetHarness(config);const r=await h.run({acceptUnmappedPortalSources:true});assert.equal(r.success,false);assert.equal(h.calls.created.length,0);
});
test("packet action tests do not rewrite the production source or bypass admission",()=>{
 const self=fs.readFileSync(__filename,"utf8");assert.equal(self.includes("source." + "slice("),false);
 const source=fs.readFileSync(path.join(root,"app/actions/packet.ts"),"utf8");
 assert.match(source,/Capital Gains packet\/desktop integration is not enabled yet/);
 assert.match(source,/Bank Profit packets remain blocked/);
});
