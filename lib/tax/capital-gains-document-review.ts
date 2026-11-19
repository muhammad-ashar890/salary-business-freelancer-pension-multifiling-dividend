import { CAPITAL_GAINS_DISPOSAL_FIELDS } from "./capital-gains-fields";
import { capitalGainsFieldKind, capitalGainsRowNumber, getCapitalGainsDocumentReviewErrors, parseCapitalGainsDate } from "./capital-gains-source";
import { parseCapitalGainsPaisa } from "./capital-gains-preflight";

type Field = {label?: unknown; value?: unknown; confidence?: unknown};
const norm = (value: unknown) => String(value ?? "").trim().toLowerCase().replace(/[^a-z0-9]+/g,"_");
const metadata = ["Tax Year", "Currency", "Taxpayer CNIC"];
const requiredKinds = new Set(["assetType", "assetDescription", "acquiredOn", "disposedOn", "costOfAcquisition", "saleValue", "taxDeducted", "evidenceReference"]);
export function isCapitalGainsReviewFieldRequired(label: unknown) {
  return metadata.some(item => norm(item) === norm(label)) || requiredKinds.has(capitalGainsFieldKind(label));
}
export function ensureCapitalGainsReviewFields(raw: unknown): unknown {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return raw;
  const payload = raw as Record<string, unknown>;
  const fields: Field[] = Array.isArray(payload.fields) ? payload.fields.filter(field => field && typeof field === "object" && !Array.isArray(field)).map(field => ({...field})) : [];
  for (const label of metadata) if (!fields.some(field => norm(field.label) === norm(label))) fields.push({label,value:null,confidence:0});
  const numbers = new Set(fields.filter(field => capitalGainsFieldKind(field.label)).map(field => capitalGainsRowNumber(field.label)));
  if (!numbers.size) numbers.add(1);
  for (const number of numbers) for (const definition of CAPITAL_GAINS_DISPOSAL_FIELDS.filter(field => requiredKinds.has(field.kind))) {
    if (!fields.some(field => capitalGainsFieldKind(field.label) === definition.kind && capitalGainsRowNumber(field.label) === number))
      fields.push({label:`${definition.label}${number === 1 ? "" : ` ${number}`}`,value:null,confidence:0});
  }
  return {...payload,fields};
}
/** Review validation only: never derives withholding, marks MAPPED or creates ledger rows. */
export function getCapitalGainsReviewErrors(fields: Field[] | undefined, taxYear?: number): string[] {
  const list = fields ?? [], errors: string[] = [];
  for (const label of metadata) {
    const found = list.filter(field => norm(field.label) === norm(label));
    if (found.length !== 1 || found[0].value === null || found[0].value === undefined || !String(found[0].value).trim()) { errors.push(`Capital Gains: one explicit ${label} is required.`); continue; }
    const value = String(found[0].value).trim();
    if (label === "Tax Year" && (value !== "2026" || (taxYear !== undefined && Number(value) !== taxYear))) errors.push("Capital Gains: statement must match filing TY2026.");
    if (label === "Currency" && value.toUpperCase() !== "PKR") errors.push("Capital Gains: only explicit PKR statements are supported.");
    if (label === "Taxpayer CNIC" && !/^\d{13}$/.test(value.replace(/[ -]/g,""))) errors.push("Capital Gains: an explicit 13-digit taxpayer CNIC is required.");
  }
  const rows = new Map<number, Map<string, Field>>();
  for (const field of list) {
    const kind = capitalGainsFieldKind(field.label); if (!kind) continue;
    const number = capitalGainsRowNumber(field.label), row = rows.get(number) ?? new Map<string, Field>();
    if (row.has(kind)) errors.push(`Capital Gains row ${number}: duplicate ${kind}.`);
    row.set(kind,field); rows.set(number,row);
  }
  if (!rows.size) errors.push("Capital Gains: itemised disposals are required; aggregate proceeds alone are insufficient.");
  for (const [number,row] of rows) {
    for (const kind of requiredKinds) if (!row.has(kind) || row.get(kind)!.value === null || row.get(kind)!.value === undefined || !String(row.get(kind)!.value).trim()) errors.push(`Capital Gains row ${number}: explicit ${kind} required.`);
    for (const kind of ["costOfAcquisition","saleValue","taxDeducted","exemptGain"]) if (row.has(kind) && parseCapitalGainsPaisa(row.get(kind)!.value) === null) errors.push(`Capital Gains row ${number}: ${kind} must be an exact nonnegative printed PKR amount.`);
    const acquired = parseCapitalGainsDate(row.get("acquiredOn")?.value), disposed = parseCapitalGainsDate(row.get("disposedOn")?.value);
    if (!acquired || !disposed || acquired > disposed || disposed < "2025-07-01" || disposed > "2026-06-30") errors.push(`Capital Gains row ${number}: valid ordered dates and a TY2026 disposal are required.`);
  }
  return [...errors,...getCapitalGainsDocumentReviewErrors(list)];
}
