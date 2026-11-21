// Exercise the real Dividend packet action; production remains gated.
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
function moduleLoader(mocks, bypassBankGateForTest = false) {
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
    const compileKey = `${file}:${bypassBankGateForTest}`;
    if (!compiled.has(compileKey)) {
      compiled.set(
        compileKey,
        ts.transpileModule((() => {
          const source = fs.readFileSync(file, "utf8");
          if (!bypassBankGateForTest || file !== path.join(root, "app/actions/packet.ts")) return source;
          // TEST ONLY: reach snapshot/transaction checks without enabling production.
          const start = source.indexOf("    // Bank Profit desktop safety gate");
          const end = source.indexOf("    // Standalone TY2026 cash Dividend", start);
          assert.ok(start >= 0 && end > start, "expected production Bank Profit gate");
          return source.slice(0, start) + source.slice(end);
        })(), {
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
      URL,
      Date,
      // process.env is read by lib/tax/bank-profit-enablement.ts; without it the
      // switch looks unset and every enabled-mode assertion fails.
      process,
      exports: module.exports,
      module,
      require: (child) => load(child, path.dirname(file)),
    });
    vm.runInContext(compiled.get(compileKey), context, { filename: file });
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

function packetHarness({mutateCertificate, stale = false, concurrentChange = false, combination = false, productionGate = false, ledgerRace = false, creditRace = false, identityRace = false, calculationRace = false, withholdingRace = false, taxYear = 2026, filerType = "myself"} = {}) {
 const documents=[{id:"bank-cert",documentType:"bank_certificate",bankProfitSubcategory:"bank-or-financial-institution-deposit",extractionStatus:"MAPPED",extractedData:JSON.stringify({fields:makeFields()})}];
 const evidenceInput={taxYear:2026,filerType:"myself",incomeSources:["bank_profit"],taxpayerCnic:"4210112345678",documents,selectedSubcategories:["bank-or-financial-institution-deposit"],ledgerEntries:[{entryType:"INCOME",category:"BANK_PROFIT",amount:850000}]};
 const fingerprint=moduleLoader({})("lib/tax/bank-profit-evidence.ts").buildBankProfitEvidence(evidenceInput).evidenceFingerprint;
 if(mutateCertificate)mutateCertificate(documents[0]);
 const draft={id:"draft",userId:"owner",taxYear,filerType,residencyStatus:"resident",incomeSources:JSON.stringify(combination?["salary","bank_profit"]:["bank_profit"]),readinessChecks:"[]",taxCalculationStatus:"ESTIMATE",taxpayerListStatus:"ATL",taxRuleSetVersion:"fixture-ty2026",taxCalculationRevision:"revision",packetApprovalConfirmed:true,taxableIncome:new Prisma.Decimal(1000000),taxWithheld:new Prisma.Decimal(150000),taxPayable:new Prisma.Decimal(0),refundDue:new Prisma.Decimal(0),reconciliationStatus:"RECONCILED",reconciliationGap:new Prisma.Decimal(0)};
 const ledger=[{id:"net-bank-credit",entryType:"INCOME",category:"BANK_PROFIT",description:"Net dividend",amount:new Prisma.Decimal(850000),entryDate:null,sourceTransactionId:null}];
 const selections=[{source:"bank_profit",subcategory:"bank-or-financial-institution-deposit",status:"SELECTED",detailsJson:"{}"}];
 const previousDocuments=[];const calls={created:[],queries:0};let inTransaction=false;
 const prisma={
  user:{findUnique:async()=>({id:"owner",cnic:inTransaction&&identityRace?"1234512345671":"4210112345678",dateOfBirth:null})},
  filingDraft:{findFirst:async()=>inTransaction&&withholdingRace?{...draft,taxWithheld:new Prisma.Decimal(1)}:draft,findUnique:async()=>draft,update:async()=>draft},
  document:{findFirst:async()=>null,findMany:async({where}={})=>where?.documentType==="bank_certificate"?documents.map(doc=>({...doc,extractedData:inTransaction&&concurrentChange?"{}":doc.extractedData})):where?.documentType==="previous_return"?previousDocuments:where?.documentType?[]:documents},
  ledgerEntry:{findMany:async()=>inTransaction&&ledgerRace?[{...ledger[0],amount:new Prisma.Decimal(800000)}]:ledger},
  filingPacket:{findFirst:async()=>null,create:async({data})=>{calls.created.push(data);return{id:"packet",version:data.version,packetHash:data.packetHash,status:data.status,approvalStatus:data.approvalStatus,taxPayable:data.taxPayable,refundDue:data.refundDue,createdAt:new Date()};}},
  filingTaxCredit:{findMany:async()=>inTransaction&&creditRace?[{amount:new Prisma.Decimal(150000)}]:[]},
  filingIncomeSelection:{findMany:async({where}={})=>where?.source==="bank_profit"?selections:[]},
  bankAccount:{findMany:async()=>[]},
  filingTaxCalculationLine:{findMany:async()=>[{source:"bank_profit",subcategory:"bank-or-financial-institution-deposit",taxBase:new Prisma.Decimal(1000000),baseTax:new Prisma.Decimal(150000),surcharge:new Prisma.Decimal(0),calculatedTax:new Prisma.Decimal(150000),detailsJson:JSON.stringify({isFinalTax:true,bankProfitEvidenceFingerprint:stale||inTransaction&&calculationRace?"old-evidence":fingerprint})}]},
  $transaction:async fn=>{inTransaction=true;try{return await fn(prisma);}finally{inTransaction=false;}},
 };
 const load=moduleLoader({
  "next-auth/next":{getServerSession:async()=>({user:{email:"test@example.invalid"}})},
  "@/lib/auth":{authOptions:{}},"@/lib/prisma":{prisma},
  "@/lib/tax/business-ownership-packet-validation":{currentBusinessOwnershipStamp:async()=>({stamp:null}),businessOwnershipPacketValidationError:async()=>null},
  "@/lib/tax/filing-completeness":{validateFilingCompleteness:async()=>({blockers:[]})},
  "@/lib/tax/reconciliation-calculation":{validateAuthoritativeReconciliation:async()=>({success:true,preview:{accountBalances:[],netCashMovement:0}})},
  "@/app/actions/notifications":{createNotification:async()=>{}},
  "@/lib/tax/fbr-desktop":{hashToken:()=>"test-device-hash"},
  "@/lib/tax/fbr-agent-config":{resolveIrisRouteFamily:()=>null,getCombinedAgentConfig:()=>({}),DEFAULT_SELECTOR_BUNDLE:{},getFbrPortalAutomationConfig:async()=>({selectorBundle:{bundleVersion:"test",bundleId:"test"},readiness:{loginUrl:"https://iris.fbr.gov.pk",readySelector:"test"},dryRun:{entryUrl:"test",reviewGateSelector:"test",finalSubmitSelector:"test"}})},
 }, !productionGate);
 return{calls,documents,previousDocuments,draft,ledger,selections,context:async(snapshot)=>{
   let accepted=0,audits=0;
   prisma.trustedDevice={findUnique:async()=>({id:"device",userId:"owner",status:"ACTIVE"})};
   prisma.localAgentJob={findFirst:async()=>({id:"job",userId:"owner",filingDraftId:draft.id,status:"created",payloadJson:JSON.stringify({packetId:"packet",packetVersion:1,packetHash:"pinned"}),filingDraft:draft}),update:async()=>{accepted++;return{};}};
   prisma.taxAuditEvent={create:async()=>{audits++;return{};}};
   prisma.filingPacket.findFirst=async({where})=>{assert.equal(where.userId,"owner");assert.equal(where.packetHash,"pinned");return{id:"packet",version:1,packetHash:"pinned",snapshotJson:JSON.stringify(snapshot)};};
   const response=await load("app/api/local-agent/jobs/[jobId]/context/route.ts").GET({url:"https://test.invalid/context?deviceToken=test-token",headers:new Headers()},{params:Promise.resolve({jobId:"job"})});
   return{status:response.status,body:await response.json(),accepted,audits};
 },validate:snapshot=>load("lib/tax/bank-profit-packet-validation.ts").bankProfitPacketValidationError(snapshot,draft.id,"owner"),run:(options)=>load("app/actions/packet.ts").generateFilingPacketAction(draft.id,options)};
}

test("actual Bank Profit packet carries certificate gross, actual WHT, read-only chargeable and one151 Wealth outflow",async()=>{
 const h=packetHarness();const r=await h.run();assert.equal(r.success,true,r.error);assert.equal(h.calls.created.length,1);
 const snapshot=JSON.parse(h.calls.created[0].snapshotJson),plan=snapshot.otherSources.bankProfit;
 assert.equal(plan.version,"bank-profit-final-tax-v1");assert.equal(plan.rows[0].values[0].value,"1000000");assert.equal(plan.rows[0].values[1].value,"150000");assert.equal(plan.rows[0].taxChargeable.readOnly,true);assert.equal(plan.rows[0].values.some(cell=>cell.columnIndex===2),false);
 assert.equal(plan.wealth.finalTaxIncome.expected,1000000);assert.equal(plan.wealth.netBankCredits,850000);
 const outflows=snapshot.portalFieldMap.wealthFields.filter(row=>row.irisCode==="7098");assert.equal(outflows.length,1);assert.equal(outflows[0].ourAmount,150000);assert.equal(outflows[0].rowDescriptionIncludes,"Income tax deducted u/s 151");
 assert.equal(snapshot.portalFieldMap.adjustableTaxFields.length,0);assert.equal(snapshot.portalFieldMap.incomeFields.some(row=>["7033","703000","500104"].includes(row.irisCode)),false);
});
for(const [name,config]of[["stale calculation",{stale:true}],["certificate edited",{mutateCertificate:doc=>doc.extractedData="{}"}],["unapproved certificate",{mutateCertificate:doc=>doc.extractionStatus="COMPLETED"}],["combination",{combination:true}],["transaction certificate edit",{concurrentChange:true}],["transaction net change",{ledgerRace:true}],["transaction duplicate tax credit",{creditRace:true}],["transaction taxpayer change",{identityRace:true}]])test(`actual Bank Profit packet rejects ${name} even with coverage override`,async()=>{const h=packetHarness(config);const r=await h.run({acceptUnmappedPortalSources:true});assert.equal(r.success,false);assert.equal(h.calls.created.length,0);});
test("production Bank Profit packet admits valid Bank Profit-only filing by default without .env flag",async()=>{
 const previous=process.env.TAXROCKET_BANK_PROFIT_PACKET;delete process.env.TAXROCKET_BANK_PROFIT_PACKET;
 try{
  const h=packetHarness({productionGate:true});const r=await h.run({acceptUnmappedPortalSources:true});
  assert.equal(r.success,true,r.error);assert.equal(h.calls.created.length,1);
  const snapshot=JSON.parse(h.calls.created[0].snapshotJson);
  assert.equal(snapshot.otherSources.bankProfit.version,"bank-profit-final-tax-v1");
  assert.equal(require("../electron-connect/iris-bank-profit-entry").getBankProfitPacketRoute(snapshot).active,true);
 } finally {
  if(previous!==undefined)process.env.TAXROCKET_BANK_PROFIT_PACKET=previous;
 }
});
test("explicit TAXROCKET_BANK_PROFIT_PACKET=off kill switch still blocks Bank Profit packets",async()=>{
 const previous=process.env.TAXROCKET_BANK_PROFIT_PACKET;process.env.TAXROCKET_BANK_PROFIT_PACKET="off";
 try{
  const h=packetHarness({productionGate:true});const r=await h.run({acceptUnmappedPortalSources:true});
  assert.equal(r.success,false);assert.match(r.error,/Bank Profit packets are disabled/);assert.equal(h.calls.created.length,0);
 } finally {
  if(previous===undefined)delete process.env.TAXROCKET_BANK_PROFIT_PACKET;else process.env.TAXROCKET_BANK_PROFIT_PACKET=previous;
 }
});
for(const [name,config]of[["a TY2025 draft",{taxYear:2025}],["a company filer",{filerType:"company"}]])test(`production Bank Profit packet still refuses ${name}`,async()=>{
 const h=packetHarness({productionGate:true,...config});const r=await h.run({acceptUnmappedPortalSources:true});assert.equal(r.success,false);assert.equal(h.calls.created.length,0);
});
test("production Bank Profit packet never accepts a combination",async()=>{
 const h=packetHarness({productionGate:true,combination:true});const r=await h.run({acceptUnmappedPortalSources:true});assert.equal(r.success,false);assert.match(r.error,/Bank Profit-only/);assert.equal(h.calls.created.length,0);
});

test("real server Bank Profit validator accepts current approved packet, including flattened context map",async()=>{
 const h=packetHarness();assert.equal((await h.run()).success,true);const snapshot=JSON.parse(h.calls.created[0].snapshotJson);assert.equal(await h.validate(snapshot),null);
 snapshot.portalFieldMapDetailed=snapshot.portalFieldMap;snapshot.portalFieldMap=moduleLoader({})("lib/tax/portal-field-map.ts").flattenPortalFieldMap(snapshot.portalFieldMapDetailed);assert.equal(await h.validate(snapshot),null);
});
for(const [name,mutate]of[
 ["edited certificate",(h,s)=>h.documents[0].extractedData="{}"],
 ["changed revision",(h,s)=>h.draft.taxCalculationRevision="new"],
 ["revoked approval",(h,s)=>h.draft.packetApprovalConfirmed=false],
 ["changed selection",(h,s)=>h.selections[0].subcategory="other-profit-on-debt"],
 ["changed bank net",(h,s)=>h.ledger[0].amount=new Prisma.Decimal(800000)],
 ["edited cell",(h,s)=>s.otherSources.bankProfit.rows[0].values[0].value="999999"],
 ["missing envelope",(h,s)=>delete s.otherSources.bankProfit],
 ["duplicate151 outflow",(h,s)=>s.portalFieldMap.wealthFields.push({...s.portalFieldMap.wealthFields.find(row=>row.irisCode==="7098")})],
])test(`real server Bank Profit validator refuses ${name}`,async()=>{const h=packetHarness();assert.equal((await h.run()).success,true);const snapshot=JSON.parse(h.calls.created[0].snapshotJson);mutate(h,snapshot);assert.equal(typeof await h.validate(snapshot),"string");});

for(const config of [{calculationRace:true},{withholdingRace:true}])test(`transaction rechecks current calculation lines and stored actual WHT ${JSON.stringify(config)}`,async()=>{const h=packetHarness(config);const r=await h.run();assert.equal(r.success,false);assert.equal(h.calls.created.length,0);});

test("real context GET preserves Bank envelope while flattening pinned map and runs current-evidence checks before accepting",async()=>{
 const h=packetHarness();assert.equal((await h.run()).success,true);const snapshot=JSON.parse(h.calls.created[0].snapshotJson);
 const response=await h.context(snapshot);assert.equal(response.status,200,JSON.stringify(response.body));assert.equal(response.accepted,1);assert.equal(response.audits,1);assert.deepEqual(response.body.snapshot.otherSources.bankProfit,snapshot.otherSources.bankProfit);assert.ok(Array.isArray(response.body.snapshot.portalFieldMap));assert.equal(response.body.snapshot.portalFieldMapDetailed.wealthFields[0].irisCode,"7098");
});
test("real context GET refuses edited Bank certificate before accepting or auditing the job",async()=>{
 const h=packetHarness();assert.equal((await h.run()).success,true);const snapshot=JSON.parse(h.calls.created[0].snapshotJson);h.documents[0].extractedData="{}";
 const response=await h.context(snapshot);assert.equal(response.status,409,JSON.stringify(response.body));assert.equal(response.body.code,"BANK_PROFIT_REVIEW_REQUIRED");assert.equal(response.accepted,0);assert.equal(response.audits,0);
});

function priorBankReturn(){return {documentType:"previous_return",extractionStatus:"MAPPED",extractedData:JSON.stringify({fields:Object.entries({"Taxpayer Name":"Test Owner","Registration No":"4210112345678","Tax Year":2025,"Total Assets (7019)":2000000,"Total Liabilities (7029)":500000,"Net Assets (703001)":1500000}).map(([label,value])=>({label,value}))})};}
test("Bank packet and real context preserve Previous Return opening wealth separately from current gross",async()=>{const h=packetHarness();h.previousDocuments.push(priorBankReturn());const made=await h.run();assert.equal(made.success,true,made.error);const snapshot=JSON.parse(h.calls.created[0].snapshotJson);assert.equal(snapshot.wealthExpectations.previousYearNetAssets.expected,1500000);assert.equal(snapshot.otherSources.bankProfit.wealth.finalTaxIncome.expected,1000000);assert.equal(await h.validate(snapshot),null);const response=await h.context(snapshot);assert.equal(response.status,200,JSON.stringify(response.body));assert.equal(response.body.snapshot.wealthExpectations.previousYearNetAssets.expected,1500000);h.previousDocuments[0].extractionStatus="COMPLETED";assert.notEqual(await h.validate(snapshot),null);const refused=await h.context(snapshot);assert.equal(refused.status,409);assert.equal(refused.accepted,0);});
test("Bank fresh validator rejects removal of Previous Return after packet approval",async()=>{const h=packetHarness();h.previousDocuments.push(priorBankReturn());assert.equal((await h.run()).success,true);const snapshot=JSON.parse(h.calls.created[0].snapshotJson);h.previousDocuments.length=0;assert.notEqual(await h.validate(snapshot),null);});

test("two certificates in the same Investment category emit two deterministic Investment rows and pass full packet generation + validation",async()=>{
 const sub="bank-or-financial-institution-deposit";
 const makeDoc=(id,bank,acct,gross,tax,net)=>({
  id,documentType:"bank_certificate",bankProfitSubcategory:sub,extractionStatus:"MAPPED",
  extractedData:JSON.stringify({fields:makeFields({...fixtureValues,[L.bankName]:bank,[L.accountNumber]:acct,[L.grossAnnualProfit]:String(gross),[L.taxDeducted]:String(tax),[L.netProfitCredited]:String(net)})}),
 });
 const cert1=makeDoc("cert-b","Beta Bank Ltd","PK222",500000,75000,425000);
 const cert2=makeDoc("cert-a","Alpha Bank Ltd","PK111",1000000,150000,850000);
 const documents=[cert1,cert2];
 const evidenceInput={taxYear:2026,filerType:"myself",incomeSources:["bank_profit"],taxpayerCnic:"4210112345678",documents,selectedSubcategories:[sub],ledgerEntries:[{entryType:"INCOME",category:"BANK_PROFIT",amount:1275000}]};
 const load=moduleLoader({});
 const evidence=load("lib/tax/bank-profit-evidence.ts").buildBankProfitEvidence(evidenceInput);
 assert.equal(evidence.ok,true,evidence.reason);
 assert.equal(evidence.grossAmount,1500000);
 assert.equal(evidence.taxWithheld,225000);
 const plan=load("lib/tax/bank-profit-packet.ts").buildBankProfitPacketPlan({
  ...evidenceInput,calculationRevision:"rev-multi",storedTaxWithheld:225000,
  calculationLines:[{source:"bank_profit",subcategory:sub,taxBase:1500000,calculatedTax:300000,detailsJson:JSON.stringify({isFinalTax:true,bankProfitEvidenceFingerprint:evidence.evidenceFingerprint})}],
 });
 assert.equal(plan.ok,true,plan.reason);
 assert.equal(plan.plan.rows.length,2);
 // Sorted deterministically by documentId: cert-a then cert-b
 assert.equal(plan.plan.rows[0].documentId,"cert-a");
 assert.equal(plan.plan.rows[0].values[0].value,"1000000");
 assert.equal(plan.plan.rows[0].taxChargeable.expected,200000);
 assert.equal(plan.plan.rows[1].documentId,"cert-b");
 assert.equal(plan.plan.rows[1].values[0].value,"500000");
 assert.equal(plan.plan.rows[1].taxChargeable.expected,100000);
 assert.equal(plan.plan.wealth.finalTaxIncome.expected,1500000);
 assert.equal(plan.plan.wealth.taxOutflow.amount,225000);

 // Duplicate Investment descriptions in the same category must be refused
 const dupDocs=[makeDoc("dup-1","Alpha Bank","PK111",1000000,150000,850000),makeDoc("dup-2","Alpha Bank","PK111",500000,75000,425000)];
 const dupInput={...evidenceInput,documents:dupDocs};
 const dupProof=load("lib/tax/bank-profit-evidence.ts").buildBankProfitEvidence(dupInput);
 assert.equal(dupProof.ok,true);
 const dupPlan=load("lib/tax/bank-profit-packet.ts").buildBankProfitPacketPlan({
  ...dupInput,calculationRevision:"rev-dup",storedTaxWithheld:225000,
  calculationLines:[{source:"bank_profit",subcategory:sub,taxBase:1500000,calculatedTax:300000,detailsJson:JSON.stringify({isFinalTax:true,bankProfitEvidenceFingerprint:dupProof.evidenceFingerprint})}],
 });
 assert.equal(dupPlan.ok,false);
 assert.match(dupPlan.reason,/distinct accounts or investments/);
});
