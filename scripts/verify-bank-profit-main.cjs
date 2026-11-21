// Execute the actual Electron main orchestration extracted from its AST.
// Portal, navigation, persistence and Save boundaries are synthetic doubles.
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

const navigation=require("../electron-connect/iris-navigation");
const census=require("../electron-connect/iris-tour-census");
const mainSource=fs.readFileSync(path.join(root,"electron-connect/main.js"),"utf8");
const ast=ts.createSourceFile("main.js",mainSource,ts.ScriptTarget.Latest,true,ts.ScriptKind.JS);
function functionSource(name) {
  const found = ast.statements.find(
    (node) => ts.isFunctionDeclaration(node) && node.name?.text === name,
  );
  assert.ok(found, `Function ${name} exists`);
  return found.getText(ast);
}
function sandbox(names, extras = {}) {
  // The exact Services-only / Salary+Services / Pension+Services gate is shared by navigation and
  // real autofill entry point; extracted-function sandboxes need the shipped
  // helper itself, never a test-local copy of the route policy.
  if (
    (names.includes("runLocalIrisNavigationCheck") ||
      names.includes("runRealIrisAutofill")) &&
    !names.includes("getServicesPacketRoute")
  ) {
    names = [...names, "getServicesPacketRoute", "getServicesAutofillFields", "getSalaryFieldsForServicesRoute", "resolveAutofillComputationsPlan"];
  }
  // Both real-portal flows now read the effective autofill mode through one
  // resolver, so any test that exercises `getRealAutofillMode` must be given the
  // resolver too — otherwise the sandbox throws on a symbol the shipped code
  // defines at module scope.
  const autofillFlows = ["runLocalTaxAssistedFilingFlow", "runLocalTaxDryRunFlow"];
  if (
    autofillFlows.some((flow) => names.includes(flow)) &&
    !names.includes("resolveAutofillMode")
  ) {
    names = [...names, "resolveAutofillMode"];
  }
  // The flows merge autofill output into the navigation result through this
  // module-scope helper; the sandbox must be given it too.
  if (
    autofillFlows.some((flow) => names.includes(flow)) &&
    !names.includes("mergeNavigationAutofillOutcome")
  ) {
    names = [
      ...names,
      "mergeNavigationAutofillOutcome",
      "markAutofillOff",
      "buildHandoffScopeSummary",
      "hasConfirmedHandoffReview",
      "getHandoffReviewAction",
      "readSavedJobLog",
      "buildConfirmedHandoffCompletion",
      "getAutofillReviewAction",
      "hasConfirmedAutofillReview",
      "collectAcknowledgedAutofillItems",
      "autofillItemKey",
    ];
  }
  // runRealIrisAutofill decides whether the taxpayer review pause is due through
  // these module-scope helpers, so every sandbox that runs it needs them too.
  if (
    names.includes("runRealIrisAutofill") &&
    !names.includes("hasConfirmedHandoffReview")
  ) {
    names = [
      ...names,
      "getHandoffReviewAction",
      "hasConfirmedHandoffReview",
      "getEmployerReviewAction",
      "hasConfirmedEmployerReview",
      "runHandoffReviewTour",
      "buildHandoffReviewMessage",
      "autofillItemKey",
      "checkTakenOverEntry",
    ];
  }
  // The autofill and local-navigation functions read these module-scope
  // dependencies from main.js; extracted-function sandboxes must provide them.
  const needsAutofillGlobals =
    names.includes("runRealIrisAutofill") ||
    names.includes("runLocalIrisNavigationCheck");
  if (needsAutofillGlobals) {
    if (!("pensionEntryHold" in extras)) {
      extras = {
        ...extras,
        pensionEntryHold: require("../electron-connect/pension-guard").pensionEntryHold,
      };
    }
    if (!("TAX_DEDUCTION_GRID_BY_CODE" in extras)) {
      extras = {
        ...extras,
        TAX_DEDUCTION_GRID_BY_CODE: Object.freeze({
          "64020004": "Adjustable Tax",
          "64020007": "Final Tax",
        }),
      };
    }
  }
  // ...and the employer step: the shipped driver is pure for an empty employer
  // list, so it is given as is; the opt-in switch needs a `process` to read.
  const runsAutofill = names.includes("runRealIrisAutofill");
  if (runsAutofill && extras.irisRowFiller && typeof extras.irisRowFiller.packetPromisedIrisCodes !== "function") {
    // Older/handwritten filler stubs do not know about this optional packet
    // coverage helper. Keep those tests focused on their declared behavior.
    extras = {
      ...extras,
      irisRowFiller: { ...extras.irisRowFiller, packetPromisedIrisCodes: () => [] },
    };
  }
  if (
    runsAutofill &&
    !names.includes("getEmployerAutofillEnabled") &&
    !("getEmployerAutofillEnabled" in extras)
  ) {
    names = [...names, "getEmployerAutofillEnabled"];
  }
  const ctx = vm.createContext({
    AGENT_NAME: require("../electron-connect/branding.js").AGENT_NAME,
    brandWindow: require("../electron-connect/branding.js").brandWindow,
    console,
    Promise,
    Date,
    setTimeout,
    clearTimeout,
    ...(runsAutofill
      ? {
          irisEmployerDriver: require("../electron-connect/iris-employer-driver.js"),
          wealthReconciliation: require("../electron-connect/wealth-reconciliation-check.js"),
          // The Cash in hand baseline lives in the agent log folder; a test
          // run gets a throw-away one and may override any of these.
          cashBaselineStore: require("../electron-connect/cash-baseline-store.js"),
          getAgentLogDir: () =>
            require("node:fs").mkdtempSync(
              require("node:path").join(require("node:os").tmpdir(), "agent-logs-"),
            ),
          fs: require("node:fs"),
          path: require("node:path"),
          process: { env: {} },
        }
      : {}),
    ...extras,
  });
  for (const name of names) {
    // An explicit stand-in in `extras` is never replaced by the shipped function.
    if (name in extras) continue;
    vm.runInContext(functionSource(name), ctx);
  }
  return ctx;
}

