import { createHash } from "node:crypto";
import { reviewCapitalGainsDisposals, type CapitalGainsReviewRow } from "./capital-gains-preflight";

/** Isolated review evidence only. Callers must obtain all ownership/approval
 * facts from trusted current storage; this helper does not authenticate them.
 * Not imported by upload, calculation, packet or Electron paths.
 */
export type CapitalGainsReviewDocument = {
  id: string;
  userId: string;
  filingDraftId: string;
  taxYear: number;
  documentType: string;
  revision: string;
  approvedRevision: string | null;
  status: string;
  rows: readonly CapitalGainsReviewRow[];
};
export function buildCapitalGainsReviewEvidence(input: {
  userId: string;
  filingDraftId: string;
  taxYear: number;
  documents: readonly CapitalGainsReviewDocument[];
}) {
  const fail = (reason: string) => ({ok: false as const, reason, packetEligible: false as const, productionEnabled: false as const});
  if (!input.userId?.trim() || !input.filingDraftId?.trim() || input.taxYear !== 2026)
    return fail("A bound owner, filing and TY2026 are required.");
  if (!Array.isArray(input.documents) || !input.documents.length)
    return fail("Current reviewed CGT statements are required.");
  const seen = new Set<string>();
  const records: {documentId: string; revision: string; rows: {id: string; evidenceReference: string; acquiredOn: string; disposedOn: string; costPaisa: number; proceedsPaisa: number; withholdingPaisa: number}[]}[] = [];
  for (const doc of input.documents) {
    if (!doc || typeof doc.id !== "string" || !doc.id.trim() || seen.has(doc.id)) return fail("Missing or duplicate document ID.");
    seen.add(doc.id);
    if (doc.userId !== input.userId || doc.filingDraftId !== input.filingDraftId || doc.taxYear !== input.taxYear || doc.documentType !== "cgt_statement")
      return fail("Statement owner, filing, year or document type does not match.");
    if (doc.status !== "REVIEWED" || typeof doc.revision !== "string" || !doc.revision.trim() || doc.approvedRevision !== doc.revision)
      return fail("Current statement revision needs explicit review approval.");
    const review = reviewCapitalGainsDisposals({taxYear: input.taxYear, rows: doc.rows});
    if (!review.reviewReady) return fail(review.problems.join(" "));
    const byId = new Map<string, CapitalGainsReviewRow>(doc.rows.map(row => [row.id, row] as [string, CapitalGainsReviewRow]));
    records.push({documentId: doc.id, revision: doc.revision, rows: review.previews.map(row => {
      const source = byId.get(row.id)!;
      return {id: row.id, evidenceReference: source.evidenceReference, acquiredOn: source.acquiredOn, disposedOn: source.disposedOn, costPaisa: row.costPaisa, proceedsPaisa: row.proceedsPaisa, withholdingPaisa: row.withholdingPaisa};
    }).sort((a,b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0)});
  }
  records.sort((a,b) => a.documentId < b.documentId ? -1 : a.documentId > b.documentId ? 1 : 0);
  const canonical = {version: "capital-gains-review-only-v1", userId: input.userId, filingDraftId: input.filingDraftId, taxYear: input.taxYear, records};
  return {ok: true as const, fingerprint: createHash("sha256").update(JSON.stringify(canonical)).digest("hex"), documentCount: records.length, packetEligible: false as const, productionEnabled: false as const};
}
