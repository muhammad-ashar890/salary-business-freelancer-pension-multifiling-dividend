#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const Module = require("node:module");
const path = require("node:path");
const test = require("node:test");
const ts = require("typescript");

const root = path.join(__dirname, "..");
const originalResolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...rest) {
  if (request.startsWith("@/")) request = path.join(root, request.slice(2));
  return originalResolve.call(this, request, ...rest);
};
require.extensions[".ts"] = function (module, filename) {
  const output = ts.transpileModule(fs.readFileSync(filename, "utf8"), {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2020,
    },
  }).outputText;
  module._compile(output, filename);
};

const fields = require(path.join(root, "lib/tax/bank-profit-certificate-fields.ts"));
const review = require(path.join(root, "lib/tax/document-review-required.ts"));
const documentSlots = require(path.join(root, "lib/tax/document-upload-slot.ts"));
const evidence = require(path.join(root, "lib/tax/bank-profit-evidence.ts"));
const packetPlan = require(path.join(root, "lib/tax/bank-profit-packet.ts"));

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

test("printed arithmetic-check line recovers only the amounts the model left unbound (Case 4 regression)", () => {
  const payload = {
    documentType: "bank_certificate",
    fields: [
      { label: L.taxYear, value: 2026, confidence: 1 },
      { label: L.grossAnnualProfit, value: null, confidence: 0 },
      { label: L.sukukHolderType, value: "Company", confidence: 1 },
    ],
    notes: [
      "Case 4 - Sukuk holder is a company Arithmetic check: PKR 2,000,000.00 gross profit - PKR 500,000.00 tax withheld = PKR 1,500,000.00 net credited.",
    ],
    transactions: [],
  };
  const out = fields.recoverBankProfitCertificatePrintedAmounts(payload);
  const byKind = Object.fromEntries(
    out.fields.map((field) => [fields.getBankProfitCertificateFieldKind(field.label), field]),
  );
  assert.equal(byKind.grossAnnualProfit.value, 2000000);
  assert.equal(byKind.taxDeducted.value, 500000);
  assert.equal(byKind.netProfitCredited.value, 1500000);
  assert.equal(byKind.sukukHolderType.value, "Company");
  assert.ok(
    out.notes.some((note) => String(note).startsWith(fields.BANK_PROFIT_CERTIFICATE_RECOVERY_NOTE_PREFIX)),
  );
  const errors = fields.getBankProfitCertificateReviewErrors(out.fields, 2026);
  assert.equal(errors.some((error) => error.includes("must equal Net Profit Credited")), false);
});

test("recovery never overwrites a conflicting value the model returned (Case 3 regression)", () => {
  const payload = {
    documentType: "bank_certificate",
    fields: [
      { label: L.grossAnnualProfit, value: 240000, confidence: 1 },
      { label: L.taxDeducted, value: 36000, confidence: 1 },
      { label: L.netProfitCredited, value: 240000, confidence: 1 },
    ],
    notes: [
      "Arithmetic check: PKR 240,000.00 gross profit - PKR 36,000.00 tax withheld = PKR 204,000.00 net credited.",
    ],
  };
  const out = fields.recoverBankProfitCertificatePrintedAmounts(payload);
  const net = out.fields.find((field) => fields.getBankProfitCertificateFieldKind(field.label) === "netProfitCredited");
  assert.equal(net.value, 240000);
  assert.equal(
    out.notes.some((note) => String(note).startsWith(fields.BANK_PROFIT_CERTIFICATE_RECOVERY_NOTE_PREFIX)),
    false,
  );
  const errors = fields.getBankProfitCertificateReviewErrors(out.fields, 2026);
  assert.equal(errors.some((error) => error.includes("must equal Net Profit Credited")), true);
});

test("recovery skips absent or conflicting printed arithmetic", () => {
  const none = fields.recoverBankProfitCertificatePrintedAmounts({ fields: [], notes: [] });
  assert.equal(none.fields.length, 0);
  const conflicting = fields.recoverBankProfitCertificatePrintedAmounts({
    fields: [{ label: L.grossAnnualProfit, value: null, confidence: 0 }],
    notes: [
      "Reconciliation PKR 45,000.00 gross − PKR 9,000.00 withholding = PKR 36,000.00 net credited",
      "Arithmetic check: PKR 240,000.00 gross profit - PKR 36,000.00 tax withheld = PKR 204,000.00 net credited.",
    ],
  });
  const gross = conflicting.fields.find((field) => fields.getBankProfitCertificateFieldKind(field.label) === "grossAnnualProfit");
  assert.equal(gross.value, null);
});

