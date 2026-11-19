import { prisma } from "@/lib/prisma";
import { approvedPreviousReturnFromDocuments, previousReturnCnicMismatch } from "./previous-return-fields";

/** Bind optional Previous Return to both dedicated Other Sources routes.
 * Closing wealth becomes opening wealth, NEVER current-year income.
 */
export function buildOtherSourcesPreviousReturn(documents: any[], taxYear: number, taxpayerCnic: unknown) {
  const fail = (reason: string) => ({ok:false as const,reason});
  const previous = documents.filter(document => document.documentType === "previous_return");
  if (!previous.length) return {ok:true as const,expectation:null,carryForward:null};
  if (previous.length !== 1) return fail("Resolve duplicate Previous Return documents before approving this Other Sources packet.");
  const approved = approvedPreviousReturnFromDocuments(previous,taxYear);
  if (!approved || approved.taxYear >= taxYear) return fail("Previous Return must be mapped, complete and for the an earlier filed tax year.");
  const cnic = String(taxpayerCnic ?? "").replace(/[ -]/g,"");
  if (!/^\d{13}$/.test(cnic) || previousReturnCnicMismatch(approved,cnic)) return fail("Previous Return must match the current taxpayer CNIC.");
  return {ok:true as const,expectation:{irisCode:"703002",expected:approved.netAssets,previousReturnTaxYear:approved.taxYear,source:"approved_previous_return_703001"},
    carryForward:approved.wealthRows.length ? {previousReturnTaxYear:approved.taxYear,totalAssets:approved.totalAssets,totalLiabilities:approved.totalLiabilities,netAssets:approved.netAssets,cashInHand:approved.cashInHand,rows:approved.wealthRows.map(row=>({code:row.code,description:row.description,amount:row.amount,detail:row.detail}))} : null};
}

/** Current, owner-scoped reread for pinned packets and transaction persistence. */
export async function otherSourcesPreviousReturnValidationError(snapshot:any,filingDraftId:string,userId:string,database:any=prisma):Promise<string|null> {
  const documents = await database.document.findMany({where:{filingDraftId,userId,documentType:"previous_return"},orderBy:[{createdAt:"desc"},{id:"desc"}],select:{documentType:true,extractionStatus:true,extractedData:true}});
  const profile = documents.some((document:any)=>document.documentType === "previous_return")
    ? await database.user.findUnique({where:{id:userId},select:{cnic:true}}) : null;
  const current = buildOtherSourcesPreviousReturn(documents,Number(snapshot?.filing?.taxYear),profile?.cnic);
  if (current.ok === false) return current.reason;
  const same=(a:any,b:any)=>JSON.stringify(a ?? null)===JSON.stringify(b ?? null);
  if (!same(current.expectation,snapshot?.wealthExpectations?.previousYearNetAssets)||!same(current.carryForward,snapshot?.wealthCarryForward))
    return "Previous Return changed after this Dividend/Bank Profit packet was built. Review and approve a fresh packet.";
  return null;
}
