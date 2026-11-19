/**
 * Capital gains — from the approved statement to the calculator.
 *
 * The engine has one catalogued capital-gains rule: §151A, 15% of the gross
 * gain for an ATL filer and 30% for a non-ATL filer (FBR withholding rate
 * card, page 4). This file is the bridge between the statement and that rule,
 * and it is deliberately narrow:
 *
 *   - Debt instruments (TFC, bond, sukuk, DSC, PIB …) produce a priced
 *     `capital_gains` source plus the tax the payer already deducted.
 *   - §37A equity/fund disposals and §37 capital assets are REFUSED here.
 *     Their rates are not in the withholding card and are not catalogued as
 *     rules yet: §37A runs on acquisition-vintage bands (0% before Jul-2013,
 *     12.5% for 2013–2022, 10% for 2022–2024, 15% from Jul-2024, with no
 *     deduction once a pre-Jul-2024 holding passes six years) and §37 for an
 *     individual or AOP is charged at the normal slab. Pricing either from a
 *     row label would be a guess dressed up as a number.
 *
 * A filing with any refused section stays blocked, exactly like the packet
 * gate today: the priced part must never stand in for the whole return.
 */

import {
  resolveCapitalGainsSection,
  type CapitalGainsSection,
  type CapitalGainsSummary,
} from "./capital-gains-derivation";
import {
  evaluateCapitalGainsDocument,
  type CapitalGainsDocumentEvaluation,
} from "./capital-gains-source";
import { buildCapitalGainsPortalPlan } from "./capital-gains-portal-rows";
import {
  isIsoDate,
  resolvePropertyCapitalGainsBand,
  resolveSecuritiesCapitalGainsBand,
  securitiesSubcategoryForInstrument,
  type PropertyKind,
  type SecuritiesCapitalGainsBand,
} from "./capital-gains-rates";

export type CapitalGainsEngineSource = {
  /**
   * `capital_gains` is the flat s.151A / s.37A route (final tax);
   * `capital_assets_37` is a s.37 gain, which joins the normal slab.
   */
  route: "capital_gains" | "capital_assets_37" | "capital_gains_property";
  income: number;
  /** Absent on `capital_assets_37`: the s.37 route has one slab table. */
  subcategory?: string;
  /**
   * Section 37A only: the dates and the instrument the rate depends on. They
   * travel with the line because the engine resolves the rate band from them —
   * the taxpayer never picks a rate by hand.
   */
  attributes?: {
    acquisitionDate?: string;
    disposalDate?: string;
    instrumentKind?: string;
    /** Section 37(1A): the flat/plot/constructed distinction the rate needs. */
    propertyKind?: string;
  };
};

/** One priced disposal, kept for the audit trail and the review screen. */
export type CapitalGainsPricedLine = {
  section: CapitalGainsSection;
  disposalId: string;
  label: string;
  gain: number;
  ratePercent: number;
  ruleId: string | null;
  /** The 114(1) row this figure is reported on, when one exists. */
  irisCode: string | null;
  basis: string;
};

export type CapitalGainsRefusal = {
  section: CapitalGainsSection;
  /** IRIS rows whose figures could not be priced. */
  irisCodes: readonly string[];
  reason: string;
};

export type CapitalGainsEnginePlan = {
  /** True only when the whole statement was priced. */
  ok: boolean;
  /** What the calculator can price today. */
  incomeSources: CapitalGainsEngineSource[];
  /** The same lines with their rates, for display and audit. */
  lines: CapitalGainsPricedLine[];
  /** §151A tax already deducted, as printed on the statement. */
  taxWithheld: number;
  refusals: CapitalGainsRefusal[];
  notes: string[];
  /** Present when the statement itself is not usable yet. */
  blockedReason: string | null;
};

