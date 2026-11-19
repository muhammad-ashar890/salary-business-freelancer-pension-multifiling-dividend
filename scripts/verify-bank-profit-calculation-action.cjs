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

function harness({ categories = ["bank-or-financial-institution-deposit"], certs, sources = ["bank_profit"], taxDebit = 0, stored = 999999, details = {}, net = 850000, taxpayerCnic = "4210112345678", beforeTransaction } = {}) {
  const draft = { id: "dividend-draft", userId: "user", taxYear: 2026, filerType: "myself", incomeSources: JSON.stringify(sources), taxWithheld: new Prisma.Decimal(stored), incomeSelections: categories.map(subcategory => ({ source: sources.includes("capital_gains") ? "capital_gains" : "bank_profit", subcategory, detailsJson: JSON.stringify(details) })) };
  const documents = certs ?? [{id:"bank-cert",extractionStatus:"MAPPED",extractedData:JSON.stringify({fields:makeFields()})}];
  const entries = [{id: "net", entryType: "INCOME", category: "BANK_PROFIT", description: "Net dividend", amount: new Prisma.Decimal(net)}, ...(taxDebit ? [{id: "tax", entryType: "EXPENSE", category: "TAX_PAYMENT", description: "Unattributed tax", amount: new Prisma.Decimal(taxDebit)}] : [])];
  const calls = { lines: [] };
  const prisma = {
    user: {findUnique: async () => ({id: "user", dateOfBirth: null, cnic: taxpayerCnic})},
    filingDraft: {findFirst: async () => draft, update: async ({data}) => Object.assign(draft, data)},
    ledgerEntry: {findMany: async () => entries},
    document: {findMany: async () => documents, findFirst: async () => null},
    filingTaxCalculationLine: {deleteMany: async () => ({}), createMany: async ({data}) => {calls.lines = data; return {}; }},
    filingPacket: {updateMany: async () => ({})}, localAgentJob: {updateMany: async () => ({})}, fbrConnection: {updateMany: async () => ({})},
    $transaction: async fn => {if(beforeTransaction)await beforeTransaction({draft,documents,entries});return fn(prisma);},
  };
  const load = moduleLoader({
    "next-auth/next": {getServerSession: async () => ({user: {email: "test@invalid.example"}})},
    "@/lib/auth": {authOptions: {}}, "@/lib/prisma": {prisma},
    "@/lib/tax/reconciliation-calculation": {validateAuthoritativeReconciliation: async () => ({success: true, preview: {}})},
    "@/app/actions/notifications": {createNotification: async () => {}},
  });
  const action = load("app/actions/tax-calculation.ts").calculateTaxAction;
  return {run: () => action(draft.id, "ATL"), calls, documents};
}

test("real Bank Profit action uses certificate gross and actual WHT, not net or stale credit",async()=>{
 const h=harness();for(let i=0;i<2;i++){const r=await h.run();assert.equal(r.success,true,r.error);assert.equal(r.result.status,"ESTIMATE",r.result.note);assert.equal(r.result.taxableIncome,1000000);assert.equal(r.result.taxWithheld,150000);assert.equal(h.calls.lines[0].taxBase,1000000);assert.ok(JSON.parse(h.calls.lines[0].detailsJson).bankProfitEvidenceFingerprint);}
});
function cert(values={},status="MAPPED"){return{id:"cert",extractionStatus:status,extractedData:JSON.stringify({fields:makeFields({...fixtureValues,...values})})};}
for(const [name,config]of[
 ["missing certificate",{certs:[]}],
 ["unapproved certificate",{certs:[cert({},"COMPLETED")]}],
 ["missing withholding",{certs:[cert({[L.taxDeducted]:null})]}],
 ["wrong taxpayer",{taxpayerCnic:"1234512345671"}],
 ["wrong section",{certs:[cert({[L.printedSectionSubsection]:"151(1)(d)"})]}],
 ["net mismatch",{net:800000}],
 ["separate tax debit",{taxDebit:150000}],
 ["combination",{sources:["bank_profit","salary"]}],
 ["multiple categories",{categories:["bank-or-financial-institution-deposit","other-profit-on-debt"]}],
 ["company route under Myself",{categories:["sukuk-company"]}],
])test(`real Bank Profit action refuses ${name}`,async()=>{const r=await harness(config).run();assert.equal(r.success,true,r.error);assert.equal(r.result.status,"NEEDS_USER_INPUT",r.result.note);assert.equal(r.result.taxPayable,null);assert.equal(r.result.breakdown.length,0);});
test("real Bank Profit action accepts explicit zero actual withholding",async()=>{const r=await harness({certs:[cert({[L.taxDeducted]:0,[L.netProfitCredited]:1000000,[L.withholdingRate]:0})],net:1000000}).run();assert.equal(r.success,true,r.error);assert.equal(r.result.status,"ESTIMATE",r.result.note);assert.equal(r.result.taxWithheld,0);});

