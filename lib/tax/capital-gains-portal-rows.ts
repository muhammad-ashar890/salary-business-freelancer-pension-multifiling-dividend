/**
 * Capital gains → IRIS 114(1) "Capital Gain" sheet, row by row.
 *
 * The derivation already produces the figures in the sheet's own shape
 * (`CapitalGainsSummary`). This file turns them into **fill instructions** —
 * the ordered list of `(row code, cell, value)` an IRIS filler can execute —
 * so that work is testable without a running portal, and so the packet layer
 * never has to re-derive which cell a figure belongs in.
 *
 * What is deliberately NOT here:
 *
 *  - **Totals.** 4000 (Total Capital Gain/(Loss)), 4041, 4043, 999916 and
 *    999917 are IRIS-computed summary rows on the captured sheet. Writing
 *    them would fight the form.
 *  - **The gain column of a s.37 row and the tax-chargeable column.** IRIS
 *    computes both from the cells beside them (`cg_assets_sel.html` marks them
 *    disabled).
 *  - **Gold and Motor Vehicle.** Their four cells are all disabled, so a
 *    taxable figure on them is reported as unplaceable instead of being
 *    written into a row the form will not accept.
 *  - **Section 37(1A) property (4042 / 64220050).** IRIS only shows that row
 *    once the property exists in the 116 Wealth Statement, so it is never
 *    produced from a disposal statement.
 */

import type { CapitalGainsSummary } from "./capital-gains-derivation";
import {
  CAPITAL_ASSET_TYPES,
  CAPITAL_GAINS_SECTION_CODES,
  SECURITIES_GAIN_BUCKETS,
} from "./capital-gains-fields";

export type CapitalGainsPortalCell = {
  /** 0-based position in the row's cell order, as the sheet renders it. */
  columnIndex: number;
  column: string;
  value: number;
};

export type CapitalGainsPortalRow = {
  area: "Capital Gain" | "Tax Deductions";
  code: string;
  label: string;
  /** Row order inside the area, for a filler that works top to bottom. */
  order: number;
  cells: CapitalGainsPortalCell[];
};

export type CapitalGainsSkippedRow = {
  code: string;
  label: string;
  value: number;
  reason: string;
};

export type CapitalGainsPortalPlan = {
  rows: CapitalGainsPortalRow[];
  /** Figures the packet must not write, with the reason. */
  skipped: CapitalGainsSkippedRow[];
  /** Rows that must be entered by hand on the portal. */
  manualEntry: string[];
};

/** Cell order shared by every s.37 asset row on the captured sheet. */
const ASSET_37_COLUMNS = [
  "Cost of Acquisition",
  "Sale / Transfer Value",
  "Exempt",
  "Capital Gain / Loss",
] as const;

/** Cell order shared by every s.37A Final Tax bucket row. */
const SECURITIES_37A_COLUMNS = [
  "Taxable Amount / Capital Gain / Loss",
  "Tax Deducted",
  "Tax Chargeable",
] as const;

/**
 * Builds the fill plan. Every figure the caller can see on the statement ends
 * up either in `rows` (writable) or in `skipped` (with the reason) — nothing
 * is dropped silently.
 */
export function buildCapitalGainsPortalPlan(
  summary: CapitalGainsSummary,
): CapitalGainsPortalPlan {
  const rows: CapitalGainsPortalRow[] = [];
  const skipped: CapitalGainsSkippedRow[] = [];
  const manualEntry: string[] = [];
  let order = 0;

  // --- Section 37 (capital assets) ---------------------------------------
  for (const total of summary.rows) {
    if (total.source !== "capital_assets_37") continue;
    const type = CAPITAL_ASSET_TYPES.find((entry) => entry.code === total.code);
    if (!type) {
      skipped.push({
        code: total.code,
        label: total.label,
        value: total.taxableGain,
        reason: "This row is not one of the eight capital-asset types the captured sheet shows.",
      });
      continue;
    }
    if (!type.enterable) {
      if (
        total.costOfAcquisition !== 0 ||
        total.saleValue !== 0 ||
        total.exemptGain !== 0
      ) {
        skipped.push({
          code: total.code,
          label: type.label,
          value: total.taxableGain,
          reason:
            "Every cell of this row is IRIS-computed on the captured sheet, so the packet cannot write the figures. Enter them by hand on the portal.",
        });
        manualEntry.push(`${total.code} ${type.label}`);
      }
      continue;
    }
    // The gain column is computed by IRIS from the three before it.
    rows.push({
      area: "Capital Gain",
      code: total.code,
      label: type.label,
      order: order++,
      cells: [
        { columnIndex: 0, column: ASSET_37_COLUMNS[0], value: total.costOfAcquisition },
        { columnIndex: 1, column: ASSET_37_COLUMNS[1], value: total.saleValue },
        { columnIndex: 2, column: ASSET_37_COLUMNS[2], value: total.exemptGain },
      ],
    });
  }

  // --- Section 37A (securities) ------------------------------------------
  // Buckets arrive in sheet order, so the filler writes them top to bottom.
  for (const bucket of summary.securitiesBuckets) {
    const definition = SECURITIES_GAIN_BUCKETS.find((entry) => entry.code === bucket.code);
    if (!definition) {
      skipped.push({
        code: bucket.code,
        label: bucket.code,
        value: bucket.taxableGain,
        reason: "This s.37A row is not one of the ten rate buckets on the captured sheet.",
      });
      continue;
    }
    rows.push({
      // Captured evidence (`td_final_sel.html`): the ten s.37A buckets are
      // children of the Final Tax section under Tax Deductions, NOT rows of the
      // Capital Gain sheet. Section 4043 on that sheet is a computed summary.
      area: "Tax Deductions",
      code: bucket.code,
      label: definition.label,
      order: order++,
      cells: [
        {
          columnIndex: 0,
          column: SECURITIES_37A_COLUMNS[0],
          value: bucket.taxableGain,
        },
        { columnIndex: 1, column: SECURITIES_37A_COLUMNS[1], value: bucket.taxDeducted },
      ],
    });
  }

  // --- What this plan can never contain ----------------------------------
  if (summary.property.requiresWealthStatement) {
    skipped.push({
      code: summary.property.finalTaxCode,
      label: "Capital Gain u/s 37(1A) — immovable property",
      value: 0,
      reason:
        `IRIS only shows this row once the property is in the 116 Wealth Statement. ` +
        `Add the property there; the sheet row ${CAPITAL_GAINS_SECTION_CODES.property37_1A} and its Final Tax row ` +
        `${summary.property.finalTaxCode} then fill from it.`,
    });
  }
  if (summary.debtSecurities.disposalIds.length > 0) {
    skipped.push({
      code: "",
      label: "Gain on certain debt securities (Section 151A)",
      value: summary.debtSecurities.grossGain,
      reason:
        "A s.151A debt-security gain is not one of the ten s.37A rate buckets on this sheet. " +
        "It is priced at 15%/30% on the Tax Deductions side and is reported through the Final Tax rows, not here.",
    });
  }

  return { rows, skipped, manualEntry };
}

/** One-line summary for logs and the review screen. */
export function describeCapitalGainsPortalPlan(plan: CapitalGainsPortalPlan): string {
  const cells = plan.rows.reduce((total, row) => total + row.cells.length, 0);
  const manual = plan.manualEntry.length > 0 ? ` ${plan.manualEntry.length} row(s) need manual entry.` : "";
  return (
    `${plan.rows.length} row(s), ${cells} cell(s) ready for the Capital Gain sheet; ` +
    `${plan.skipped.length} figure(s) deliberately not written.${manual}`
  );
}