function handoffReviewCtx(visited, fillStatus = "filled", extras = {}) {
  const tour = {
    complete: true,
    sections: [
      {
        id: "salary",
        rows: [{ code: "1009" }],
        mappingVerified: true,
        status: "captured",
        transition: "structure_changed",
      },
    ],
  };
  return sandbox(["runRealIrisAutofill"], {
    ensureWorkerWindow: async () => ({
      isDestroyed: () => false,
      webContents: {
        executeJavaScript: async () => ({ returnWorkspace: true, inputs: 12 }),
      },
    }),
    launchState: { accountReference: "1234567890123" },
    activeJobExecutionLog: null,
    pushStatus: () => {},
    captureWindowScreenshot: async () => null,
    lastSectionTour: tour,
    irisNavigation: {
      ...navigation,
      waitForBusinessSectionReady: async () => ({ ok: true, status: "business_section_ready" }),
      navigateToSection: async (_win, { sectionId }) => {
        visited.push(sectionId);
        return { ok: true, status: "switched" };
      },
    },
    irisRowFiller: {
      FILL_STATUS: {
        FILLED: "filled",
        ROW_NOT_FOUND: "row_not_found",
        OVERWRITE_NEEDS_CONFIRMATION: "overwrite_needs_confirmation",
        ALREADY_CORRECT: "already_correct",
      },
      summarise: (results) => ({
        total: results.length,
        filled: results.filter((r) => ["filled", "already_correct"].includes(r.status)).length,
        skipped: results.filter((r) => !["filled", "already_correct"].includes(r.status)).length,
      }),
      describeFillSummary: () => "summary",
      SUCCESS_STATUSES: new Set(["filled", "already_correct"]),
      snapshotIrisRows: async () => [],
      findUnexpectedPrefill: () => [],
      fillIrisRows: async (_win, fields) => {
        visited.push("fill_rows");
        return {
          results: fields.map((f) => ({ ...f, status: fillStatus })),
          summary: {},
        };
      },
    },
    ...extras,
  });
}


