"use strict";

const fs = require("node:fs");
const path = require("node:path");
const Module = require("node:module");
const assert = require("node:assert/strict");
const test = require("node:test");
const ts = require("typescript");

const projectRoot = path.join(__dirname, "..");

const originalResolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...rest) {
  if (request.startsWith("@/")) {
    request = path.join(projectRoot, request.slice(2));
  }
  return originalResolve.call(this, request, ...rest);
};
require.extensions[".ts"] = function (module, filename) {
  const source = fs.readFileSync(filename, "utf8");
  const compiled = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      esModuleInterop: true,
    },
    fileName: filename,
  }).outputText;
  module._compile(compiled, filename);
};


const {buildDividendPacketEvidence, dividendEvidenceFingerprint} = require("../lib/tax/dividend-packet-evidence");
const {buildPortalFieldMap} = require("../lib/tax/portal-field-map");
const {planWealthWork} = require("../electron-connect/iris-wealth-driver");
function cert(category = "reit-and-other", gross = 100000, tax = 15000, extra = {}) {
  return {id: `cert-${category}`, dividendSubcategory: category, extractionStatus: "MAPPED", extractedData: JSON.stringify({fields: [{label: "Gross Dividend PKR", value: gross}, {label: "Withholding Tax u/s 150", value: tax}]}), ...extra};
}
const ledger = (amount = 85000) => [{entryType: "INCOME", category: "DIVIDEND", amount, id: "bank-dividend", description: "Net dividend receipt"}];
const proof = (extra = {}) => buildDividendPacketEvidence({documents: [cert()], selectedSubcategories: ["reit-and-other"], ledgerEntries: ledger(), ...extra});
test("cash dividend packet proof: gross 100000 - WHT 15000 = bank net 85000; read-only 7033 expectation", () => {
  const out = proof(); assert.equal(out.ok, true, out.reason);
  assert.equal(out.grossAmount, 100000); assert.equal(out.taxWithheld, 15000); assert.equal(out.netBankCredits, 85000);
  assert.equal(out.agentFields.length, 1);
  assert.equal(out.agentFields[0].headerRowId, "999919");
  assert.deepEqual(out.wealth.finalTaxIncome, {irisCode: "7033", expected: 100000, readOnly: true});
});
test("wealth mapping: one certificate-backed 7098 outflow, no invented 7033 write or 703000 plug", () => {
  const out = proof();
  const map = buildPortalFieldMap({taxYear: 2026, filerType: "myself", taxpayerListStatus: "ATL", ledgerEntries: ledger(), dividendCertificates: out.certificates, dividendSubcategories: ["reit-and-other"]});
  const rows = map.wealthFields.filter(row => row.irisCode === "7098");
  assert.equal(rows.length, 1); assert.equal(rows[0].ourAmount, 15000);
  assert.equal(rows[0].rowDescriptionIncludes, "Income tax deducted u/s 150");
  const prepared = rows.map(row => ({...row, value: String(row.ourAmount)}));
  assert.equal(planWealthWork(prepared).outflows.length, 1);
  assert.equal(planWealthWork(prepared).unsupported.length, 0);
  assert.equal(map.wealthFields.some(row => ["7033", "703000"].includes(row.irisCode)), false);
  assert.equal(out.wealth.finalTaxIncome.expected - rows[0].ourAmount, out.netBankCredits);
});
test("multiple dividend categories merge 7098 by section, not by row or certificate", () => {
  const documents = [cert("ipp", 200000, 15000), cert("reit-and-other", 100000, 15000)];
  const out = proof({documents, selectedSubcategories: ["ipp", "reit-and-other"], ledgerEntries: ledger(270000)});
  assert.equal(out.ok, true, out.reason); assert.equal(out.agentFields.length, 2);
  const map = buildPortalFieldMap({taxYear: 2026, filerType: "myself", ledgerEntries: ledger(270000), dividendCertificates: out.certificates, dividendSubcategories: ["ipp", "reit-and-other"]});
  const rows = map.wealthFields.filter(row => row.irisCode === "7098");
  assert.equal(rows.length, 1); assert.equal(rows[0].ourAmount, 30000); assert.equal(rows[0].sourceEntryCount, 2);
});
test("evidence identity is order independent, but binds document, category, approval and extraction changes", () => {
  const a = cert("ipp", 200000, 15000), b = cert();
  const key = dividendEvidenceFingerprint([a,b], ["ipp", "reit-and-other"]);
  assert.equal(key, dividendEvidenceFingerprint([b,a], ["reit-and-other", "ipp"]));
  for (const changed of [{...a, id:"other"}, {...a, extractionStatus:"COMPLETED"}, {...a, dividendSubcategory:"reit-and-other"}, {...a, extractedData:"{}"}]) {
    assert.notEqual(key, dividendEvidenceFingerprint([changed,b], ["ipp", "reit-and-other"]));
  }
});
for (const [name, config] of [
  ["no certificate", {documents: []}],
  ["malformed JSON", {documents: [cert(undefined, undefined, undefined, {extractedData: "bad-json"})]}],
  ["malformed fields", {documents: [cert(undefined, undefined, undefined, {extractedData: '{"fields":[null]}'})]}],
  ["missing withholding", {documents: [cert("reit-and-other",100000,null)]}],
  ["unapproved certificate", {documents: [cert(undefined, undefined, undefined, {extractionStatus:"COMPLETED"})]}],
  ["no selection", {selectedSubcategories: []}],
  ["missing category evidence", {selectedSubcategories:["ipp","reit-and-other"]}],
  ["bank net mismatch", {ledgerEntries:ledger(100000)}],
  ["tax ledger double credit", {ledgerEntries:[...ledger(),{entryType:"EXPENSE", category:"TAX_PAYMENT",amount:15000}]}],
  ["other income", {ledgerEntries:[...ledger(),{entryType:"INCOME", category:"OTHER_INCOME",amount:100}]}],
  ["non-cash bonus shares", {selectedSubcategories:["bonus-shares"],documents:[cert("bonus-shares")]}],
]) test(`packet proof fails closed: ${name}`, () => {const out=proof(config);assert.equal(out.ok,false);assert.ok(out.reason);});
test("explicit zero certificate withholding creates no fake outflow", () => {
  const out = proof({selectedSubcategories:["reit-receives-from-spv"],documents:[cert("reit-receives-from-spv",100000,0)],ledgerEntries:ledger(100000)});
  assert.equal(out.ok,true,out.reason);
  const map=buildPortalFieldMap({taxYear:2026,filerType:"myself",ledgerEntries:ledger(100000),dividendCertificates:out.certificates,dividendSubcategories:["reit-receives-from-spv"]});
  assert.equal(map.wealthFields.some(row=>row.irisCode==="7098"),false);
});

test("MF packet proof requires a per-certificate split, not legacy calculation declarations",()=>{
 function mf(debt,equity){const doc=cert("mutual-fund-proportional",100000,21000);const payload=JSON.parse(doc.extractedData);payload.fields.push({label:"Debt Portion",value:debt},{label:"Equity Portion",value:equity});doc.extractedData=JSON.stringify(payload);return doc;}
 for(const [debt,equity,ok]of[[60000,40000,true],[0,100000,true],[null,null,false],[60000,40001,false],[-10000,110000,false]]){
  const result=buildDividendPacketEvidence({documents:[mf(debt,equity)],selectedSubcategories:["mutual-fund-proportional"],ledgerEntries:ledger(79000)});assert.equal(result.ok,ok,result.reason);
 }
});
