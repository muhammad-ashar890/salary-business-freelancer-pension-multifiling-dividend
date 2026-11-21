import { buildBankProfitEvidence } from "./bank-profit-evidence";
import { readApprovedBankProfitCertificate } from "./bank-profit-certificate-fields";

const TARGETS: Record<string, {code:string;label:string;detail:"investment"|"direct"}> = {
  "bank-or-financial-institution-deposit": {code:"64040052",label:"Profit on Debt u/s 151(1)(b) from Bank Accounts / Deposits",detail:"investment"},
  "other-profit-on-debt": {code:"64040054",label:"151(1) (d) - Profit on Debt u/s 151 from Others",detail:"investment"},
  "sukuk-individual-aop-above-1m": {code:"64330055",label:"Return on Investment in Sukuks u/s 151(1A) @ 12.5%",detail:"direct"},
  "sukuk-individual-aop-below-1m": {code:"64330054",label:"Return on Investment in Sukuks u/s 151(1A) @ 10%",detail:"direct"},
};

type CalculationLine = {source:string;subcategory?:string;taxBase:unknown;calculatedTax:unknown;detailsJson:string};

function allocateCategoryTaxChargeable(
  certificates: ReadonlyArray<{ grossAnnualProfit: number }>,
  totalGross: number,
  calculatedTax: number,
): number[] {
  if (certificates.length === 1) return [calculatedTax];
  if (totalGross <= 0 || calculatedTax === 0) return certificates.map(() => 0);
  const shares = certificates.map((cert, index) => {
    const numerator = BigInt(cert.grossAnnualProfit) * BigInt(calculatedTax);
    const denom = BigInt(totalGross);
    const base = Number(numerator / denom);
    const rem = numerator % denom;
    return { index, base, rem };
  });
  const assigned = shares.map((item) => item.base);
  let remaining = calculatedTax - assigned.reduce((sum, val) => sum + val, 0);
  const order = [...shares].sort((a, b) =>
    a.rem === b.rem ? a.index - b.index : b.rem > a.rem ? 1 : -1,
  );
  for (let i = 0; i < remaining; i += 1) {
    assigned[order[i % order.length].index] += 1;
  }
  return assigned;
}

/** Versioned, certificate-bound plan; computed Tax Chargeable is READ ONLY. */
export function buildBankProfitPacketPlan(input: Parameters<typeof buildBankProfitEvidence>[0] & {
  calculationRevision:string|null|undefined; calculationLines:CalculationLine[]; storedTaxWithheld:unknown;
}) {
  const fail = (reason:string) => ({ok:false as const,reason});
  const proof = buildBankProfitEvidence(input);
  if (proof.ok === false) return proof;
  if (!input.calculationRevision || Number(input.storedTaxWithheld) !== proof.taxWithheld) return fail("Bank Profit calculation revision or actual withholding is stale. Recalculate and approve a fresh packet.");
  const lines = input.calculationLines.filter(line=>line.source === "bank_profit");
  const categories = Object.keys(proof.bySubcategory).sort();
  if (lines.length !== categories.length) return fail("Bank Profit calculation must contain exactly one current evidence-bound line per selected category.");
  const rows = [];
  for (const subcategory of categories) {
    const subtotal = proof.bySubcategory[subcategory];
    const matching = lines.filter(line=>line.subcategory === subcategory);
    if (matching.length !== 1) return fail("Bank Profit calculation category binding is missing or duplicated.");
    const line = matching[0];
    let details;
    try { details = JSON.parse(line.detailsJson); } catch { return fail("Bank Profit calculation evidence is unreadable."); }
    const calculatedTax = Number(line.calculatedTax);
    if (details.bankProfitEvidenceFingerprint !== proof.evidenceFingerprint || details.isFinalTax !== true || Number(line.taxBase) !== subtotal.grossAmount || !Number.isSafeInteger(calculatedTax) || calculatedTax < 0) return fail("Bank Profit calculation no longer matches current certificate evidence or final-tax treatment.");
    const target = TARGETS[subcategory];
    if (!target) return fail("Bank Profit category has no approved packet target.");
    if (target.detail !== "investment" && subtotal.documentIds.length !== 1) return fail("Multiple Sukuk certificates require a single aggregate category contract.");
    const docIds = [...subtotal.documentIds].sort((a, b) => a.localeCompare(b));
    const parsedCerts = docIds.map((docId) => {
      const document = input.documents.find(doc => doc.id === docId)!;
      const certificate = readApprovedBankProfitCertificate(JSON.parse(document.extractedData!).fields, input.taxYear)!;
      return { document, certificate };
    });
    const seenDescriptions = new Set<string>();
    const chargeables = allocateCategoryTaxChargeable(
      parsedCerts.map((item) => item.certificate),
      subtotal.grossAmount,
      calculatedTax,
    );
    for (let i = 0; i < parsedCerts.length; i += 1) {
      const { document, certificate } = parsedCerts[i];
      const investment = certificate.instrumentCategory.trim();
      if (!investment || investment.length > 50 || /[\r\n\x00-\x1f]/.test(investment)) return fail("Bank Profit instrument must be a single printed line of at most 50 characters for the Investment dialog.");
      const contents = [`1. ${certificate.iban || certificate.accountNumber}`,`2. ${investment}`,`3. ${certificate.bankName.trim()}`].join("\n");
      const descKey = `${investment} - ${contents}`.replace(/\s+/g, " ").trim().toLowerCase();
      if (seenDescriptions.has(descKey)) return fail("Multiple Bank Profit certificates in the same category must identify distinct accounts or investments for IRIS Investment rows.");
      seenDescriptions.add(descKey);
      rows.push({subcategory,documentId:document.id,irisCode:target.code,label:target.label,detailMode:target.detail,
        panelTitle:"Final Tax",headerRowId:"999919",headers:["Taxable Amount","Tax Deducted","Tax Chargeable"],
        investment,contents,values:[{columnIndex:0,column:"Taxable Amount",value:String(certificate.grossAnnualProfit)},{columnIndex:1,column:"Tax Deducted",value:String(certificate.taxDeducted)}],
        taxChargeable:{columnIndex:2,expected:chargeables[i],readOnly:true as const}});
    }
  }
  return {ok:true as const, proof, plan:{version:"bank-profit-final-tax-v1" as const,calculationRevision:input.calculationRevision,evidenceFingerprint:proof.evidenceFingerprint,rows,
    wealth:{finalTaxIncome:{irisCode:"7033",expected:proof.grossAmount,readOnly:true as const},taxOutflow:{irisCode:"7098",section:"151",amount:proof.taxWithheld},netBankCredits:proof.netBankCredits}}};
}

export type BankProfitPacketPlan = Extract<ReturnType<typeof buildBankProfitPacketPlan>,{ok:true}>["plan"];