function mainHarness({bankOk=true,postSaveDrift=false,wealthGap=false,saveThrows=false,saveNotClicked=false,dialogOpen=false,identityBeforeSave=false,cancelBeforeSave=false,previousOpening=null,previousActual="1500000",previousAfterSave=null,existingOtherSourcesRows=null}={}){
 const visited=[];let saves=0,bankReads=0;const s=snapshot();
 if(previousOpening!==null)s.wealthExpectations={previousYearNetAssets:{irisCode:"703002",expected:previousOpening,previousReturnTaxYear:2025,source:"approved_previous_return_703001"}};
 const wealth={irisCode:"7098",value:"150000",sourceGroup:"wealthFields",rowDescriptionIncludes:"Income tax deducted u/s 151",label:"Income tax deducted u/s151"};
 s.portalFieldMapDetailed=s.portalFieldMap;s.portalFieldMap=[wealth];
 const rows=s.otherSources.bankProfit.rows;
 const bankResults=rows.flatMap(row=>row.values.map(cell=>({key:`bank_profit:${row.documentId}:${row.irisCode}:${cell.columnIndex}`,irisCode:row.irisCode,bankProfitDocumentId:row.documentId,columnIndex:cell.columnIndex,sourceGroup:"bankProfitFields",status:bankOk?"filled":"unverified_target",plannedValue:cell.value,readback:cell.value})));
 const tour={complete:true,views:[{key:"116 - Wealth Statement > Reconciliation of Net Assets",rows:[{code:"7033",cells:[{value:"1000000"}]},{code:"703000",cells:[{value:wealthGap?"1":"0"}]}]}],totals:{7033:"1000000",703000:wealthGap?"1":"0"}};
 if(previousOpening!==null&&previousActual!==null)tour.views[0].rows.push({code:"703002",cells:[{value:previousActual}]});
 const ctx=handoffReviewCtx(visited,"filled",{
  // The new read-only Bank Profit preflight dependency (same role as
  // irisDividendExistingIncome for the Dividend route).
  irisBankProfitExistingIncome:require("../electron-connect/iris-bank-profit-existing-income"),
  irisBankProfitEntry:{...entry,fillBankProfitEntries:async(_w,route,options)=>{visited.push("bank_fill");await options.beforeStep();assert.equal((await options.verifyDocument()).ok,true);return{ok:bankOk,reason:bankOk?null:"held",results:bankResults};},readBankProfitEntries:async()=>{bankReads++;const checks=rows.flatMap(row=>row.values.map(cell=>({key:`bank_profit:${row.documentId}:${row.irisCode}:${cell.columnIndex}`,irisCode:row.irisCode,documentId:row.documentId,columnIndex:cell.columnIndex,status:postSaveDrift&&saves>0?"mismatch":"match",expected:cell.value,afterTabValue:cell.value})));return{complete:!(postSaveDrift&&saves>0),checks};}},
  irisNavigation:{...navigation,navigateToSection:async(_w,{sectionId})=>{visited.push(sectionId);return{ok:true};},probeFrames:async()=>({frames:[{document:{present:true,taxYear:2026,originalFullYear:true,identityStatus:identityBeforeSave&&bankReads>0?"mismatch":"match"}}]})},
  buildFbrHandoffRoute:require("../electron-connect/fbr-handoff-route").buildFbrHandoffRoute,
  irisTourCensus:{...census,runCensusTour:async(_w,options)=>{
   // The Bank Profit existing-income preflight reads the Other Sources grid
   // BEFORE anything is typed; the Wealth checks still only read 116.
   const otherSources=options.onlyViews.every(view=>view==="Other Sources > Tax Deductions");
   assert.ok(otherSources||options.onlyViews.every(view=>view.startsWith("116 - Wealth Statement")));
   visited.push(options.label);
   if(otherSources){
     // Empty grid by default: nothing is already saved, so the packet matches.
     return {complete:true,views:[{key:"Other Sources > Tax Deductions",ok:true,dialogsOpen:false,rows:existingOtherSourcesRows||[]}]};
   }
   if(saves>0&&previousAfterSave!==null){const copy=JSON.parse(JSON.stringify(tour));copy.views[0].rows.find(row=>row.code==="703002").cells[0].value=previousAfterSave;return copy;}return tour;},collectTotals:t=>t?.totals||{},compareTypedEntries:(_t,entries)=>entries.filter(row=>row.sourceGroup!=="bankProfitFields").map(row=>({key:row.key||`${row.irisCode}|${row.rowDescriptionIncludes||""}`,irisCode:row.irisCode,status:"match"})),saveCensusReport:()=>null},
  irisSaveDraft:{saveReturnDraft:async()=>{saves++;visited.push("save");if(saveThrows)throw new Error("synthetic_save_failure");return{clicked:!saveNotClicked,status:saveNotClicked?"not_clicked":"saved_confirmed",...(dialogOpen?{dialog:{closed:false}}:{})};},describeSaveOutcome:()=>"saved"},
  getCensusTourEnabled:()=>false,getWealthAutofillEnabled:()=>true,ensureNavigationJobActive:async()=>{if(cancelBeforeSave&&bankReads>0)throw new Error("synthetic_job_cancelled");},
  irisWealthDriver:{runWealthDriverStepwise:async(_w,fields)=>({results:fields.map(row=>({...row,status:"filled"})),setup:[],stopped:false})},
 });
 return {ctx,visited,run:()=>ctx.runRealIrisAutofill({filingPacket:{taxYear:2026,snapshot:s}},{id:"job",type:"tax_assisted_filing"},"live"),stats:()=>({saves,bankReads})};
}
test("real main dispatch merges Bank cells and Wealth, scopes census and Saves once only after exact readback",async()=>{
 const h=mainHarness();const out=await h.run();assert.equal(out.paused,false,out.pauseMessage);assert.equal(out.result.routeScope.id,"bank_profit");assert.equal(out.result.summary.total,3);assert.equal(out.result.summary.filled,3);assert.equal(h.stats().saves,1);assert.equal(h.stats().bankReads,2);assert.equal(out.result.bankProfit.completion.ok,true);assert.equal(h.visited.includes("salary"),false);assert.equal(h.visited.includes("business_tax_deduction"),false);
});
for(const config of [{bankOk:false},{wealthGap:true},{postSaveDrift:true}])test(`real main Bank dispatch blocks unsafe completion ${JSON.stringify(config)}`,async()=>{const h=mainHarness(config);const out=await h.run();assert.equal(out.paused,true);assert.equal(out.result.reviewRequired,true);assert.equal(h.stats().saves,config.postSaveDrift?1:0);});

