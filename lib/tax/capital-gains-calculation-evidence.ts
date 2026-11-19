import { validateCapitalGainsApprovedEvidence } from "./capital-gains-approved-evidence";

/** Selective donor integration: only the debt-security route already supported
 * by A's calculator is active here. Other donor plans are refused, not coerced.
 */
export function resolveCapitalGainsCalculationEvidence(input: {
  userId: string; filingDraftId: string; taxYear: number; filerType: string;
  taxpayerCnic: string; incomeSources: string[]; selectedSubcategories: string[];
  documents: {id: string; extractionStatus: string; extractedData: string | null}[];
  ledgerEntries: {entryType: string; category: string; amount: unknown}[];
}) {
  const fail = (reason: string) => ({ok:false as const,reason});
  if (input.incomeSources.length !== 1 || input.incomeSources[0] !== "capital_gains") return fail("Capital Gains calculation currently supports CG-only filings; mixed sources remain blocked.");
  if (input.selectedSubcategories.length !== 1 || input.selectedSubcategories[0] !== "certain-debt-securities") return fail("Select the existing certain-debt-securities category. Other CG calculator routes are not integrated yet.");
  if (input.documents.length !== 1) return fail("Exactly one reviewed CG statement is supported until multi-statement overlap checks are integrated.");
  const document = input.documents[0];
  if (document.extractionStatus !== "MAPPED") return fail("Review and approve/map the current CG statement before calculation.");
  let payload: any;
  try { payload = JSON.parse(document.extractedData || "{}"); } catch { return fail("CG statement payload is invalid."); }
  const checked = validateCapitalGainsApprovedEvidence({userId:input.userId,filingDraftId:input.filingDraftId,documentId:document.id,taxpayerCnic:input.taxpayerCnic,taxYear:input.taxYear,filerType:input.filerType,fields:payload?.fields || []},payload?.approvedCapitalGainsEvidence);
  if (checked.ok === false) return fail(checked.reason);
  const sources = checked.evidence.plan.incomeSources;
  if (sources.length !== 1 || sources[0].route !== "capital_gains" || sources[0].subcategory !== "certain-debt-securities") return fail("This reviewed statement needs a donor calculator route that is not integrated yet; it cannot use the debt-security default.");
  const grossGain = sources[0].income;
  if (!Number.isSafeInteger(grossGain) || grossGain <= 0 || checked.evidence.actualWithholdingPaisa % 100 !== 0) return fail("CG calculation currently requires positive whole-PKR gain and whole-PKR actual withholding.");
  // No independent CG bank-income/TAX_PAYMENT authority while no explicit
  // transaction-to-disposal link exists. Reject rather than deducting all tax.
  if (input.ledgerEntries.some(row => {
    const category = String(row.category || "").trim().toUpperCase();
    const amount = Number(row.amount);
    return !Number.isFinite(amount) || ((row.entryType === "INCOME" && category !== "ASSET_SALE_PROCEEDS") || category === "TAX_PAYMENT") && amount !== 0;
  })) return fail("CG-only calculation refuses separate income or TAX_PAYMENT ledger entries; resolve the evidence link before claiming income or withholding twice.");
  return {ok:true as const,grossGain,taxWithheld:checked.evidence.actualWithholdingPaisa/100,evidenceFingerprint:checked.evidence.fingerprint};
}