test("label aliases cover printed sample/applied rate variants and category mismatch guard", () => {
  assert.equal(fields.getBankProfitCertificateFieldKind("Sample rate"), "withholdingRate");
  assert.equal(fields.getBankProfitCertificateFieldKind("Applied rate"), "withholdingRate");
  const deposit = fields.readApprovedBankProfitCertificate(makeFields(), 2026);
  assert.equal(fields.bankProfitCertificateCategoryError(deposit, "bank-or-financial-institution-deposit"), null);
  assert.match(fields.bankProfitCertificateCategoryError(deposit, "other-profit-on-debt"), /does not match selected category/);
});

test("certificate extraction prompt, empty transactions normalization and recovery wiring are pinned", () => {
  const source = fs.readFileSync(path.join(root, "app/actions/extraction.ts"), "utf8").replace(/\r\n/g, "\n");
  assert.ok(
    source.includes('return an empty "transactions" array even when the certificate prints a profit/withholding record row'),
  );
  assert.ok(
    source.includes("without the % sign") && source.includes("sample or illustrative rate"),
  );
  assert.ok(
    source.includes("column order") && source.includes("Bank-applied Withholding / Rate (%)"),
  );
  assert.ok(source.includes('if (expectedDocumentType === "bank_certificate") {\n    return { ...payload, transactions: [] };\n  }'));
  assert.ok(source.includes("recoverBankProfitCertificatePrintedAmounts"));
  const callSites = source.split("recoverBankProfitCertificatePrintedAmounts(").length - 1;
  assert.equal(callSites, 1, "exactly one call site in initial extraction");
  const savePath = source.slice(
    source.indexOf("export async function updateDocumentExtractionAction"),
    source.indexOf("export async function updateDocumentExtractionAction") + 60000,
  );
  const saveFunctionBody = savePath.slice(0, savePath.indexOf("\nexport async function", 10));
  assert.equal(saveFunctionBody.includes("recoverBankProfitCertificatePrintedAmounts("), false);
});