for(const config of [{saveThrows:true},{saveNotClicked:true},{dialogOpen:true},{identityBeforeSave:true},{cancelBeforeSave:true}])test(`real main refuses completion on Save boundary failure ${JSON.stringify(config)}`,async()=>{
 const h=mainHarness(config),out=await h.run();assert.equal(out.paused,true);assert.equal(out.result.reviewRequired,true);assert.equal(out.result.bankProfit.completion.ok,false);assert.equal(h.stats().saves,config.identityBeforeSave||config.cancelBeforeSave?0:1);assert.equal(h.stats().bankReads,1);
});

test("Bank main with Previous Return checks exact opening net assets before and after Save without changing current gross",async()=>{const h=mainHarness({previousOpening:1500000}),out=await h.run();assert.equal(out.paused,false,out.pauseMessage);assert.equal(h.stats().saves,1);assert.equal(out.result.otherSourcesPreviousReturn.ok,true);assert.equal(out.result.otherSourcesPreviousReturnAfterSave.ok,true);assert.equal(out.result.bankProfit.completion.wealth.finalTaxIncome,1000000);});
for(const config of [{previousActual:"1499999"},{previousActual:null},{previousAfterSave:"1499999"}])test(`Bank Previous Return proof blocks unsafe Save/completion ${JSON.stringify(config)}`,async()=>{const h=mainHarness({previousOpening:1500000,...config}),out=await h.run();assert.equal(out.paused,true);assert.equal(out.result.reviewRequired,true);assert.equal(h.stats().saves,config.previousAfterSave?1:0);});

