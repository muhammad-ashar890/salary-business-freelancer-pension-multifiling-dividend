import { sumMoney } from "../money";
import {
  buildDividendFinalTaxPlan,
  buildDividendTaxDeductionAgentFields,
  dividendAmountsFromExtraction,
  dividendProportionsFromExtraction,
  validateDividendCertificateAmounts,
  type DividendCertificateInput,
} from "./dividend-portal-map";

export type DividendEvidenceDocument = {
  id: string;
  dividendSubcategory: string | null;
  extractionStatus: string;
  extractedData: string | null;
};

/** Canonical evidence identity, not a guessed attribution or a security hash. */
export function dividendEvidenceFingerprint(
  documents: readonly DividendEvidenceDocument[],
  selectedSubcategories: readonly string[],
) {
  return JSON.stringify({
    categories: [...new Set(selectedSubcategories)].sort(),
    documents: documents.map((doc) => ({
      id: doc.id,
      subcategory: doc.dividendSubcategory,
      status: doc.extractionStatus,
      extraction: doc.extractedData,
    })).sort((a, b) => a.id.localeCompare(b.id)),
  });
}

/**
 * Packet safety proof for cash dividend-only filings. No evidence is silently
 * discarded, missing WHT is never zero, and net bank credits must tie to gross
 * less actual withholding. Bonus shares are non-cash and need a separate asset
 * proof; this cash proof must not manufacture a bank receipt for them.
 */
export function buildDividendPacketEvidence(params: {
  documents: readonly DividendEvidenceDocument[];
  selectedSubcategories: readonly string[];
  ledgerEntries: readonly { entryType: string; category: string | null; amount: unknown }[];
}) {
  const fail = (reason: string) => ({ ok: false as const, reason });
  const selected = [...new Set(params.selectedSubcategories)];
  if (!selected.length) return fail("Select the dividend category before generating a packet.");
  if (selected.includes("bonus-shares")) {
    return fail("Bonus shares (§236Z) are non-cash. A reviewed shares-asset and tax-payment reconciliation is required before an executable packet; cash-dividend reconciliation cannot prove this route.");
  }
  const documents = params.documents.filter((doc) =>
    doc.dividendSubcategory ? selected.includes(doc.dividendSubcategory) : true,
  );
  if (!documents.length) return fail("Upload and approve the dividend certificate for every selected category.");
  const certificates: DividendCertificateInput[] = [];
  for (const doc of documents) {
    if (doc.extractionStatus !== "MAPPED") return fail("A dividend certificate changed or is not approved. Review, approve and recalculate first.");
    let fields: { label: string; value: unknown }[];
    try {
      const parsed = JSON.parse(doc.extractedData ?? "{}");
      if (!Array.isArray(parsed.fields) || parsed.fields.some((field: unknown) =>
        !field || typeof field !== "object" || typeof (field as {label?: unknown}).label !== "string")) {
        return fail("Dividend extraction fields are malformed. Review the certificate again.");
      }
      fields = parsed.fields;
    } catch {
      return fail("Dividend extraction is unreadable. Review the certificate again.");
    }
    const amounts = dividendAmountsFromExtraction(fields);
    const problem = validateDividendCertificateAmounts(amounts);
    if (problem) return fail(problem);
    if ((doc.dividendSubcategory ?? (selected.length === 1 ? selected[0] : null)) === "mutual-fund-proportional") {
      const portions = dividendProportionsFromExtraction(fields);
      if (portions.debtPortion === null || portions.equityPortion === null ||
          !Number.isFinite(portions.debtPortion) || !Number.isFinite(portions.equityPortion) ||
          portions.debtPortion < 0 || portions.equityPortion < 0 ||
          Math.round(portions.debtPortion * 100) + Math.round(portions.equityPortion * 100) !== Math.round((amounts.grossAmount as number) * 100)) {
        return fail("Each mutual-fund certificate must print non-negative debt and equity portions equal to certified gross before packet generation.");
      }
    }
    certificates.push({
      documentId: doc.id,
      subcategory: doc.dividendSubcategory,
      grossAmount: amounts.grossAmount as number,
      taxWithheld: amounts.taxWithheld as number,
    });
  }
  const plan = buildDividendFinalTaxPlan({certificates, selectedSubcategories: selected});
  if (plan.kind !== "rows") return fail(plan.kind === "gap" ? plan.reason : "No proven dividend row exists.");
  if (plan.manualNotes?.length) return fail(plan.manualNotes.map((note) => note.reason).join(" "));
  // Executable IRIS cells are whole rupees. Until a reviewed fractional-rupee
  // policy exists, refuse instead of rounding each row differently from totals.
  if (plan.rows.some(row => !Number.isSafeInteger(row.grossAmount) || !Number.isSafeInteger(row.taxWithheld))) {
    return fail("Dividend portal rows require whole-rupee amounts within the safe integer range. Fractional certificate totals need a reviewed rounding policy before automatic entry.");
  }
  const agentFields = buildDividendTaxDeductionAgentFields(plan);
  if (agentFields.length !== plan.rows.length) return fail("A dividend row has no captured editable-cell contract. Automatic entry is blocked.");
  const category = (value: string | null) => String(value ?? "").trim().toUpperCase().replace(/[\s-]+/g, "_");
  const money = (value: unknown) => Number(String(value ?? "").replace(/,/g, ""));
  if (params.ledgerEntries.some((entry) => !Number.isFinite(money(entry.amount)))) return fail("A ledger amount is invalid.");
  if (params.ledgerEntries.some((entry) => entry.entryType === "EXPENSE" && category(entry.category) === "TAX_PAYMENT" && money(entry.amount) > 0)) {
    return fail("Separate tax-payment debits need reviewed attribution; the certificate withholding must not be credited or expensed twice.");
  }
  if (params.ledgerEntries.some((entry) => entry.entryType === "INCOME" && !["DIVIDEND", "DIVIDENDS"].includes(category(entry.category)) && money(entry.amount) > 0)) {
    return fail("A dividend-only packet contains other income. Untested income combinations remain blocked.");
  }
  const grossAmount = sumMoney(certificates.map((cert) => cert.grossAmount));
  const taxWithheld = sumMoney(certificates.map((cert) => cert.taxWithheld));
  if (!Number.isSafeInteger(grossAmount) || !Number.isSafeInteger(taxWithheld)) return fail("Dividend aggregate amounts exceed the safe whole-rupee range.");
  const netBankCredits = sumMoney(params.ledgerEntries.filter((entry) => entry.entryType === "INCOME" && ["DIVIDEND", "DIVIDENDS"].includes(category(entry.category))).map((entry) => money(entry.amount)));
  if (Math.abs(sumMoney([grossAmount, -taxWithheld, -netBankCredits])) > 0.01) {
    return fail("Dividend gross minus actual certificate withholding does not equal classified net bank credits. Resolve the evidence mismatch; no balancing figure will be invented.");
  }
  return {
    ok: true as const,
    certificates,
    plan,
    agentFields,
    grossAmount,
    taxWithheld,
    netBankCredits,
    evidenceFingerprint: dividendEvidenceFingerprint(params.documents, selected),
    wealth: {
      finalTaxIncome: { irisCode: "7033", expected: Math.round(grossAmount), readOnly: true as const },
      taxOutflow: { irisCode: "7098", section: "150", amount: Math.round(taxWithheld) },
      netBankCredits,
    },
  };
}