test("real Bank Profit action prices two category-bound certificates separately without duplicating WHT",async()=>{
 const deposit={...cert(),id:"deposit",bankProfitSubcategory:"bank-or-financial-institution-deposit"};
 const other={...cert({[L.printedSectionSubsection]:"151(1)(d)",[L.instrumentCategory]:"Other profit on debt"}),id:"other",bankProfitSubcategory:"other-profit-on-debt"};
 const h=harness({categories:["other-profit-on-debt","bank-or-financial-institution-deposit"],certs:[deposit,other],net:1700000});
 const r=await h.run();assert.equal(r.success,true,r.error);assert.equal(r.result.status,"ESTIMATE",r.result.note);assert.equal(r.result.taxableIncome,2000000);assert.equal(r.result.taxWithheld,300000);
 assert.equal(h.calls.lines.length,2);assert.deepEqual(Array.from(h.calls.lines,line=>line.taxBase),[1000000,1000000]);
});
test("real Bank Profit action refuses certificate bound to a different selection",async()=>{
 const r=await harness({certs:[{...cert(),bankProfitSubcategory:"other-profit-on-debt"}]}).run();assert.equal(r.success,true,r.error);assert.equal(r.result.status,"NEEDS_USER_INPUT");
});
test("Bank Profit category slots normalize exact identities and isolate replacement predicates",()=>{
 const {resolveFilingDocumentSlot,buildFilingDocumentSlotWhere}=moduleLoader({})("lib/tax/document-upload-slot.ts");
 const a=resolveFilingDocumentSlot("bank_certificate:bank-or-financial-institution-deposit");assert.equal(a.success,true);assert.equal(a.documentType,"bank_certificate");assert.equal(a.bankProfitSubcategory,"bank-or-financial-institution-deposit");
 for(const value of ["bank_certificate:","bank_certificate:capital_gains","bank_certificate:not-real"])assert.equal(resolveFilingDocumentSlot(value).success,false);
 assert.equal(resolveFilingDocumentSlot("bank_certificate:other-profit-on-debt","account").success,false);
 const where=buildFilingDocumentSlotWhere("draft","owner","bank_certificate",null,null,"other-profit-on-debt");
 assert.equal(where.bankProfitSubcategory,"other-profit-on-debt");assert.equal(where.bankAccountId,null);assert.equal(where.userId,"owner");
 const rows=["bank-or-financial-institution-deposit","other-profit-on-debt",null].map((bankProfitSubcategory,id)=>({id,filingDraftId:"draft",userId:"owner",documentType:"bank_certificate",bankAccountId:null,dividendSubcategory:null,bankProfitSubcategory}));
 assert.deepEqual(rows.filter(row=>Object.entries(where).every(([key,value])=>row[key]===value)).map(row=>row.id),[1]);
});