test("filing wizard clears step-scoped gate banner on goBack and rail click, and documents step supports certificate review", () => {
  const wizard = fs.readFileSync(path.join(root, "components/tax/filing/filing-wizard.tsx"), "utf8").replace(/\r\n/g, "\n");
  assert.match(
    wizard,
    /function goBack\(\)\s*\{\s*const previousStep[^}]*setFilingActionError\(null\);[^}]*setStep\(previousStep\)/,
  );
  assert.match(
    wizard,
    /onRailItemClick=\{\(index\) => \{[\s\S]{0,300}?setFilingActionError\(null\);/,
  );
  const stepDocs = fs.readFileSync(path.join(root, "components/tax/filing/wizard-documents-step.tsx"), "utf8").replace(/\r\n/g, "\n");
  assert.match(stepDocs, /isBankProfitCertificate/);
  assert.match(stepDocs, /Gross profit minus tax withheld must/);
  assert.match(stepDocs, /\(isPensionStatement \|\|\s*\n?\s*isBankProfitCertificate\)/);
  const hook = fs.readFileSync(path.join(root, "components/tax/filing/hooks/use-filing-documents.ts"), "utf8").replace(/\r\n/g, "\n");
  assert.match(hook, /Save & Approve Map again before continuing/);
});

test("multiple Bank Profit categories keep separate slots and distinct IRIS plan rows", () => {
  const deposit = "bank-or-financial-institution-deposit";
  const other = "other-profit-on-debt";
  assert.equal(documentSlots.resolveFilingDocumentSlot(`bank_certificate:${deposit}`).bankProfitSubcategory, deposit);
  assert.equal(documentSlots.resolveFilingDocumentSlot(`bank_certificate:${other}`).bankProfitSubcategory, other);
  assert.equal(documentSlots.resolveFilingDocumentSlot("bank_certificate:not-a-rule").success, false);

  const docDeposit = {
    id: "doc-deposit",
    bankProfitSubcategory: deposit,
    extractionStatus: "MAPPED",
    extractedData: JSON.stringify({ fields: makeFields() }),
  };
  const docOther = {
    id: "doc-other",
    bankProfitSubcategory: other,
    extractionStatus: "MAPPED",
    extractedData: JSON.stringify({
      fields: makeFields({
        ...fixtureValues,
        [L.printedSectionSubsection]: "Section 151(1)(d)",
        [L.instrumentCategory]: "NSS Certificate",
        [L.grossAnnualProfit]: "400,000.00",
        [L.taxDeducted]: "60,000.00",
        [L.netProfitCredited]: "340,000.00",
      }),
    }),
  };
  const proof = evidence.buildBankProfitEvidence({
    taxYear: 2026,
    filerType: "myself",
    incomeSources: ["bank_profit"],
    selectedSubcategories: [deposit, other],
    taxpayerCnic: "4210112345678",
    documents: [docDeposit, docOther],
    ledgerEntries: [{ entryType: "INCOME", category: "BANK_PROFIT", amount: 1190000 }],
  });
  assert.equal(proof.ok, true, proof.reason);
  const plan = packetPlan.buildBankProfitPacketPlan({
    taxYear: 2026,
    filerType: "myself",
    incomeSources: ["bank_profit"],
    selectedSubcategories: [deposit, other],
    taxpayerCnic: "4210112345678",
    documents: [docDeposit, docOther],
    ledgerEntries: [{ entryType: "INCOME", category: "BANK_PROFIT", amount: 1190000 }],
    calculationRevision: "rev-1",
    storedTaxWithheld: 210000,
    calculationLines: [
      {
        source: "bank_profit",
        subcategory: deposit,
        taxBase: 1000000,
        calculatedTax: 200000,
        detailsJson: JSON.stringify({ isFinalTax: true, bankProfitEvidenceFingerprint: proof.evidenceFingerprint }),
      },
      {
        source: "bank_profit",
        subcategory: other,
        taxBase: 400000,
        calculatedTax: 60000,
        detailsJson: JSON.stringify({ isFinalTax: true, bankProfitEvidenceFingerprint: proof.evidenceFingerprint }),
      },
    ],
  });
  assert.equal(plan.ok, true, plan.reason);
  assert.deepEqual(new Set(plan.plan.rows.map((r) => r.irisCode)), new Set(["64040052", "64040054"]));
});

test("uploadFilingDocumentAction & removeFilingDocumentAction isolate multi-certificate Bank Profit slots", async () => {
  const docs = [];
  let seq = 1;
  const tx = {
    document: {
      findFirst: async ({ where }) => docs.find((d) =>
        Object.entries(where).every(([k, v]) => (k === "id" && typeof v === "object" && v.not ? d.id !== v.not : d[k] === v)),
      ) ?? null,
      create: async ({ data }) => {
        const rec = { id: `doc-${seq++}`, extractionStatus: "PENDING", ...data };
        docs.push(rec);
        return rec;
      },
      delete: async ({ where }) => {
        const idx = docs.findIndex((d) => d.id === where.id);
        if (idx >= 0) docs.splice(idx, 1);
        return { id: where.id };
      },
    },
    ledgerEntry: { deleteMany: async () => ({ count: 0 }) },
    filingTaxCalculationLine: { deleteMany: async () => ({ count: 0 }) },
    taxPayment: { deleteMany: async () => ({ count: 0 }) },
    filingTaxCredit: { deleteMany: async () => ({ count: 0 }) },
    filingIncomeRecord: { deleteMany: async () => ({ count: 0 }) },
    filingPacket: { updateMany: async () => ({ count: 0 }) },
    filingDraft: { updateMany: async () => ({ count: 0 }), update: async () => ({}) },
    fbrConnection: { updateMany: async () => ({ count: 0 }) },
    localAgentJob: { updateMany: async () => ({ count: 0 }) },
  };
  const prismaStub = {
    user: { findUnique: async () => ({ id: "u1" }) },
    filingDraft: {
      findFirst: async () => ({ id: "d1", userId: "u1", taxYear: 2026, filerType: "myself", incomeSources: JSON.stringify(["bank_profit"]) }),
    },
    document: {
      findFirst: async ({ where }) => docs.find((d) =>
        Object.entries(where).every(([k, v]) => (k === "id" && typeof v === "object" && v.not ? d.id !== v.not : typeof v === "object" && v.not ? d[k] !== v.not : d[k] === v)),
      ) ?? null,
      findUnique: async ({ where }) => docs.find((d) => d.id === where.id) ?? null,
      count: async ({ where }) => docs.filter((d) =>
        Object.entries(where).every(([k, v]) => (k === "id" && typeof v === "object" && v.not ? d.id !== v.not : d[k] === v)),
      ).length,
    },
    $transaction: async (fn) => fn(tx),
  };
  const vm = require("node:vm");
  const mockCache = new Map();
  const loadIsolated = (rel, mocks = {}, parent = root) => {
    if (Object.hasOwn(mocks, rel)) return mocks[rel];
    const abs = rel.startsWith("@/")
      ? path.join(root, rel.slice(2))
      : rel.startsWith(".")
        ? path.resolve(parent, rel)
        : path.isAbsolute(rel)
          ? rel
          : null;
    if (!abs) return require(rel);
    const file = fs.existsSync(abs) && fs.statSync(abs).isFile() ? abs : `${abs}.ts`;
    if (mockCache.has(file)) return mockCache.get(file).exports;
    const mod = { exports: {} };
    mockCache.set(file, mod);
    const code = ts.transpileModule(fs.readFileSync(file, "utf8"), {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, esModuleInterop: true },
    }).outputText;
    vm.runInContext(
      code,
      vm.createContext({
        console,
        Buffer,
        Uint8Array,
        File,
        FormData,
        TextDecoder,
        URL,
        process,
        exports: mod.exports,
        module: mod,
        require: (child) => loadIsolated(child, mocks, path.dirname(file)),
      }),
      { filename: file },
    );
    return mod.exports;
  };
  const docsAction = loadIsolated("@/app/actions/documents.ts", {
    "next-auth/next": { getServerSession: async () => ({ user: { email: "t@example.com" } }) },
    "@/lib/auth": { authOptions: {} },
    "@/lib/prisma": { prisma: prismaStub },
    "@/lib/rate-limit": { consumeRateLimit: () => ({ allowed: true, retryAfterSeconds: 0 }) },
    "fs/promises": { mkdir: async () => {}, writeFile: async () => {}, unlink: async () => {} },
  });

  const makePdf = (name) => new File([Buffer.from("%PDF-1.4\ntest\n")], name, { type: "application/pdf" });
  const form1 = new FormData();
  form1.set("draftId", "d1");
  form1.set("documentType", "bank_certificate:bank-or-financial-institution-deposit");
  form1.set("file", makePdf("cert-1.pdf"));
  const up1 = await docsAction.uploadFilingDocumentAction(form1);
  assert.equal(up1.success, true, up1.error);

  // Appending second cert in deposit category preserves cert-1
  const form2 = new FormData();
  form2.set("draftId", "d1");
  form2.set("documentType", "bank_certificate:bank-or-financial-institution-deposit");
  form2.set("appendDocument", "true");
  form2.set("file", makePdf("cert-2.pdf"));
  const up2 = await docsAction.uploadFilingDocumentAction(form2);
  assert.equal(up2.success, true, up2.error);
  assert.equal(docs.length, 2);

  // Duplicate filename in same category blocked
  const formDup = new FormData();
  formDup.set("draftId", "d1");
  formDup.set("documentType", "bank_certificate:bank-or-financial-institution-deposit");
  formDup.set("appendDocument", "true");
  formDup.set("file", makePdf("cert-2.pdf"));
  const upDup = await docsAction.uploadFilingDocumentAction(formDup);
  assert.equal(upDup.success, false);
  assert.match(upDup.error, /already uploaded/i);

  // Appending second Sukuk cert is blocked
  const formSukuk = new FormData();
  formSukuk.set("draftId", "d1");
  formSukuk.set("documentType", "bank_certificate:sukuk-individual-aop-above-1m");
  formSukuk.set("appendDocument", "true");
  formSukuk.set("file", makePdf("sukuk-2.pdf"));
  const upSukuk = await docsAction.uploadFilingDocumentAction(formSukuk);
  assert.equal(upSukuk.success, false);

  // Targeted replace replaces ONLY cert-2 and keeps cert-1
  const formReplace2 = new FormData();
  formReplace2.set("draftId", "d1");
  formReplace2.set("documentType", "bank_certificate:bank-or-financial-institution-deposit");
  formReplace2.set("replaceDocumentId", up2.document.id);
  formReplace2.set("file", makePdf("cert-2-updated.pdf"));
  const rep2 = await docsAction.uploadFilingDocumentAction(formReplace2);
  assert.equal(rep2.success, true, rep2.error);
  assert.equal(docs.length, 2);
  assert.ok(docs.some((d) => d.fileName === "cert-1.pdf"));
  assert.ok(docs.some((d) => d.fileName === "cert-2-updated.pdf"));

  // Can remove extra sibling cert-2, then last cert-1 stays protected
  const rem2 = await docsAction.removeFilingDocumentAction(rep2.document.id);
  assert.equal(rem2.success, true, rem2.error);
  assert.equal(docs.length, 1);

  const rem1 = await docsAction.removeFilingDocumentAction(up1.document.id);
  assert.equal(rem1.success, false);
  assert.match(rem1.error, /cannot be removed here/);
});
