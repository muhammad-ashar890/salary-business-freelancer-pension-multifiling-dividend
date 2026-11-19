import { otherSourcesPreviousReturnValidationError } from "./other-sources-previous-return";
import { prisma } from "@/lib/prisma";
import { buildBankProfitPacketPlan } from "./bank-profit-packet";

function sources(value:unknown): string[] {
  try { const parsed = typeof value === "string" ? JSON.parse(value) : value; return Array.isArray(parsed) ? parsed.map(String) : []; } catch { return []; }
}

/** Current owner-scoped evidence check before serving or dispatching a pinned packet. */
export async function bankProfitPacketValidationError(snapshot:any,filingDraftId:string,userId:string):Promise<string|null> {
  const draft = await prisma.filingDraft.findFirst({where:{id:filingDraftId,userId},select:{taxYear:true,filerType:true,incomeSources:true,taxCalculationRevision:true,taxWithheld:true,packetApprovalConfirmed:true}});
  if (!draft) return "Filing draft not found for this packet.";
  const liveSources = sources(draft.incomeSources), packetSources = sources(snapshot?.filing?.incomeSources);
  const envelope = snapshot?.otherSources?.bankProfit;
  if (!liveSources.includes("bank_profit") && !packetSources.includes("bank_profit") && !envelope) return null;
  const fail = "Bank Profit packet evidence or calculation changed. Recalculate and approve a fresh packet before desktop entry.";
  if (!draft.packetApprovalConfirmed || !draft.taxCalculationRevision || draft.taxCalculationRevision !== snapshot?.filing?.taxCalculationRevision || draft.taxYear !== snapshot?.filing?.taxYear || draft.filerType !== snapshot?.filing?.filerType || JSON.stringify(liveSources) !== JSON.stringify(packetSources) || !envelope) return fail;
  const [user,documents,selections,ledgerEntries,calculationLines,credits] = await Promise.all([
    prisma.user.findUnique({where:{id:userId},select:{cnic:true}}),
    prisma.document.findMany({where:{filingDraftId,userId,documentType:"bank_certificate"},select:{id:true,extractionStatus:true,extractedData:true,bankProfitSubcategory:true}}),
    prisma.filingIncomeSelection.findMany({where:{filingDraftId,userId,source:"bank_profit",status:"SELECTED"},select:{subcategory:true}}),
    prisma.ledgerEntry.findMany({where:{filingDraftId,userId},select:{entryType:true,category:true,amount:true}}),
    prisma.filingTaxCalculationLine.findMany({where:{filingDraftId,userId,calculationRevision:draft.taxCalculationRevision},select:{source:true,subcategory:true,taxBase:true,calculatedTax:true,detailsJson:true}}),
    prisma.filingTaxCredit.findMany({where:{filingDraftId,userId},select:{amount:true}}),
  ]);
  if (credits.some(credit=>Number(credit.amount)>0)) return fail;
  const result = buildBankProfitPacketPlan({taxYear:draft.taxYear,filerType:draft.filerType,incomeSources:liveSources,taxpayerCnic:user?.cnic,documents,selectedSubcategories:selections.map(row=>row.subcategory),ledgerEntries,calculationRevision:draft.taxCalculationRevision,calculationLines,storedTaxWithheld:draft.taxWithheld});
  if (result.ok === false) return result.reason;
  if (JSON.stringify(envelope) !== JSON.stringify(result.plan)) return fail;
  const map = snapshot.portalFieldMapDetailed ?? snapshot.portalFieldMap;
  const outflows = (Array.isArray(map) ? map.filter(row=>row.sourceGroup === "wealthFields") : map?.wealthFields ?? []).filter((row:any)=>String(row.irisCode)==="7098");
  if (result.proof.taxWithheld > 0 ? outflows.length !== 1 || outflows[0].rowDescriptionIncludes !== "Income tax deducted u/s 151" || Number(outflows[0].ourAmount ?? outflows[0].value) !== result.proof.taxWithheld : outflows.length !== 0) return fail;
  return otherSourcesPreviousReturnValidationError(snapshot,filingDraftId,userId);
}