test("real Bank Profit Map approves evidence atomically, invalidates downstream work and never creates ledger income",async()=>{
 const writes=[];const record=model=>async arg=>{writes.push({model,arg});return{};};
 const document={id:"bank-cert",userId:"owner",filingDraftId:"draft",documentType:"bank_certificate",bankProfitSubcategory:"bank-or-financial-institution-deposit",extractionStatus:"COMPLETED",extractedData:JSON.stringify({fields:makeFields()})};
 const tx={document:{update:record("document")},filingDraft:{update:record("draft")},filingPacket:{updateMany:record("packet")},fbrConnection:{updateMany:record("connection")},localAgentJob:{updateMany:record("job")}};
 const prisma={user:{findUnique:async()=>({id:"owner"})},document:{findFirst:async()=>document},filingDraft:{findFirst:async()=>({taxYear:2026})},$transaction:async fn=>fn(tx)};
 const load=moduleLoader({"@/lib/prisma":{prisma},"next-auth/next":{getServerSession:async()=>({user:{email:"test@example.invalid"}})},"@/lib/auth":{authOptions:{}},"next/cache":{revalidatePath:()=>{}},"@/app/actions/bank-parser":{},"@/app/actions/notifications":{createNotification:async()=>{}}});
 const action=load("app/actions/extraction.ts").approveAndMapExtractedDocumentAction;
 const r=await action(document.id);assert.equal(r.success,true,r.error);assert.equal(r.mapping,"BANK_PROFIT_CERTIFICATE");assert.equal(writes.length,5);
 assert.equal(writes.find(row=>row.model==="document").arg.data.extractionStatus,"MAPPED");assert.equal(writes.find(row=>row.model==="packet").arg.data.status,"SUPERSEDED");assert.equal(writes.find(row=>row.model==="job").arg.data.status,"cancelled");assert.equal(writes.find(row=>row.model==="draft").arg.data.packetApprovalConfirmed,false);
 writes.length=0;document.extractedData=JSON.stringify({fields:makeFields({...fixtureValues,[L.taxDeducted]:null})});const refused=await action(document.id);assert.equal(refused.success,false);assert.equal(writes.length,0);
});

test("Bank Profit completeness checks every selected category and requires MAPPED evidence",async()=>{
 const validate=moduleLoader({"@/lib/prisma":{prisma:{}}})("lib/tax/filing-completeness.ts").validateFilingCompleteness;
 const deposit={...cert(),documentType:"bank_certificate",bankProfitSubcategory:"bank-or-financial-institution-deposit",extractedData:JSON.stringify({fields:makeFields()}),bankAccountId:null};
 const categories=["bank-or-financial-institution-deposit","other-profit-on-debt"];
 const docs=[deposit];const db={filingDraft:{findFirst:async()=>({id:"draft",userId:"owner",taxYear:2026,filerType:"myself",incomeSources:'["bank_profit"]',incomeSelections:categories.map(subcategory=>({subcategory}))})},document:{findMany:async()=>docs},bankAccount:{findMany:async()=>[]},bankStatement:{findMany:async()=>[]},bankTransaction:{findMany:async()=>[]}};
 let r=await validate({draftId:"draft",userId:"owner"},db);assert.ok(r.blockers.some(message=>message.includes("other-profit-on-debt")));
 docs.push({...deposit,id:"other",bankProfitSubcategory:"other-profit-on-debt"});r=await validate({draftId:"draft",userId:"owner"},db);assert.equal(r.blockers.some(message=>message.includes("Bank Profit")),false);
 docs[1].extractionStatus="COMPLETED";r=await validate({draftId:"draft",userId:"owner"},db);assert.ok(r.blockers.some(message=>message.includes("approve/map the Bank Profit")));
});
test("multiple Sukuk certificates cannot evade aggregate annual-band review",async()=>{
 const values={[L.printedSectionSubsection]:"151(1A)",[L.instrumentCategory]:"Sukuk",[L.sukukHolderType]:"Individual",[L.sukukReturnBand]:"Below PKR 1M",[L.grossAnnualProfit]:800000,[L.taxDeducted]:80000,[L.netProfitCredited]:720000};
 const docs=["a","b"].map(id=>({...cert(values),id,bankProfitSubcategory:"sukuk-individual-aop-below-1m"}));
 const r=await harness({categories:["sukuk-individual-aop-below-1m"],certs:docs,net:1440000}).run();assert.equal(r.success,true,r.error);assert.equal(r.result.status,"NEEDS_USER_INPUT");assert.match(r.result.note,/aggregate annual-return band/);
});

