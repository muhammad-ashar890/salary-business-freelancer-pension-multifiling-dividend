/** Phase 0, review-only. No tax rates, tax computation, ledger or portal writes.
 * A successful check is NOT authority to calculate, Map, or dispatch a packet.
 */
export type CapitalGainsReviewRow = {
  id: string;
  evidenceReference: string;
  acquiredOn: string;
  disposedOn: string;
  costOfAcquisition: unknown;
  saleValue: unknown;
  taxDeducted: unknown;
};

/** Exact nonnegative PKR to paisa. Blank/rounded/malformed evidence is refused. */
export function parseCapitalGainsPaisa(value: unknown): number | null {
  if (typeof value !== "string" && typeof value !== "number") return null;
  if (typeof value === "number" && !Number.isSafeInteger(value)) return null;
  const text = String(value).trim();
  if (!/^(?:\d+|\d{1,3}(?:,\d{3})+)(?:\.\d{1,2})?$/.test(text)) return null;
  const [whole, fraction = ""] = text.replace(/,/g, "").split(".");
  const paisa = BigInt(whole) * BigInt(100) + BigInt(fraction.padEnd(2, "0"));
  return paisa <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(paisa) : null;
}

function isoDate(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

export function reviewCapitalGainsDisposals(input: {
  taxYear: number;
  rows: readonly CapitalGainsReviewRow[];
}) {
  const problems: string[] = [];
  const previews: {id: string; proceedsPaisa: number; costPaisa: number; arithmeticGainPaisa: number; withholdingPaisa: number}[] = [];
  const seen = new Set<string>();
  if (input.taxYear !== 2026) problems.push("Only the TY2026 review contract has been scoped.");
  if (!Array.isArray(input.rows) || !input.rows.length) problems.push("Itemised disposal evidence is required; a bank credit is not a gain.");
  for (const row of Array.isArray(input.rows) ? input.rows : []) {
    const prefix = typeof row?.id === "string" && row.id.trim() ? row.id : "unidentified row";
    if (!row || typeof row.id !== "string" || !row.id.trim() || seen.has(row.id)) {
      problems.push(`${prefix}: unique disposal ID required.`); continue;
    }
    seen.add(row.id);
    const start = problems.length;
    if (typeof row.evidenceReference !== "string" || !row.evidenceReference.trim()) problems.push(`${prefix}: evidence reference required.`);
    const datesValid = isoDate(row.acquiredOn) && isoDate(row.disposedOn);
    if (!datesValid || row.acquiredOn > row.disposedOn) problems.push(`${prefix}: valid ordered acquisition/disposal dates required.`);
    if (datesValid && (row.disposedOn < "2025-07-01" || row.disposedOn > "2026-06-30")) problems.push(`${prefix}: disposal is outside TY2026.`);
    const cost = parseCapitalGainsPaisa(row.costOfAcquisition), sale = parseCapitalGainsPaisa(row.saleValue), tax = parseCapitalGainsPaisa(row.taxDeducted);
    if (cost === null || sale === null || tax === null) problems.push(`${prefix}: explicit cost, proceeds and actual withholding (including explicit zero) required in exact PKR.`);
    if (start === problems.length && cost !== null && sale !== null && tax !== null) previews.push({id: row.id, proceedsPaisa: sale, costPaisa: cost, arithmeticGainPaisa: sale - cost, withholdingPaisa: tax});
  }
  return {
    reviewReady: problems.length === 0,
    productionEnabled: false as const,
    packetEligible: false as const,
    problems,
    previews: problems.length ? [] : previews,
    notice: "Arithmetic review only. Section, instrument, ownership, approval, exemptions, losses, rates and portal mapping remain unverified. Never treat sale proceeds as taxable gain.",
  };
}
