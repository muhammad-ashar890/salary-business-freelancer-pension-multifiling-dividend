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
function moduleLoader(mocks, bypassDividendGateForTest = false) {
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
    const compileKey = `${file}:${bypassDividendGateForTest}`;
    if (!compiled.has(compileKey)) {
      compiled.set(
        compileKey,
        ts.transpileModule((() => {
          const source = fs.readFileSync(file, "utf8");
          if (!bypassDividendGateForTest || file !== path.join(root, "app/actions/packet.ts")) return source;
          // TEST ONLY: reach snapshot/transaction checks without enabling production.
          const start = source.indexOf("    // Selective-merge safety gate:");
          const end = source.indexOf("    const snapshot = {\n      generatedAt:", start);
          assert.ok(start >= 0 && end > start, "expected production Dividend gate");
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




function fixture(){
 const documents=[{id:"cert",dividendSubcategory:"reit-and-other",extractionStatus:"MAPPED",extractedData:JSON.stringify({fields:[{label:"Gross Dividend PKR",value:100000},{label:"Withholding Tax u/s 150",value:15000}]})}];
 const selections=[{subcategory:"reit-and-other"}];const ledger=[{entryType:"INCOME",category:"DIVIDEND",amount:85000}];
 const proof=moduleLoader({})("lib/tax/dividend-packet-evidence.ts").buildDividendPacketEvidence({documents,selectedSubcategories:["reit-and-other"],ledgerEntries:ledger});assert.equal(proof.ok,true);
 const draft={taxYear:2026,filerType:"myself",incomeSources:'["dividend"]',taxCalculationRevision:"r1",packetApprovalConfirmed:true};
 const snapshot={filing:{...draft,incomeSources:["dividend"]},otherSources:{taxDeductions:{version:"dividend-final-tax-v1",evidenceFingerprint:proof.evidenceFingerprint,agentFields:proof.agentFields,wealth:proof.wealth}},portalFieldMap:{wealthFields:[{irisCode:"7098",ourAmount:15000,rowDescriptionIncludes:"Income tax deducted u/s 150"}]}};
 const lines=[{source:"dividend",taxBase:100000,detailsJson:JSON.stringify({dividendEvidenceFingerprint:proof.evidenceFingerprint})}];
 const previousDocuments=[];const profile={cnic:"4210112345678"};
 const queries=[];const findMany=value=>async args=>{queries.push(args);return value;};
 const prisma={filingDraft:{findFirst:async()=>draft},user:{findUnique:async()=>profile},document:{findMany:async args=>{queries.push(args);return args.where.documentType === "previous_return" ? previousDocuments : documents;}},filingIncomeSelection:{findMany:findMany(selections)},ledgerEntry:{findMany:findMany(ledger)},filingTaxCalculationLine:{findMany:findMany(lines)}};
 const validate=()=>moduleLoader({"@/lib/prisma":{prisma}})("lib/tax/dividend-packet-validation.ts").dividendPacketValidationError(snapshot,"draft","owner");
 return{documents,previousDocuments,profile,selections,ledger,draft,snapshot,lines,queries,validate};
}
test("current Dividend handoff rechecks real evidence with owner-scoped queries",async()=>{const f=fixture();assert.equal(await f.validate(),null);assert.equal(f.queries.length,5);for(const query of f.queries){assert.equal(query.where.userId,"owner");assert.equal(query.where.filingDraftId,"draft");}});
for(const [name,mutate]of[
 ["certificate edited",f=>f.documents[0].extractedData="{}"],
 ["certificate unapproved",f=>f.documents[0].extractionStatus="COMPLETED"],
 ["selection changed",f=>f.selections[0].subcategory="ipp"],
 ["ledger changed",f=>f.ledger[0].amount=84000],
 ["revision changed",f=>f.draft.taxCalculationRevision="r2"],
 ["approval revoked",f=>f.draft.packetApprovalConfirmed=false],
 ["source changed",f=>f.draft.incomeSources='["salary"]'],
 ["envelope missing",f=>delete f.snapshot.otherSources],
 ["cell tampered",f=>f.snapshot.otherSources.taxDeductions.agentFields[0].values[0].value="99999"],
 ["wealth tampered",f=>f.snapshot.otherSources.taxDeductions.wealth.netBankCredits=90000],
 ["calculation stale",f=>f.lines[0].detailsJson="{}"],
 ["invalid calculation base",f=>f.lines[0].taxBase="not-a-number"],
 ["outflow duplicated",f=>f.snapshot.portalFieldMap.wealthFields.push({...f.snapshot.portalFieldMap.wealthFields[0]})]
])test(`current Dividend handoff refuses ${name}`,async()=>{const f=fixture();mutate(f);assert.equal(typeof await f.validate(),"string");});
test("unrelated source remains outside Dividend validator",async()=>{const f=fixture();f.draft.incomeSources='["salary"]';f.snapshot.filing.incomeSources=["salary"];delete f.snapshot.otherSources;assert.equal(await f.validate(),null);assert.equal(f.queries.length,0);});
test("fractional executable rows fail closed rather than drifting through rounding",()=>{const load=moduleLoader({});const doc={id:"cert",dividendSubcategory:"reit-and-other",extractionStatus:"MAPPED",extractedData:JSON.stringify({fields:[{label:"Gross Dividend PKR",value:100000.5},{label:"Withholding Tax u/s 150",value:15000}]})};const result=load("lib/tax/dividend-packet-evidence.ts").buildDividendPacketEvidence({documents:[doc],selectedSubcategories:["reit-and-other"],ledgerEntries:[{entryType:"INCOME",category:"DIVIDEND",amount:85000.5}]});assert.equal(result.ok,false);assert.match(result.reason,/whole-rupee/);});

function previousDocument(){return {documentType:"previous_return",extractionStatus:"MAPPED",extractedData:JSON.stringify({fields:Object.entries({"Taxpayer Name":"Test Owner","Registration No":"4210112345678","Tax Year":2025,"Total Assets (7019)":2000000,"Total Liabilities (7029)":500000,"Net Assets (703001)":1500000}).map(([label,value])=>({label,value}))})};}
function attachPrevious(f){f.previousDocuments.push(previousDocument());f.snapshot.wealthExpectations={previousYearNetAssets:{irisCode:"703002",expected:1500000,previousReturnTaxYear:2025,source:"approved_previous_return_703001"}};}
test("Dividend current packet preserves approved opening Wealth without adding it to dividend gross/WHT",async()=>{const f=fixture();attachPrevious(f);assert.equal(await f.validate(),null);assert.equal(f.snapshot.otherSources.taxDeductions.wealth.finalTaxIncome.expected,100000);});
for(const [name,edit]of [["edited close",f=>{const p=JSON.parse(f.previousDocuments[0].extractedData);p.fields.find(v=>v.label==="Net Assets (703001)").value=1400000;f.previousDocuments[0].extractedData=JSON.stringify(p);}],["removed document",f=>f.previousDocuments.length=0],["revoked Map",f=>f.previousDocuments[0].extractionStatus="COMPLETED"],["wrong profile",f=>f.profile.cnic="4210112345679"],["duplicate previous return",f=>f.previousDocuments.push(previousDocument())],["stripped expectation",f=>delete f.snapshot.wealthExpectations]])test(`Dividend fresh validation refuses Previous Return ${name}`,async()=>{const f=fixture();attachPrevious(f);edit(f);assert.notEqual(await f.validate(),null);});