test("real CG review-save clears approval stamps and atomically invalidates calculation, packets and active jobs",async()=>{
 const fields=Object.entries({"Capital Asset Type":"Listed shares sold through NCCPL","Asset Description / Scrip":"OGDC","Date of Acquisition":"2020-03-01","Date of Disposal":"2025-09-30","Cost of Acquisition (PKR)":"2000000","Sale / Transfer Value (PKR)":"2400000","Tax Deducted (PKR)":"50000","Exempt Gain (PKR)":"0","Evidence Reference":"page1-line1","Tax Year":2026,"Currency":"PKR","Taxpayer CNIC":"4210112345678"}).map(([label,value])=>({label,value}));
 const writes=[];const record=model=>async arg=>{writes.push({model,arg});return{};};
 const document={id:"cgt",userId:"owner",filingDraftId:"draft",documentType:"cgt_statement",extractionStatus:"MAPPED",extractedData:JSON.stringify({fields})};
 const tx={document:{update:record("document")},filingDraft:{update:record("draft")},filingPacket:{updateMany:record("packet")},fbrConnection:{updateMany:record("connection")},localAgentJob:{updateMany:record("job")}};
 const prisma={user:{findUnique:async()=>({id:"owner"})},document:{findFirst:async()=>document},filingDraft:{findFirst:async()=>({taxYear:2026})},$transaction:async fn=>fn(tx)};
 const load=moduleLoader({"@/lib/prisma":{prisma},"next-auth/next":{getServerSession:async()=>({user:{email:"test@example.invalid"}})},"@/lib/auth":{authOptions:{}},"next/cache":{revalidatePath:()=>{}},"@/app/actions/bank-parser":{},"@/app/actions/notifications":{createNotification:async()=>{}}});
 const action=load("app/actions/extraction.ts").updateDocumentExtractionAction;
 const result=await action(document.id,{fields,approvedCapitalGainsEvidence:{forged:true},approvedCapitalGainsStatement:{forged:true},approvedCapitalGainStatement:{forged:true}});
 assert.equal(result.success,true,result.error);assert.equal(writes.length,5);
 const saved=writes.find(row=>row.model==="document").arg.data;assert.equal(saved.extractionStatus,"COMPLETED");const payload=JSON.parse(saved.extractedData);for(const key of ["approvedCapitalGainsEvidence","approvedCapitalGainsStatement","approvedCapitalGainStatement"])assert.equal(payload[key],null);
 assert.equal(writes.find(row=>row.model==="draft").arg.data.taxCalculationRevision,null);assert.equal(writes.find(row=>row.model==="packet").arg.data.status,"SUPERSEDED");assert.equal(writes.find(row=>row.model==="job").arg.data.status,"cancelled");
 writes.length=0;const invalid=await action(document.id,{fields:fields.filter(field=>field.label!=="Tax Deducted (PKR)")});assert.equal(invalid.success,false);assert.equal(writes.length,0);
});