/** The approval stamp stored on the document's extracted payload. */
export type ApprovedCapitalGainsStatement = {
  ok: boolean;
  incomeSources: CapitalGainsEngineSource[];
  lines: CapitalGainsPricedLine[];
  taxWithheld: number;
  refusals: CapitalGainsRefusal[];
  notes: string[];
  approvedAt: string;
  /**
   * What the 114(1) Capital Gain sheet will be filled with. Computed at
   * approval time so the review screen can show it before a packet exists.
   */
  portal: {
    rows: number;
    cells: number;
    manualEntry: string[];
  };
  /**
   * The exact reviewed fields, so a later edit invalidates the approval
   * instead of letting unreviewed figures into the calculation.
   */
  fieldSignature: string;
};

function fieldPart(value: unknown): string {
  return typeof value === "string" ? value : value === null || value === undefined ? "" : String(value);
}

/** A stable fingerprint of the reviewed fields (order-preserving). */
export function capitalGainsFieldsSignature(
  fields: readonly { label?: unknown; value?: unknown }[],
): string {
  return JSON.stringify(
    fields.map((field) => [fieldPart(field?.label), fieldPart(field?.value)]),
  );
}

/**
 * Stamps an approved statement with what the calculator will use. The stamp
 * travels with the field signature: editing a figure after approval drops the
 * stamp's validity, so the operator has to approve again.
 */
export function approveCapitalGainsStatement(
  fields: readonly { label?: unknown; value?: unknown }[],
): { stamp: ApprovedCapitalGainsStatement | null; error: string | null } {
  const evaluation = evaluateCapitalGainsDocument({ fields, reviewStatus: "APPROVED" });
  if (evaluation.ok !== true) {
    return {
      stamp: null,
      error:
        evaluation.errors[0] ??
        "The capital gains statement is not complete, so it cannot be approved.",
    };
  }
  const plan = planCapitalGainsEngineInput(evaluation);
  const portal = evaluation.summary
    ? buildCapitalGainsPortalPlan(evaluation.summary)
    : { rows: [], skipped: [], manualEntry: [] };
  return {
    error: null,
    stamp: {
      ok: plan.ok,
      incomeSources: plan.incomeSources,
      lines: plan.lines,
      taxWithheld: plan.taxWithheld,
      refusals: plan.refusals,
      notes: plan.notes,
      approvedAt: new Date().toISOString(),
      fieldSignature: capitalGainsFieldsSignature(fields),
      portal: {
        rows: portal.rows.length,
        cells: portal.rows.reduce((total, row) => total + row.cells.length, 0),
        manualEntry: portal.manualEntry,
      },
    },
  };
}

/**
 * Reads the stamp back. Returns null when the document was never approved or
 * its figures changed after approval — never a partial or stale plan.
 */
export function readApprovedCapitalGainsStatement(
  payload: unknown,
): ApprovedCapitalGainsStatement | null {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;
  const record = payload as Record<string, unknown>;
  const stamp = record.approvedCapitalGainsStatement;
  if (!stamp || typeof stamp !== "object" || Array.isArray(stamp)) return null;
  const fields = Array.isArray(record.fields)
    ? (record.fields as { label?: unknown; value?: unknown }[])
    : [];
  const stored = stamp as ApprovedCapitalGainsStatement;
  if (typeof stored.fieldSignature !== "string") return null;
  if (stored.fieldSignature !== capitalGainsFieldsSignature(fields)) return null;
  return stored;
}

/**
 * Builds the calculator input from an evaluated CGT statement.
 */