test("existing MIS 64040052 conflict emits structured pauseDetails, clean copy, and Bank Profit handoffScope (never Salary)",async()=>{
 const h=mainHarness({
  existingOtherSourcesRows:[
   {section:"Final Tax",code:"64040052",description:"Profit on Debt u/s 151 (Bank)",cells:[{value:"2,465"},{value:"494"},{value:"493"}]},
  ],
 });
 const out=await h.run();
 assert.equal(out.paused,true);
 assert.equal(out.pauseAction,"portal_state_confirmation");
 assert.equal(h.stats().saves,0);
 assert.doesNotMatch(out.pauseMessage,/combined entry is not enabled/);
 assert.match(out.pauseMessage,/Comparison \(FBR IRIS vs\. TaxRocket Packet\):/);
 assert.equal(out.result.pauseDetails.requiresFbrAction,false);
 assert.equal(out.result.pauseDetails.rows.some(r=>r.code==="64040052"&&/2,465/.test(r.irisValue)&&/494/.test(r.irisValue)),true);

 // Verify mergeNavigationAutofillOutcome + buildHandoffScopeSummary directly from main.js AST
 vm.runInContext(functionSource("buildHandoffScopeSummary"),h.ctx);
 vm.runInContext(functionSource("mergeNavigationAutofillOutcome"),h.ctx);
 const merged=h.ctx.mergeNavigationAutofillOutcome({paused:false,pauseAction:"portal_sections_inspected",result:{routeScope:{id:"bank_profit",label:"Bank Profit",incomeSources:["bank_profit"]}},executionLog:[]},out,"live");
 assert.equal(merged.paused,true);
 assert.equal(merged.result.pauseDetails.title,"Existing FBR IRIS Bank Profit figures differ from your packet");
 assert.match(merged.result.handoffScope.label,/Bank Profit/);
 assert.doesNotMatch(merged.result.handoffScope.label,/Salary/);
 assert.equal(merged.result.handoffScope.salary,"not_applicable");
 assert.equal(merged.result.handoffScope.bankProfit,"needs_review");
});

test("completed Bank Profit run sets handoffScope.label to Bank Profit filled and bankProfit=filled",async()=>{
 const h=mainHarness();
 const out=await h.run();
 vm.runInContext(functionSource("buildHandoffScopeSummary"),h.ctx);
 vm.runInContext(functionSource("mergeNavigationAutofillOutcome"),h.ctx);
 const merged=h.ctx.mergeNavigationAutofillOutcome({paused:false,pauseAction:"portal_sections_inspected",result:{routeScope:{id:"bank_profit",label:"Bank Profit",incomeSources:["bank_profit"]}},executionLog:[]},out,"live");
 assert.equal(merged.paused,false);
 assert.match(merged.result.handoffScope.label,/Bank Profit ✅ filled/);
 assert.equal(merged.result.handoffScope.salary,"not_applicable");
 assert.equal(merged.result.handoffScope.bankProfit,"filled");
});

test("when fillBankProfitEntries stops, main surfaces exact Bank Profit pauseDetails instead of bogus 7033/703000 wealth error and skips Wealth",async()=>{
 let wealthCalled=false;
 const h=mainHarness({bankOk:false});
 h.ctx.irisWealthDriver={runWealthDriverStepwise:async()=>{wealthCalled=true;return{results:[],setup:[],stopped:false};}};
 const out=await h.run();
 assert.equal(out.paused,true);
 assert.equal(wealthCalled,false);
 assert.equal(h.stats().saves,0);
 assert.doesNotMatch(out.pauseMessage,/Wealth totals or reconciliation did not match/);
 assert.ok(out.result.pauseDetails);
 assert.equal(out.result.pauseDetails.title,"Bank Profit entry paused before saving");
 assert.equal(out.result.pauseDetails.rows.length,1);
 assert.equal(out.result.pauseDetails.rows[0].code,"64040052");
 assert.doesNotMatch(out.result.pauseDetails.title,/Wealth totals/);
});

test("when existing income check pauses on a second code, non-conflict codes show actual IRIS figures instead of falsely saying Empty (PKR 0)",async()=>{
 const h=mainHarness({
  existingOtherSourcesRows:[
   {section:"Final Tax",code:"64040052",description:"Profit on Debt u/s 151(1)(b) from Bank Accounts / Deposits",cells:[{value:"1,000,000"},{value:"150,000"},{value:"150,000"}]},
   {section:"Final Tax",code:"64040054",description:"151(1) (d) - Profit on Debt u/s 151 from Others",cells:[{value:"50,000"},{value:"10,000"},{value:"10,000"}]},
  ],
 });
 const out=await h.run();
 assert.equal(out.paused,true);
 assert.equal(out.pauseAction,"portal_state_confirmation");
 const row64040052=out.result.pauseDetails.rows.find(r=>r.code==="64040052");
 assert.ok(row64040052);
 assert.match(row64040052.irisValue,/1,000,000/);
 assert.doesNotMatch(row64040052.irisValue,/Empty/);
});