function cgMapHarness({changed=false,cnicMismatch=false,mixed=false,conditionalConflict=false,missingWht=false}={}){
 const fields=Object.entries({"Capital Asset Type":"Listed shares sold through NCCPL","Asset Description / Scrip":"OGDC","Date of Acquisition":"2020-03-01","Date of Disposal":"2025-09-30","Cost of Acquisition (PKR)":"2000000","Sale / Transfer Value (PKR)":"2400000","Tax Deducted (PKR)":"50000","Exempt Gain (PKR)":"0","Evidence Reference":"page1-line1","Tax Year":2026,"Currency":"PKR","Taxpayer CNIC":"4210112345678"}).filter(([label])=>!missingWht||label!=="Tax Deducted (PKR)").map(([label,value])=>({label,value}));
 const writes=[];const record=model=>async arg=>{writes.push({model,arg});return{};};
 const document={id:"cgt",userId:"owner",filingDraftId:"draft",documentType:"cgt_statement",extractionStatus:"COMPLETED",extractedData:JSON.stringify({fields})};
 const tx={document:{findFirst:async({where})=>{assert.equal(where.userId,"owner");assert.equal(where.filingDraftId,"draft");return{...document,...(changed?{extractedData:"{}"}:{})};},updateMany:async arg=>{assert.equal(arg.where.extractedData,document.extractedData);if(!conditionalConflict)writes.push({model:"document",arg});return{count:conditionalConflict?0:1};}},user:{findUnique:async()=>({cnic:cnicMismatch?"4210112345679":"4210112345678"})},filingDraft:{findFirst:async({where})=>{assert.equal(where.userId,"owner");return{taxYear:2026,filerType:"myself",incomeSources:JSON.stringify(mixed?["capital_gains","salary"]:["capital_gains"])};},update:record("draft")},filingPacket:{updateMany:record("packet")},fbrConnection:{updateMany:record("connection")},localAgentJob:{updateMany:record("job")}};
 const prisma={user:{findUnique:async()=>({id:"owner"})},document:{findFirst:async()=>document},$transaction:async fn=>fn(tx)};
 const load=moduleLoader({"@/lib/prisma":{prisma},"next-auth/next":{getServerSession:async()=>({user:{email:"test@example.invalid"}})},"@/lib/auth":{authOptions:{}},"next/cache":{revalidatePath:()=>{}},"@/app/actions/bank-parser":{},"@/app/actions/notifications":{createNotification:async()=>{}}});
 return {writes,run:()=>load("app/actions/extraction.ts").approveAndMapExtractedDocumentAction(document.id)};
}
test("real CG Map persists rebuilt owner-bound evidence without creating ledger income or tax payment",async()=>{const h=cgMapHarness(),out=await h.run();assert.equal(out.success,true,out.error);assert.equal(out.mapping,"CAPITAL_GAINS_EVIDENCE");assert.equal(h.writes.length,5);const update=h.writes.find(w=>w.model==="document").arg;assert.equal(update.data.extractionStatus,"MAPPED");const evidence=JSON.parse(update.data.extractedData).approvedCapitalGainsEvidence;assert.equal(evidence.userId,"owner");assert.equal(evidence.documentId,"cgt");assert.equal(evidence.actualWithholdingPaisa,5000000);assert.equal(h.writes.find(w=>w.model==="job").arg.data.status,"cancelled");});
for(const config of [{changed:true},{cnicMismatch:true},{mixed:true},{conditionalConflict:true},{missingWht:true}])test(`real CG Map refuses unsafe evidence ${JSON.stringify(config)}`,async()=>{const h=cgMapHarness(config),out=await h.run();assert.equal(out.success,false);assert.equal(h.writes.length,0);});

test("real CG calculator refuses missing approved evidence instead of a legacy ledger-based estimate",async()=>{const h=harness({sources:["capital_gains"],categories:[],net:0}),out=await h.run();assert.equal(out.success,true,out.error);assert.equal(out.result.status,"NEEDS_USER_INPUT");assert.equal(out.result.taxPayable,null);assert.equal(h.calls.lines.length,0);});
test("CG production packet gate cannot be bypassed by coverage override",()=>{const source=fs.readFileSync(path.join(root,"app/actions/packet.ts"),"utf8");const guard=source.indexOf('if (parsedIncomeSources.includes("capital_gains"))');assert.ok(guard>0);const block=source.slice(guard,source.indexOf('    // Bank Profit desktop safety gate',guard));assert.ok(block.includes('success:false'));assert.ok(!block.includes('acceptUnmappedPortalSources'));assert.ok(guard<source.indexOf('    const snapshot = {',guard));});