export function planCapitalGainsEngineInput(
  evaluation: CapitalGainsDocumentEvaluation,
): CapitalGainsEnginePlan {
  const empty = {
    ok: false,
    incomeSources: [] as CapitalGainsEngineSource[],
    lines: [] as CapitalGainsPricedLine[],
    taxWithheld: 0,
    refusals: [] as CapitalGainsRefusal[],
    notes: [] as string[],
  };

  if (!evaluation.ok || !evaluation.summary) {
    return {
      ...empty,
      blockedReason:
        evaluation.errors[0] ??
        "The capital gains statement is not ready: it must be approved and complete before it is priced.",
    };
  }

  const summary: CapitalGainsSummary = evaluation.summary;
  const refusals: CapitalGainsRefusal[] = [];
  const incomeSources: CapitalGainsEngineSource[] = [];
  const lines: CapitalGainsPricedLine[] = [];
  const notes: string[] = [];
  let taxWithheld = 0;

  // --- §151A debt securities: the one catalogued rule ---------------------
  if (summary.debtSecurities.disposalIds.length > 0) {
    if (summary.debtSecurities.grossGain > 0) {
      incomeSources.push({
        route: "capital_gains",
        income: summary.debtSecurities.grossGain,
        subcategory: "certain-debt-securities",
      });
      taxWithheld = summary.debtSecurities.taxDeducted;
      lines.push({
        section: "debt_securities_151A",
        disposalId: summary.debtSecurities.disposalIds[0] ?? "",
        label: "Certain debt securities",
        gain: summary.debtSecurities.grossGain,
        ratePercent: 15,
        ruleId: "TY2026-151A-DEBT-SECURITY-GAIN",
        irisCode: null,
        basis:
          "Section 151A: 15% of the gross gain for an ATL filer, 30% for a non-ATL filer (FBR rate card page 4).",
      });
      notes.push(
        "Debt-security gain is priced at 15% of the gross gain (ATL) or 30% (non-ATL) under §151A; the tax printed on the statement is claimed as a credit.",
      );
    } else if (summary.debtSecurities.grossGain < 0) {
      refusals.push({
        section: "debt_securities_151A",
        irisCodes: [],
        reason:
          "A loss on debt securities cannot be priced by the 15%/30% §151A charge. Loss set-off and carry-forward are not catalogued, so this statement has to be reviewed by a practitioner.",
      });
    }
  }

  // --- §37A securities: netted inside the block, then priced per band -----
  // Section 37A charges the gain of the securities block, and a loss inside
  // the same block reduces it before any rate applies (a loss left over is
  // carried forward for three years). Netting is therefore done here, band by
  // band: every disposal that resolved to the same rate band is summed with
  // its losses before the band is priced.
  //
  // Netting ACROSS bands is refused. The law nets the block, but the sheet
  // charges each band separately, and how a loss in one band reduces the gain
  // in another is an allocation decision this module will not invent.
  type SecuritiesGroup = {
    band: SecuritiesCapitalGainsBand;
    subcategory: string;
    gain: number;
    loss: number;
    attributes?: CapitalGainsEngineSource["attributes"];
    disposals: { id: string; label: string; gain: number }[];
  };
  const groups = new Map<string, SecuritiesGroup>();

  for (const disposal of evaluation.disposals) {
    const section = resolveCapitalGainsSection(disposal);
    if (section !== "securities_37A") continue;

    const gain = disposal.saleValue - disposal.costOfAcquisition;
    const label = disposal.description || disposal.assetType || "security";
    const subcategory = securitiesSubcategoryForInstrument(disposal.instrumentKind);
    if (!subcategory) {
      refusals.push({
        section: "securities_37A",
        irisCodes: [],
        reason:
          `"${label}" was sold through the exchange but the statement does not say what was sold, and the 114(1) sheet has separate rows for listed shares, funds and PMEX contracts. ` +
          "Name the instrument on the statement before it is priced.",
      });
      continue;
    }

    const resolved = resolveSecuritiesCapitalGainsBand({
      subcategory,
      acquiredOn: disposal.acquiredOn,
      disposedOn: disposal.disposedOn,
      instrumentKind: disposal.instrumentKind,
    });
    if ("error" in resolved) {
      refusals.push({
        section: "securities_37A",
        irisCodes: [],
        reason: `"${label}": ${resolved.error}`,
      });
      continue;
    }

    const key = `${subcategory}\u0000${resolved.band.ruleId}`;
    const existing = groups.get(key);
    const attributes = {
      ...(disposal.acquiredOn ? { acquisitionDate: disposal.acquiredOn } : {}),
      ...(disposal.disposedOn ? { disposalDate: disposal.disposedOn } : {}),
      ...(disposal.instrumentKind ? { instrumentKind: disposal.instrumentKind } : {}),
    };
    if (existing) {
      if (gain > 0) existing.gain += gain;
      else existing.loss += -gain;
      existing.disposals.push({ id: disposal.id, label, gain });
      continue;
    }
    groups.set(key, {
      band: resolved.band,
      subcategory,
      gain: gain > 0 ? gain : 0,
      loss: gain > 0 ? 0 : -gain,
      attributes,
      disposals: [{ id: disposal.id, label, gain }],
    });
  }

  // A group that carries both a gain and a loss nets them itself, so the
  // refusal is about two DIFFERENT bands: one band ends in a loss while
  // another ends in a gain.
  const netOf = (group: SecuritiesGroup) => group.gain - group.loss;
  const netGainGroups = Array.from(groups.values()).filter((group) => netOf(group) > 0);
  const netLossGroups = Array.from(groups.values()).filter((group) => netOf(group) < 0);
  const mixedBands = netGainGroups.length > 0 && netLossGroups.length > 0;
  if (mixedBands) {
    refusals.push({
      section: "securities_37A",
      irisCodes: netGainGroups.map((group) => group.band.irisCode),
      reason:
        "This statement has a loss in one Section 37A rate band and a gain in another. The block is netted in law, but the 114(1) sheet charges each band on its own row, " +
        "and how the loss is allocated across bands is not catalogued — the statement has to be reviewed by a practitioner before it is priced.",
    });
  }

  for (const group of groups.values()) {
    const net = group.gain - group.loss;
    if (net <= 0) {
      // Nothing to tax in this band. The loss is carried forward, not priced.
      notes.push(
        `No gain is priced in the ${group.band.ratePercent}% band: the net figure there is a loss of PKR ${Math.round(group.loss - group.gain).toLocaleString()}. ` +
          "A Section 37A loss is carried forward for three tax years and set against later securities gains; the carried amount is not entered here.",
      );
      continue;
    }
    if (mixedBands) continue;

    incomeSources.push({
      route: "capital_gains",
      income: net,
      subcategory: group.subcategory,
      ...(group.attributes ? { attributes: group.attributes } : {}),
    });
    lines.push({
      section: "securities_37A",
      disposalId: group.disposals[0].id,
      label:
        group.disposals.length > 1
          ? `${group.disposals.length} disposals — ${group.band.label}`
          : group.disposals[0].label,
      gain: net,
      ratePercent: group.band.ratePercent,
      ruleId: group.band.ruleId,
      irisCode: group.band.irisCode,
      basis:
        group.loss > 0
          ? `${group.band.basis} A loss of PKR ${Math.round(group.loss).toLocaleString()} inside the same band has already been netted off this figure.`
          : group.band.basis,
    });
  }
  if (lines.some((line) => line.section === "securities_37A")) {
    notes.push(
      "Each security is priced on its own acquisition vintage and holding period; the statement's dates drive the band, so a corrected acquisition date changes the rate.",
    );
    if (lines.some((line) => line.ruleId === "TY2026-37A-SEC-POST-JUN-2024")) {
      notes.push(
        "For a security acquired on or after 01-Jul-2024 the 15% rate needs the seller on the ATL on the acquisition date as well as the disposal date. Confirm the earlier ATL status.",
      );
    }
  }

  // --- §37 capital assets: assessable income, priced at the normal slab ---
  // IRIS gives s.37 one aggregate row per asset type, and the sheet's "Exempt"
  // column reduces the gain before it is taxed (rows are already netted by
  // the derivation). Gold and Motor Vehicle have no enterable cell on the
  // captured sheet, so a taxable gain on them cannot be filed by the packet
  // even though it is chargeable — that is reported, never hidden.
  const capitalAssetRows = summary.rows.filter((row) => row.source === "capital_assets_37");
  if (capitalAssetRows.length > 0) {
    const unplaceable = capitalAssetRows.filter(
      (row) => !row.enterable && row.taxableGain > 0,
    );
    const lossRows = capitalAssetRows.filter((row) => row.gain < 0);
    const taxableRows = capitalAssetRows.filter(
      (row) => row.enterable && row.taxableGain > 0,
    );
    const taxableTotal = taxableRows.reduce((sum, row) => sum + row.taxableGain, 0);

    if (unplaceable.length > 0) {
      refusals.push({
        section: "capital_assets_37",
        irisCodes: unplaceable.map((row) => row.code),
        reason:
          `${unplaceable.map((row) => row.label).join(", ")} ` +
          "has no enterable cell on the IRIS 114(1) Capital Gain sheet, so a taxable gain on it cannot be placed by the packet " +
          "even though it is chargeable under Section 37. It has to be entered on the portal by hand.",
      });
    }
    if (lossRows.length > 0) {
      refusals.push({
        section: "capital_assets_37",
        irisCodes: lossRows.map((row) => row.code),
        reason:
          "A loss on a capital asset was found. Section 37 losses are set off inside the capital-gains block before the slab is read, " +
          "and that set-off is not catalogued, so this statement has to be reviewed by a practitioner.",
      });
    }
    if (taxableTotal > 0) {
      incomeSources.push({ route: "capital_assets_37", income: taxableTotal });
      for (const row of taxableRows) {
        lines.push({
          section: "capital_assets_37",
          disposalId: row.disposalIds[0] ?? "",
          label: row.label,
          gain: row.taxableGain,
          ratePercent: 0,
          ruleId: null,
          irisCode: row.code,
          basis:
            "Section 37 gain is assessable income, not a flat-rate line: an individual or AOP reads it against the Division I slab, and a company is charged the Division II corporate rate.",
        });
      }
      notes.push(
        "The Section 37 asset gain joins the normal slab with salary, rent and business profit — it is not a final tax, so the rate depends on the rest of the return.",
      );
    }
  }

  // NCCPL/broker deducts the s.37A tax at source and it is the taxpayer's to
  // claim: for an ATL filer the collected amount is the final tax on the gain,
  // so it must leave the return as a credit, not as a second payment.
  const securitiesTaxDeducted = summary.securitiesBuckets.reduce(
    (sum, bucket) => sum + bucket.taxDeducted,
    0,
  );
  if (securitiesTaxDeducted > 0) {
    taxWithheld += securitiesTaxDeducted;
  }
  // A s.37 claim in the "Tax Deducted" column of an asset row (rare, but some
  // statements print one) is credited on the same basis.
  const assetTaxDeducted = summary.rows
    .filter((row) => row.source === "capital_assets_37")
    .reduce((sum, row) => sum + row.taxDeducted, 0);
  if (assetTaxDeducted > 0) {
    taxWithheld += assetTaxDeducted;
    notes.push(
      "Tax printed against a Section 37 asset row is claimed as a credit; the gain itself still joins the normal slab.",
    );
  }

  // --- §37(1A) property never reaches here without the 116 statement -----
  if (summary.property.requiresWealthStatement) {
    notes.push(
      "§37(1A) property gain is not read from this statement: IRIS only accepts the property row once it exists in the 116 Wealth Statement.",
    );
  }

  return {
    ok: refusals.length === 0 && incomeSources.length > 0,
    incomeSources,
    lines,
    taxWithheld,
    refusals,
    notes,
    blockedReason:
      refusals.length === 0 && incomeSources.length === 0
        ? "The statement produced no disposal that this route can price."
        : null,
  };
}

