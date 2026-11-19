import { otherSourcesPreviousReturnValidationError } from "./other-sources-previous-return";
import { prisma } from "@/lib/prisma";
import { buildDividendPacketEvidence } from "./dividend-packet-evidence";

function sources(value: unknown): string[] | null {
  try {
    const parsed = typeof value === "string" ? JSON.parse(value) : value;
    return Array.isArray(parsed) && parsed.every(item => typeof item === "string") ? parsed : null;
  } catch { return null; }
}

/** Re-read current evidence before serving any pinned Dividend packet. Never repairs it. */
export async function dividendPacketValidationError(snapshot: any, filingDraftId: string, userId: string): Promise<string | null> {
  const draft = await prisma.filingDraft.findFirst({
    where: { id: filingDraftId, userId },
    select: { taxYear: true, filerType: true, incomeSources: true, taxCalculationRevision: true, packetApprovalConfirmed: true },
  });
  if (!draft) return "Filing draft not found for this packet.";
  const liveSources = sources(draft.incomeSources);
  const packetSources = sources(snapshot?.filing?.incomeSources);
  const envelope = snapshot?.otherSources?.taxDeductions;
  if (!liveSources?.includes("dividend") && !packetSources?.includes("dividend") && !envelope) return null;
  const fail = "Dividend packet evidence or calculation changed. Recalculate and approve a fresh packet before continuing.";
  if (draft.taxYear !== 2026 || draft.filerType !== "myself" || liveSources?.length !== 1 || liveSources[0] !== "dividend" || packetSources?.length !== 1 || packetSources[0] !== "dividend") return fail;
  if (snapshot?.filing?.taxYear !== draft.taxYear || snapshot?.filing?.filerType !== draft.filerType || !draft.packetApprovalConfirmed || !draft.taxCalculationRevision || snapshot?.filing?.taxCalculationRevision !== draft.taxCalculationRevision || envelope?.version !== "dividend-final-tax-v1") return fail;
  const [documents, selections, ledgerEntries, lines] = await Promise.all([
    prisma.document.findMany({ where: { filingDraftId, userId, documentType: "dividend_certificate" }, select: { id: true, extractedData: true, dividendSubcategory: true, extractionStatus: true } }),
    prisma.filingIncomeSelection.findMany({ where: { filingDraftId, userId, source: "dividend", status: "SELECTED" }, select: { subcategory: true } }),
    prisma.ledgerEntry.findMany({ where: { filingDraftId, userId }, select: { entryType: true, category: true, amount: true } }),
    prisma.filingTaxCalculationLine.findMany({ where: { filingDraftId, userId, calculationRevision: draft.taxCalculationRevision }, select: { source: true, taxBase: true, detailsJson: true } }),
  ]);
  const proof = buildDividendPacketEvidence({ documents, selectedSubcategories: selections.map(row => row.subcategory), ledgerEntries });
  if (proof.ok === false) return proof.reason;
  if (envelope.evidenceFingerprint !== proof.evidenceFingerprint || JSON.stringify(envelope.agentFields) !== JSON.stringify(proof.agentFields) || JSON.stringify(envelope.wealth) !== JSON.stringify(proof.wealth)) return fail;
  const dividendLines = lines.filter(line => line.source === "dividend");
  if (!dividendLines.length || dividendLines.some(line => !Number.isFinite(Number(line.taxBase))) || dividendLines.some(line => {
    try { return JSON.parse(line.detailsJson).dividendEvidenceFingerprint !== proof.evidenceFingerprint; } catch { return true; }
  }) || Math.abs(dividendLines.reduce((sum, line) => sum + Number(line.taxBase), 0) - proof.grossAmount) > 0.01) return fail;
  const map = snapshot?.portalFieldMapDetailed ?? snapshot?.portalFieldMap;
  const outflows = (Array.isArray(map) ? map.filter(row => row.sourceGroup === "wealthFields") : map?.wealthFields ?? []).filter((row: any) => String(row.irisCode) === "7098");
  if (proof.taxWithheld > 0 ? outflows.length !== 1 || outflows[0].rowDescriptionIncludes !== "Income tax deducted u/s 150" || Number(outflows[0].ourAmount ?? outflows[0].value) !== proof.taxWithheld : outflows.length !== 0) return fail;
  return otherSourcesPreviousReturnValidationError(snapshot,filingDraftId,userId);
}
