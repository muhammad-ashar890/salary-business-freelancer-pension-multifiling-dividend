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

test("Bank Profit certificate facts preserve printed gross, actual withholding and net",()=>{
 assert.deepEqual(Array.from(fields.getBankProfitCertificateReviewErrors(makeFields(),2026)),[]);
 const cert=fields.readApprovedBankProfitCertificate(makeFields(),2026);assert.equal(cert.grossAnnualProfit,1000000);assert.equal(cert.taxDeducted,150000);assert.equal(cert.netProfitCredited,850000);
});
for(const [name,change]of[
 ["missing withholding",v=>v[L.taxDeducted]=null],
 ["net mismatch",v=>v[L.netProfitCredited]=900000],
 ["wrong year",v=>v[L.taxYear]=2025],
 ["wrong period",v=>v[L.reportingPeriodStart]="2024-07-01"],
 ["missing taxpayer identity",v=>{v[L.taxpayerCnic]=null;v[L.taxpayerNtn]=null;}],
 ["missing account identity",v=>{v[L.accountNumber]=null;v[L.iban]=null;}],
 ["Sukuk missing holder facts",v=>{v[L.instrumentCategory]="Sukuk";v[L.printedSectionSubsection]="151(1A)";}],
])test(`Bank Profit evidence rejects ${name}`,()=>{const values={...fixtureValues};change(values);assert.ok(fields.getBankProfitCertificateReviewErrors(makeFields(values),2026).length>0);assert.equal(fields.readApprovedBankProfitCertificate(makeFields(values),2026),null);});
test("Bank Profit missing differs from explicit zero and duplicate aliases refuse approval",()=>{
 const values={...fixtureValues,[L.taxDeducted]:0,[L.netProfitCredited]:1000000,[L.withholdingRate]:0};assert.equal(fields.getBankProfitCertificateReviewErrors(makeFields(values),2026).length,0);
 const rows=makeFields();rows.push({label:"tax withheld",value:150000});assert.ok(fields.getBankProfitCertificateReviewErrors(rows,2026).some(error=>error.includes("duplicate")));
});

test("real shared review gate exposes missing Bank Profit fields and blocks incomplete approval",()=>{
 const review=moduleLoader({})("lib/tax/document-review-required.ts");
 const input={fields:[]};const normalized=review.ensureRequiredDocumentReviewFields("bank_certificate",input);
 assert.equal(input.fields.length,0,"normalizing must not mutate input");
 assert.equal(normalized.fields.length,fields.BANK_PROFIT_CERTIFICATE_FIELD_DEFINITIONS.length);
 assert.ok(normalized.fields.every(field=>field.value===null));
 assert.ok(review.getDocumentReviewRequiredErrors("bank_certificate",normalized.fields,2026).length>0);
 assert.equal(review.getDocumentReviewRequiredErrors("bank_certificate",makeFields(),2026).length,0);
 assert.equal(review.isDocumentReviewRequiredField("bank_certificate",L.grossAnnualProfit,makeFields()),true);
 assert.equal(review.isDocumentReviewRequiredField("bank_certificate",L.taxpayerCnic,makeFields()),false);
});