// ---------------------------------------------------------------------------
// Section 37(1A) — immovable property declared through the 116 Wealth Statement
// ---------------------------------------------------------------------------

/**
 * One immovable-property disposal, as the 116 Wealth Statement describes it.
 *
 * The capital-gains statement cannot carry these: IRIS only renders the sheet
 * row (4042) and the Final Tax row (64220050) once the property exists in the
 * Wealth Statement, so the figures are declared separately and priced here.
 */
export type PropertyDisposalInput = {
  id?: string;
  description?: string;
  kind?: PropertyKind | string;
  acquiredOn?: string;
  disposedOn?: string;
  costOfAcquisition?: number;
  saleValue?: number;
  /** Section 236C collected by the buyer's bank, if the statement shows it. */
  taxDeducted?: number;
};

/**
 * Price declared property disposals without placing anything on a sheet.
 *
 * Nothing here is written to the Capital Gain sheet: the 114(1) rows (4042 and
 * 64220050) are fed by the Wealth Statement itself. What this returns is the
 * tax the filing will owe on those gains, so the estimate is not blind to a
 * property sale that the return must declare.
 */
export function planPropertyCapitalGainsInput(input: {
  disposals?: readonly PropertyDisposalInput[];
}): CapitalGainsEnginePlan {
  const incomeSources: CapitalGainsEngineSource[] = [];
  const lines: CapitalGainsPricedLine[] = [];
  const refusals: CapitalGainsRefusal[] = [];
  const notes: string[] = [];
  let taxWithheld = 0;

  const disposals = Array.isArray(input.disposals) ? input.disposals : [];
  for (const [index, disposal] of disposals.entries()) {
    const id = String(disposal?.id || `property-${index + 1}`);
    const label =
      String(disposal?.description || "").trim() ||
      `${String(disposal?.kind || "property")} disposal`;
    const refuse = (reason: string) =>
      refusals.push({
        section: "property_37_1A",
        irisCodes: ["64220050"],
        reason: `"${label}": ${reason}`,
      });

    const cost = Number(disposal?.costOfAcquisition);
    const sale = Number(disposal?.saleValue);
    if (!Number.isFinite(cost) || cost < 0) {
      refuse("the cost of acquisition is missing or is not a rupee figure.");
      continue;
    }
    if (!Number.isFinite(sale) || sale < 0) {
      refuse("the sale consideration is missing or is not a rupee figure.");
      continue;
    }
    if (!isIsoDate(disposal?.acquiredOn) || !isIsoDate(disposal?.disposedOn)) {
      refuse(
        "the acquisition and disposal dates are needed (YYYY-MM-DD): the Section 37(1A) rate depends on the acquisition vintage and the holding period.",
      );
      continue;
    }
    const gain = sale - cost;
    if (!(gain > 0)) {
      refuse(
        `sale consideration ${sale.toLocaleString()} against cost ${cost.toLocaleString()} is not a gain. A Section 37(1A) loss is not set off here; the return has to be prepared with that in view.`,
      );
      continue;
    }

    const resolved = resolvePropertyCapitalGainsBand({
      kind: disposal?.kind,
      acquiredOn: disposal?.acquiredOn,
      disposedOn: disposal?.disposedOn,
    });
    if ("error" in resolved) {
      refuse(resolved.error);
      continue;
    }

    const deducted = Number(disposal?.taxDeducted);
    if (Number.isFinite(deducted) && deducted > 0) taxWithheld += deducted;

    incomeSources.push({
      route: "capital_gains_property",
      income: gain,
      attributes: {
        acquisitionDate: String(disposal?.acquiredOn),
        disposalDate: String(disposal?.disposedOn),
        propertyKind: String(disposal?.kind),
      },
    });
    lines.push({
      section: "property_37_1A",
      disposalId: id,
      label,
      gain,
      ratePercent: resolved.band.ratePercent,
      ruleId: resolved.band.ruleId,
      irisCode: resolved.band.irisCode,
      basis: `${resolved.band.basis} Held ${resolved.holdingYears} completed year(s).`,
    });
  }

  if (lines.length > 0) {
    notes.push(
      "Immovable property is placed by the 116 Wealth Statement, not by this packet: IRIS opens row 4042 and Final Tax row 64220050 from the property in the wealth statement. The figures above are priced so the estimate includes the gain.",
    );
  }
  if (taxWithheld > 0) {
    notes.push(
      "Section 236C tax collected on the property transfer is claimed as a credit.",
    );
  }

  return {
    ok: refusals.length === 0,
    incomeSources,
    lines,
    taxWithheld,
    refusals,
    notes,
    blockedReason: null,
  };
}