function mappedCgStatement({wht="50000",asset="TFC debt security",currency="PKR"}={}){
 const fields=Object.entries({"Capital Asset Type":asset,"Asset Description / Scrip":asset,"Date of Acquisition":"2020-03-01","Date of Disposal":"2025-09-30","Cost of Acquisition (PKR)":"2000000","Sale / Transfer Value (PKR)":"2400000","Tax Deducted (PKR)":wht,"Exempt Gain (PKR)":"0","Evidence Reference":"page1-line1","Tax Year":2026,"Currency":currency,"Taxpayer CNIC":"4210112345678"}).map(([label,value])=>({label,value}));
 const built=moduleLoader({})("lib/tax/capital-gains-approved-evidence.ts").buildCapitalGainsApprovedEvidence({userId:"user",filingDraftId:"dividend-draft",documentId:"cgt",taxpayerCnic:"4210112345678",taxYear:2026,filerType:"myself",fields});assert.equal(built.ok,true,built.reason);
 return{id:"cgt",extractionStatus:"MAPPED",extractedData:JSON.stringify({fields,approvedCapitalGainsEvidence:built.evidence})};
}
test("real CG action uses approved debt gain and actual WHT once, ignoring stale stored tax credit",async()=>{
 const h=harness({sources:["capital_gains"],categories:["certain-debt-securities"],net:0,certs:[mappedCgStatement()],stored:999999});
 for(let i=0;i<2;i++){const out=await h.run();assert.equal(out.success,true,out.error);assert.equal(out.result.status,"ESTIMATE",out.result.note);assert.equal(out.result.taxableIncome,400000);assert.equal(out.result.taxWithheld,50000);assert.equal(out.result.taxDue,60000);assert.equal(out.result.taxPayable,10000);assert.equal(h.calls.lines.length,1);assert.equal(h.calls.lines[0].source,"capital_gains");assert.ok(JSON.parse(h.calls.lines[0].detailsJson).capitalGainsEvidenceFingerprint);}
});
for(const [name,change]of [["unmapped",doc=>doc.extractionStatus="COMPLETED"],["edited fields",doc=>{const payload=JSON.parse(doc.extractedData);payload.fields.find(f=>f.label==="Sale / Transfer Value (PKR)").value="2500000";doc.extractedData=JSON.stringify(payload);}],["forged stored gain",doc=>{const payload=JSON.parse(doc.extractedData);payload.approvedCapitalGainsEvidence.plan.incomeSources[0].income=1;doc.extractedData=JSON.stringify(payload);}]])test(`real CG action refuses ${name}`,async()=>{const doc=mappedCgStatement();change(doc);const h=harness({sources:["capital_gains"],categories:["certain-debt-securities"],net:0,certs:[doc]}),out=await h.run();assert.equal(out.success,true,out.error);assert.equal(out.result.status,"NEEDS_USER_INPUT");assert.equal(out.result.taxPayable,null);assert.equal(h.calls.lines.length,0);});
for(const [name,config]of [["duplicate statement",{certs:[mappedCgStatement(),mappedCgStatement()]}],["unlinked tax debit",{taxDebit:50000}],["separate income",{net:400000}],["wrong taxpayer",{taxpayerCnic:"4210112345679"}],["mixed filing",{sources:["capital_gains","salary"]}],["non-debt donor plan",{certs:[mappedCgStatement({asset:"Listed shares sold through NCCPL"})]}]])test(`real CG calculation blocks ${name} without falling back to debt default`,async()=>{const h=harness({sources:["capital_gains"],categories:["certain-debt-securities"],net:0,certs:[mappedCgStatement()],...config}),out=await h.run();assert.equal(out.success,true,out.error);assert.equal(out.result.status,"NEEDS_USER_INPUT",out.result.note);assert.equal(out.result.taxPayable,null);});
test("real CG action accepts explicit zero actual WHT",async()=>{const h=harness({sources:["capital_gains"],categories:["certain-debt-securities"],net:0,certs:[mappedCgStatement({wht:"0"})]}),out=await h.run();assert.equal(out.result.status,"ESTIMATE",out.result.note);assert.equal(out.result.taxWithheld,0);assert.equal(out.result.taxPayable,60000);});
for(const [name,edit]of [["document approval",({documents})=>documents[0].extractionStatus="COMPLETED"],["document removal",({documents})=>documents.length=0],["source selection",({draft})=>draft.incomeSources='["capital_gains","salary"]'],["separate tax debit",({entries})=>entries.push({entryType:"EXPENSE",category:"TAX_PAYMENT",amount:50000})]])test(`CG transaction reread refuses ${name} drift before persisting an estimate`,async()=>{const h=harness({sources:["capital_gains"],categories:["certain-debt-securities"],net:0,certs:[mappedCgStatement()],beforeTransaction:edit}),out=await h.run();assert.equal(out.success,false);assert.equal(h.calls.lines.length,0);assert.equal(out.error,"Failed to calculate tax");});

