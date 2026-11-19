import { readApprovedBankProfitCertificate } from "./bank-profit-certificate-fields";

export type BankProfitEvidenceDocument = { id: string; extractionStatus: string; extractedData: string | null; bankProfitSubcategory?: string | null };

/** Category-bound cash evidence; legacy unbound documents are single-category only. */
export function buildBankProfitEvidence(input: {
  taxYear: number; filerType: string; incomeSources: string[]; selectedSubcategories: string[];
  taxpayerCnic: string | null | undefined; documents: BankProfitEvidenceDocument[];
  ledgerEntries: {entryType: string; category: string | null; amount: unknown}[];
}) {
  const fail = (reason: string) => ({ok: false as const, reason});
  if (input.taxYear !== 2026 || input.filerType !== "myself" || input.incomeSources.length !== 1 || input.incomeSources[0] !== "bank_profit") return fail("Bank Profit evidence currently supports only TY2026 Myself Bank Profit-only filings. Untested combinations remain blocked.");
  const categories = [...new Set(input.selectedSubcategories)].sort();
  if (!categories.length) return fail("Select at least one Bank Profit category before calculating.");
  const sectionByCategory: Record<string, RegExp> = {
    "bank-or-financial-institution-deposit": /\b151\s*\(\s*1\s*\)\s*\(\s*b\s*\)/i,
    "other-profit-on-debt": /\b151\s*\(\s*1\s*\)\s*\(\s*d\s*\)/i,
    "sukuk-individual-aop-above-1m": /\b151\s*\(\s*1\s*a\s*\)/i,
    "sukuk-individual-aop-below-1m": /\b151\s*\(\s*1\s*a\s*\)/i,
  };
  if (categories.some(category => !sectionByCategory[category])) return fail("This Bank Profit category needs a separately verified taxpayer/route contract before automatic calculation.");
  const cnic = String(input.taxpayerCnic ?? "").replace(/\D/g, "");
  if (cnic.length !== 13) return fail("Confirm the taxpayer CNIC before using Bank Profit certificate evidence.");
  if (!input.documents.length) return fail("Upload, review and approve a Bank Profit certificate before calculating.");
  let grossAmount = 0, taxWithheld = 0, netBankCredits = 0;
  const bySubcategory: Record<string,{grossAmount:number;taxWithheld:number;netBankCredits:number;documentIds:string[]}> = {};
  const seenDocuments = new Set<string>();
  let sukukCertificates = 0;
  for (const document of input.documents) {
    if (seenDocuments.has(document.id)) return fail("Duplicate Bank Profit certificate evidence is blocked.");
    seenDocuments.add(document.id);
    const category = document.bankProfitSubcategory ?? (categories.length === 1 ? categories[0] : null);
    if (!category || !categories.includes(category)) return fail("Every Bank Profit certificate must be bound to its selected category. Re-upload legacy or unselected-category evidence in the correct slot.");
    if (document.extractionStatus !== "MAPPED") return fail("A Bank Profit certificate changed or is not approved. Review and approve it again.");
    let certificate;
    try { certificate = readApprovedBankProfitCertificate(JSON.parse(document.extractedData ?? "{}").fields, input.taxYear); }
    catch { return fail("Bank Profit extraction is unreadable. Review the certificate again."); }
    if (!certificate) return fail("Bank Profit certificate fields are incomplete or inconsistent. Review the printed certificate before calculating.");
    if (certificate.currency !== "PKR" || String(certificate.taxpayerCnic ?? "").replace(/\D/g, "") !== cnic) return fail("Bank Profit certificate must be PKR and match the current taxpayer CNIC. NTN-only or foreign-currency evidence needs separate review.");
    if (!sectionByCategory[category].test(certificate.printedSectionSubsection)) return fail("The printed Bank Profit section/subsection does not match the selected category. No category is inferred from a rate or bank name.");
    if (category.startsWith("sukuk-")) {
      if (++sukukCertificates > 1) return fail("Multiple Sukuk certificates require a reviewed aggregate annual-return band; per-certificate bands cannot split the taxpayer threshold.");
      const holder = String(certificate.sukukHolderType ?? "").trim().toLowerCase();
      const band = String(certificate.sukukReturnBand ?? "").trim().toLowerCase();
      if (holder !== "individual") return fail("Myself Sukuk evidence must explicitly identify an individual holder.");
      const above = category.endsWith("above-1m");
      if (above ? !/\babove\b/.test(band) || certificate.grossAnnualProfit <= 1000000 : !/\bbelow\b/.test(band) || certificate.grossAnnualProfit >= 1000000) return fail("Sukuk printed band and annual return must match the selected category; the exact PKR 1M boundary needs reviewed treatment.");
    }
    const subtotal = bySubcategory[category] ??= {grossAmount:0,taxWithheld:0,netBankCredits:0,documentIds:[]};
    subtotal.grossAmount += certificate.grossAnnualProfit;
    subtotal.taxWithheld += certificate.taxDeducted;
    subtotal.netBankCredits += certificate.netProfitCredited;
    subtotal.documentIds.push(document.id);
    grossAmount += certificate.grossAnnualProfit; taxWithheld += certificate.taxDeducted; netBankCredits += certificate.netProfitCredited;
  }
  if (categories.some(category => !bySubcategory[category])) return fail("Upload and approve a certificate for every selected Bank Profit category.");
  if (Object.values(bySubcategory).some(row => ![row.grossAmount,row.taxWithheld,row.netBankCredits].every(Number.isSafeInteger)) || ![grossAmount, taxWithheld, netBankCredits].every(Number.isSafeInteger)) return fail("Bank Profit automatic calculation requires safe whole-rupee totals pending a reviewed rounding policy.");
  const normalized = (value: string | null) => String(value ?? "").trim().toUpperCase().replace(/[\s-]+/g, "_");
  let classifiedNet = 0;
  for (const entry of input.ledgerEntries) {
    const amount = Number(String(entry.amount ?? "").replace(/,/g, ""));
    if (!Number.isFinite(amount)) return fail("A Bank Profit ledger amount is invalid.");
    const category = normalized(entry.category);
    if (entry.entryType === "EXPENSE" && category === "TAX_PAYMENT" && amount > 0) return fail("Separate tax-payment debits require attribution before Bank Profit certificate withholding can be credited.");
    if (entry.entryType === "INCOME") {
      if (category !== "BANK_PROFIT" && amount !== 0) return fail("Bank Profit-only evidence contains other income; untested combinations are blocked.");
      if (category === "BANK_PROFIT") classifiedNet += amount;
    }
  }
  if (Math.round(classifiedNet * 100) !== Math.round(netBankCredits * 100) || grossAmount - taxWithheld !== netBankCredits) return fail("Certified Bank Profit gross minus actual withholding must equal the classified net bank credits. No balancing amount is invented.");
  return {ok: true as const, grossAmount, taxWithheld, netBankCredits, bySubcategory,
    evidenceFingerprint: JSON.stringify({categories, documents: input.documents.map(doc => ({id:doc.id,bankProfitSubcategory:doc.bankProfitSubcategory ?? null,extractionStatus:doc.extractionStatus,extractedData:doc.extractedData})).sort((a,b) => a.id.localeCompare(b.id))})};
}
