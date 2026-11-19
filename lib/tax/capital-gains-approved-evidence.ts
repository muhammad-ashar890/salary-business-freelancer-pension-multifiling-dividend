import { createHash } from "node:crypto";
import { getCapitalGainsReviewErrors } from "./capital-gains-document-review";
import { capitalGainsFieldKind } from "./capital-gains-source";
import { evaluateCapitalGainsDocument } from "./capital-gains-source";
import { planCapitalGainsEngineInput } from "./capital-gains-route";
import { parseCapitalGainsPaisa } from "./capital-gains-preflight";

type Field = {label?: unknown; value?: unknown};
export type CapitalGainsEvidenceContext = {
  userId: string;
  filingDraftId: string;
  documentId: string;
  taxpayerCnic: string;
  taxYear: number;
  filerType: string;
  fields: Field[];
};
const normalizeCnic = (value: unknown) => String(value ?? "").replace(/[ -]/g, "");
/** Internal adapter, not a user-authorisation boundary. Context/profile must
 * come from current owner-scoped storage. No tax rules added or overridden.
 */
export function buildCapitalGainsApprovedEvidence(context: CapitalGainsEvidenceContext) {
  const fail = (reason: string) => ({ok: false as const, reason});
  if (!context.userId?.trim() || !context.filingDraftId?.trim() || !context.documentId?.trim() || context.taxYear !== 2026 || context.filerType !== "myself") return fail("Capital Gains evidence requires a bound TY2026 Myself filing.");
  const errors = getCapitalGainsReviewErrors(context.fields, context.taxYear);
  if (errors.length) return fail(errors.join(" "));
  const printedCnic = context.fields.find(field => String(field.label).trim().toLowerCase().replace(/[^a-z0-9]+/g,"_") === "taxpayer_cnic")?.value;
  const cnic = normalizeCnic(context.taxpayerCnic);
  if (!/^\d{13}$/.test(cnic) || normalizeCnic(printedCnic) !== cnic) return fail("Capital Gains statement does not match the current taxpayer CNIC.");
  const evaluated = evaluateCapitalGainsDocument({fields: context.fields, reviewStatus: "APPROVED"});
  const plan = planCapitalGainsEngineInput(evaluated);
  if (!plan.ok) return fail(plan.blockedReason || plan.refusals.map(refusal => refusal.reason).join(" ") || "The whole CG statement must be supported by the donor plan.");
  let withholdingPaisa = 0;
  for (const field of context.fields.filter(field => capitalGainsFieldKind(field.label) === "taxDeducted")) {
    const amount = parseCapitalGainsPaisa(field.value);
    if (amount === null || !Number.isSafeInteger(withholdingPaisa + amount)) return fail("Actual Capital Gains withholding is missing or exceeds the exact amount range.");
    withholdingPaisa += amount;
  }
  const bound = {version: "capital-gains-approved-evidence-v1" as const, userId: context.userId, filingDraftId: context.filingDraftId, documentId: context.documentId, taxpayerCnic: cnic, taxYear: context.taxYear, filerType: context.filerType,
    // Retain exactly the reviewed field order and values; edits require reapproval.
    fields: context.fields.map(field => ({label: field.label, value: field.value})), plan, actualWithholdingPaisa: withholdingPaisa};
  const fingerprint = createHash("sha256").update(JSON.stringify(bound)).digest("hex");
  return {ok: true as const, evidence: {...bound, fingerprint}, packetEligible: false as const};
}

/** Rebuild, don't trust stored incomeSources, withheld tax or a field-only stamp.
 * Caller must separately require MAPPED/current approval in trusted storage.
 */
export function validateCapitalGainsApprovedEvidence(context: CapitalGainsEvidenceContext, stored: unknown) {
  const current = buildCapitalGainsApprovedEvidence(context);
  if (!current.ok) return current;
  if (!stored || JSON.stringify(stored) !== JSON.stringify(current.evidence)) return {ok: false as const, reason: "Capital Gains approval changed or is stale. Review and approve the current evidence again."};
  return current;
}
