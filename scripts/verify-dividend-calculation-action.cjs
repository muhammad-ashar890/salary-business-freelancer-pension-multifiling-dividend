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


function harness({ categories = ["reit-and-other"], certs, sources = ["dividend"], taxDebit = 0, stored = 999999, details = {} } = {}) {
  const draft = { id: "dividend-draft", userId: "user", taxYear: 2026, filerType: "myself", incomeSources: JSON.stringify(sources), taxWithheld: new Prisma.Decimal(stored), incomeSelections: categories.map(subcategory => ({ source: "dividend", subcategory, detailsJson: JSON.stringify(details) })) };
  const documents = certs ?? [{ id: "cert", dividendSubcategory: categories[0], extractionStatus: "MAPPED", extractedData: JSON.stringify({fields: [{label: "Gross Dividend PKR", value: 100000}, {label: "Withholding Tax u/s 150", value: 15000}]}) }];
  const entries = [{id: "net", entryType: "INCOME", category: "DIVIDEND", description: "Net dividend", amount: new Prisma.Decimal(85000)}, ...(taxDebit ? [{id: "tax", entryType: "EXPENSE", category: "TAX_PAYMENT", description: "Unattributed tax", amount: new Prisma.Decimal(taxDebit)}] : [])];
  const calls = { lines: [] };
  const prisma = {
    user: {findUnique: async () => ({id: "user", dateOfBirth: null})},
    filingDraft: {findFirst: async () => draft, update: async ({data}) => Object.assign(draft, data)},
    ledgerEntry: {findMany: async () => entries},
    document: {findMany: async () => documents, findFirst: async () => null},
    filingTaxCalculationLine: {deleteMany: async () => ({}), createMany: async ({data}) => {calls.lines = data; return {}; }},
    filingPacket: {updateMany: async () => ({})}, localAgentJob: {updateMany: async () => ({})}, fbrConnection: {updateMany: async () => ({})},
    $transaction: async fn => fn(prisma),
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
function certificate(category, gross, wht, extra = {}) {
  return {id: category, dividendSubcategory: category, extractionStatus: "MAPPED", extractedData: JSON.stringify({fields: [{label: "Gross Dividend PKR", value: gross}, {label: "Withholding Tax u/s 150", value: wht}]}), ...extra};
}
test("real action: dividend uses gross, actual WHT, never net or stale stored credit; repeat is stable", async () => {
  const h = harness();
  for (let i = 0; i < 2; i++) {
    const response = await h.run();
    assert.equal(response.success, true, response.error);
    const r = response.result;
    assert.equal(r.status, "ESTIMATE", r.note);
    assert.equal(r.taxableIncome, 100000);
    assert.equal(r.taxDue, 15000);
    assert.equal(r.taxWithheld, 15000);
    assert.equal(r.taxPayable, 0);
    assert.equal(r.refundDue, 0);
    assert.equal(h.calls.lines[0].taxBase, 100000);
  }
});
test("real action: two certificate-bound categories price independently", async () => {
  const h = harness({categories: ["ipp", "reit-and-other"], certs: [certificate("ipp", 200000, 15000), certificate("reit-and-other", 100000, 15000)]});
  const response = await h.run(); assert.equal(response.success, true, response.error);
  assert.equal(response.result.status, "ESTIMATE", response.result.note);
  assert.equal(response.result.taxDue, 30000);
  assert.equal(response.result.taxWithheld, 30000);
  assert.equal(response.result.taxableIncome, 300000);
});
for (const [label, config] of [
  ["no certificate", {certs: []}],
  ["missing withholding", {certs: [certificate("reit-and-other", 100000, null)]}],
  ["changed extraction", {certs: [certificate("reit-and-other", 100000, 15000, {extractionStatus: "COMPLETED"})]}],
  ["wrong category", {certs: [certificate("ipp", 100000, 15000)]}],
  ["multiple categories without complete proof", {categories: ["ipp", "reit-and-other"]}],
  ["unattributed tax debit", {taxDebit: 15000}],
  ["untested source combination", {sources: ["dividend", "other_income"]}],
]) {
  test(`real action fails closed: ${label}`, async () => {
    const response = await harness(config).run(); assert.equal(response.success, true, response.error);
    assert.equal(response.result.status, "NEEDS_USER_INPUT");
    assert.equal(response.result.taxPayable, null);
    assert.equal(response.result.breakdown.length, 0);
  });
}
test("real action: explicit zero on SPV dividend remains valid", async () => {
  const response = await harness({categories: ["reit-receives-from-spv"], certs: [certificate("reit-receives-from-spv", 100000, 0)]}).run();
  assert.equal(response.success, true, response.error);
  assert.equal(response.result.status, "ESTIMATE", response.result.note);
  assert.equal(response.result.taxDue, 0);
  assert.equal(response.result.taxWithheld, 0);
});

function mfCertificate(debt=60000,equity=40000,id="mf") {
 const doc=certificate("mutual-fund-proportional",100000,21000,{id});const data=JSON.parse(doc.extractedData);
 data.fields.push({label:"Debt Portion",value:debt},{label:"Equity Portion",value:equity});doc.extractedData=JSON.stringify(data);return doc;
}
test("real action: certified MF split overrides stale declared portions",async()=>{
 const r=await harness({categories:["mutual-fund-proportional"],certs:[mfCertificate()],details:{debtPortion:0,equityPortion:100000}}).run();
 assert.equal(r.success,true,r.error);assert.equal(r.result.status,"ESTIMATE",r.result.note);assert.equal(r.result.taxDue,21000);assert.equal(r.result.taxWithheld,21000);
});
for(const [name,docs]of[["missing split",[certificate("mutual-fund-proportional",100000,21000)]],["one rupee mismatch",[mfCertificate(60000,40001)]],["negative split",[mfCertificate(-10000,110000)]],["one incomplete certificate",[mfCertificate(),certificate("mutual-fund-proportional",100000,21000,{id:"incomplete"})]]])test(`real action: MF ${name} cannot fall back to declarations`,async()=>{
 const r=await harness({categories:["mutual-fund-proportional"],certs:docs,details:{debtPortion:60000,equityPortion:40000}}).run();assert.equal(r.success,true,r.error);assert.equal(r.result.status,"NEEDS_USER_INPUT");assert.equal(r.result.taxPayable,null);
});
test("real action: multi-category MF certified split stays isolated",async()=>{
 const r=await harness({categories:["ipp","mutual-fund-proportional"],certs:[mfCertificate(),certificate("ipp",200000,15000)],details:{debtPortion:0,equityPortion:100000}}).run();assert.equal(r.success,true,r.error);assert.equal(r.result.status,"ESTIMATE",r.result.note);assert.equal(r.result.taxDue,36000);
});