function cgCompletenessHarness(){
 const documents=[{...mappedCgStatement(),documentType:"cgt_statement",bankAccountId:null}];
 const draft={id:"dividend-draft",userId:"user",taxYear:2026,filerType:"myself",incomeSources:'["capital_gains"]',incomeSelections:[{source:"capital_gains",subcategory:"certain-debt-securities"}]};
 const profile={cnic:"4210112345678"};
 const db={filingDraft:{findFirst:async()=>draft},document:{findMany:async()=>documents},user:{findUnique:async()=>profile},bankAccount:{findMany:async()=>[]},bankStatement:{findMany:async()=>[]},bankTransaction:{findMany:async()=>[]}};
 const validate=moduleLoader({"@/lib/prisma":{prisma:{}}})("lib/tax/filing-completeness.ts").validateFilingCompleteness;
 return {documents,draft,profile,run:()=>validate({draftId:draft.id,userId:draft.userId},db)};
}
test("real completeness accepts current bound CG evidence independently of unrelated required slots",async()=>{const h=cgCompletenessHarness(),out=await h.run();assert.equal(out.blockers.some(message=>message.startsWith("Capital Gains:")),false,JSON.stringify(out.blockers));});
for(const [name,edit]of [["missing statement",h=>h.documents.length=0],["duplicate statement",h=>h.documents.push({...h.documents[0]})],["not mapped",h=>h.documents[0].extractionStatus="COMPLETED"],["changed profile CNIC",h=>h.profile.cnic="4210112345679"],["missing profile CNIC",h=>h.profile.cnic=null],["wrong selection",h=>h.draft.incomeSelections[0].subcategory="other"],["mixed sources",h=>h.draft.incomeSources='["capital_gains","salary"]'],["stale approval",h=>{const p=JSON.parse(h.documents[0].extractedData);p.fields.find(f=>f.label==="Tax Deducted (PKR)").value="0";h.documents[0].extractedData=JSON.stringify(p);}]])test(`real completeness blocks CG ${name}`,async()=>{const h=cgCompletenessHarness();edit(h);const out=await h.run();assert.equal(out.success,false);assert.ok(out.blockers.some(message=>message.startsWith("Capital Gains:")),JSON.stringify(out.blockers));});
test("CG extraction instruction is slot-specific, itemised and never requests derived tax or approval",()=>{const {capitalGainsExtractionInstruction}=moduleLoader({})("lib/tax/capital-gains-extraction-prompt.ts");assert.equal(capitalGainsExtractionInstruction("bank_statement"),"");const prompt=capitalGainsExtractionInstruction("cgt_statement");for(const phrase of ["Taxpayer CNIC","Cost of Acquisition (PKR)","Tax Deducted (PKR)","SAME numeric suffix","never turn absent","Never derive withholding","do not treat sale proceeds as gain"])assert.ok(prompt.includes(phrase),phrase);assert.ok(fs.readFileSync(path.join(root,"app/actions/extraction.ts"),"utf8").includes('${capitalGainsExtractionInstruction(documentType)}'));});

for(const source of ["bank_profit","dividend"])test(`real Previous Return edit invalidates active ${source} filing in one transaction`,async()=>{
 const fields=Object.entries({"Taxpayer Name":"Test Owner","Registration No":"4210112345678","Tax Year":2025,"Total Assets (7019)":2000000,"Total Liabilities (7029)":500000,"Net Assets (703001)":1500000}).map(([label,value])=>({label,value}));
 const writes=[];const record=model=>async arg=>{writes.push({model,arg});return{};};
 const document={id:"previous",userId:"owner",filingDraftId:"draft",documentType:"previous_return",extractionStatus:"MAPPED",extractedData:JSON.stringify({fields})};
 const tx={document:{update:record("document")},filingDraft:{update:record("draft")},filingPacket:{updateMany:record("packet")},fbrConnection:{updateMany:record("connection")},localAgentJob:{updateMany:record("job")}};
 const prisma={user:{findUnique:async()=>({id:"owner"})},document:{findFirst:async()=>document},filingDraft:{findFirst:async()=>({taxYear:2026,incomeSources:JSON.stringify([source])})},$transaction:async fn=>fn(tx)};
 const load=moduleLoader({"@/lib/prisma":{prisma},"next-auth/next":{getServerSession:async()=>({user:{email:"test@example.invalid"}})},"@/lib/auth":{authOptions:{}},"next/cache":{revalidatePath:()=>{}},"@/app/actions/bank-parser":{},"@/app/actions/notifications":{createNotification:async()=>{}}});
 const out=await load("app/actions/extraction.ts").updateDocumentExtractionAction(document.id,{fields});assert.equal(out.success,true,out.error);assert.equal(writes.length,5);assert.equal(writes.find(w=>w.model==="document").arg.data.extractionStatus,"COMPLETED");assert.equal(writes.find(w=>w.model==="packet").arg.data.status,"SUPERSEDED");assert.equal(writes.find(w=>w.model==="job").arg.data.status,"cancelled");
});
