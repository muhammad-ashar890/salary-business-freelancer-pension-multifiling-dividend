/**
 * Capital gains — disposal rows in, IRIS 114(1) shape out.
 *
 * This is the bridge the module never had. A broker/bank statement gives one
 * line per disposal; the IRIS Capital Gain sheet wants either one aggregate
 * row per s.37 asset type or one Final Tax row per s.37A rate bucket. Nothing
 * in the app converted one into the other, which is why the document was
 * uploaded and then ignored.
 *
 * Three rules are taken from the live captures and enforced here:
 *
 *  1. A security sold **through NCCPL/PSX** is a s.37A item, not a s.37 item.
 *     That is why the s.37 sheet only offers "Shares … sold outside the
 *     preview of NCCPL / PSX".
 *  2. The s.37 sheet holds **one row per asset type**, so several disposals of
 *     the same type are summed before filing.
 *  3. Gold (64340111) and Motor Vehicle (64340218) have no enterable cell, so
 *     their figures can never be written by the packet even when known.
 *
 * Anything this file cannot place is returned as an explicit problem — never
 * priced into a row by guess.
 */

import {
  CAPITAL_ASSET_TYPES,
  type CapitalAssetTypeKey,
  getCapitalAssetType,
  getSecuritiesGainBucket,
  SECURITIES_GAIN_BUCKETS,
} from "./capital-gains-fields";
import {
  resolveSecuritiesCapitalGainsBand,
  securitiesSubcategoryForInstrument,
} from "./capital-gains-rates";

// ---------------------------------------------------------------------------
// Input
// ---------------------------------------------------------------------------

/** Why a security's gain sits in one Final Tax bucket rather than another. */
export type CapitalGainsInstrumentKind =
  | "listed-share"
  | "mutual-fund-or-reit"
  | "stock-fund"
  | "other-than-stock-fund"
  | "pmex-cash-settled"
  /**
   * A debt instrument (TFC, corporate bond, sukuk, DSC, PIB …). Its gain is a
   * Section 151A item priced at 15%/30% of the gross gain, and it is NOT one
   * of the s.37A Final Tax buckets on the 114(1) sheet — those are equity and
   * fund disposals.
   */
  | "debt-security";

export type CapitalGainsDisposal = {
  /** Stable id of the source row (statement page/line). */
  id: string;
  /** Fixed-point money as a number of rupees; the caller rounds later. */
  costOfAcquisition: number;
  saleValue: number;
  /** Printed exemption, if any. Never inferred from the rate. */
  exemptGain?: number;
  /** Tax already deducted at source and evidenced on the statement. */
  taxDeducted?: number;
  /** ISO date (YYYY-MM-DD). */
  acquiredOn: string | null;
  /** ISO date (YYYY-MM-DD). */
  disposedOn: string | null;
  /** Which s.37 asset row this disposal belongs to, when it is a s.37 item. */
  assetType?: CapitalAssetTypeKey | null;
  /** True only when the statement itself shows the sale went through NCCPL/PSX. */
  soldThroughNccplOrPsx?: boolean;
  instrumentKind?: CapitalGainsInstrumentKind | null;
  description?: string | null;
  evidenceReference?: string | null;
};

// ---------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------

export type CapitalGainsRowTotal = {
  source: "capital_assets_37" | "securities_37A";
  /** IRIS code this total is written to. */
  code: string;
  label: string;
  costOfAcquisition: number;
  saleValue: number;
  exemptGain: number;
  /** saleValue - costOfAcquisition; can be negative. */
  gain: number;
  /** gain - exemptGain, never below zero. */
  taxableGain: number;
  taxDeducted: number;
  /** False for Gold / Motor Vehicle: known, but not writable on this sheet. */
  enterable: boolean;
  disposalIds: readonly string[];
};

export type CapitalGainsProblem =
  | { kind: "missing_disposal_date"; disposalId: string; field: "acquiredOn" | "disposedOn" }
  | { kind: "disposal_before_acquisition"; disposalId: string }
  | { kind: "negative_amount"; disposalId: string; field: "costOfAcquisition" | "saleValue" }
  | { kind: "exempt_exceeds_gain"; disposalId: string }
  | { kind: "unknown_asset_type"; disposalId: string }
  | { kind: "security_without_rate_bucket"; disposalId: string; candidates: readonly string[] }
  | { kind: "unsupported_instrument_bucket"; disposalId: string; bucket: string };

export type CapitalGainsSummary = {
  rows: readonly CapitalGainsRowTotal[];
  problems: readonly CapitalGainsProblem[];
  /** What IRIS will roll up into 4000 Total Capital Gain/(Loss). */
  totals: {
    costOfAcquisition: number;
    saleValue: number;
    exemptGain: number;
    gain: number;
    taxableGain: number;
    taxDeducted: number;
  };
  /**
   * s.37(1A) cannot be produced here: its row is fed by the 116 Wealth
   * Statement property list and the capture refuses any other route.
   */
  property: {
    requiresWealthStatement: true;
    summaryCode: "4042";
    finalTaxCode: "64220050";
  };
  /** Buckets that ended up with a figure, in sheet order. */
  securitiesBuckets: readonly { code: string; taxableGain: number; taxDeducted: number }[];
  /**
   * Section 151A debt securities. These do not appear on the 114(1) Capital
   * Gain sheet's s.37A rows, so they are totalled separately and priced by the
   * 151A route.
   */
  debtSecurities: {
    grossGain: number;
    taxDeducted: number;
    disposalIds: readonly string[];
  };
};

const DAY = 86_400_000;

function toDate(iso: string | null | undefined): number | null {
  if (!iso) return null;
  const t = Date.parse(`${iso}T00:00:00Z`);
  return Number.isNaN(t) ? null : t;
}

const money = (value: number | undefined) => (Number.isFinite(value) ? Number(value) : 0);

// ---------------------------------------------------------------------------
// Which section does a disposal belong to?
//
// A security sold through the exchange is s.37A. Everything else with a s.37
// asset type is s.37. A disposal that is neither is a problem, not a guess.
// ---------------------------------------------------------------------------

export type CapitalGainsSection =
  | "capital_assets_37"
  | "securities_37A"
  | "debt_securities_151A"
  /**
   * Section 37(1A) immovable property. It never comes from the disposal
   * statement (IRIS only opens 4042 / 64220050 from the 116 Wealth Statement),
   * so this section exists for the figures the wealth statement declares.
   */
  | "property_37_1A";

export function resolveCapitalGainsSection(
  disposal: CapitalGainsDisposal,
): CapitalGainsSection | null {
  // Debt securities are priced by Section 151A at the withholding stage, not
  // by a s.37A vintage bucket, so they are routed out before anything else.
  if (disposal.instrumentKind === "debt-security") return "debt_securities_151A";
  if (disposal.soldThroughNccplOrPsx === true) return "securities_37A";
  if (disposal.assetType && getCapitalAssetType(disposal.assetType)) {
    return "capital_assets_37";
  }
  if (disposal.instrumentKind) return "securities_37A";
  return null;
}

// ---------------------------------------------------------------------------
// s.37A bucket selection
//
// Four buckets are date-driven (0%, 12.5%, 10%, 15%). The rest are priced by
// instrument, not by acquisition date, so they are never date-derived: the
// caller must name the instrument kind and the bucket must match it.
//
// The 15% band is ambiguous on the sheet — 64220156 "@15%" and 64220158
// "Securities / Mutual Funds / Collective Schemes / REIT @15%". The label
// difference is the only evidence, so a fund/REIT goes to 64220158, a plain
// listed share to 64220156, and an unclassified security returns both
// candidates for review instead of picking one.
// ---------------------------------------------------------------------------

export type SecuritiesBucketResolution =
  | { status: "RESOLVED"; code: string; reason: string }
  | { status: "NEEDS_REVIEW"; candidates: readonly string[]; reason: string };

export function resolveSecuritiesBucket(
  disposal: CapitalGainsDisposal,
): SecuritiesBucketResolution | null {
  const kind = disposal.instrumentKind ?? null;
  const subcategory =
    securitiesSubcategoryForInstrument(kind) ??
    (disposal.soldThroughNccplOrPsx === true ? "securities-listed-37a" : null);
  if (!subcategory) return null;

  // The rate band lives in one place — `capital-gains-rates.ts` — so the sheet
  // row and the price the calculator charges can never disagree. The bands are
  // Division VII, Part I, First Schedule: an acquisition-date vintage, and for
  // the 2022–2024 vintage a holding-period taper.
  const resolved = resolveSecuritiesCapitalGainsBand({
    subcategory,
    acquiredOn: disposal.acquiredOn,
    disposedOn: disposal.disposedOn,
    instrumentKind: kind,
  });
  if ("error" in resolved) {
    return {
      status: "NEEDS_REVIEW",
      candidates:
        subcategory === "funds-37a" ? ["64220161", "64220159"] : ["64220156", "64220158"],
      reason: resolved.error,
    };
  }
  return {
    status: "RESOLVED",
    code: resolved.band.irisCode,
    reason: `${resolved.band.label} — ${resolved.band.ratePercent}% (held ${resolved.holdingYears} year(s)).`,
  };
}

// ---------------------------------------------------------------------------
// Per-disposal validation
// ---------------------------------------------------------------------------

export function listDisposalProblems(
  disposal: CapitalGainsDisposal,
): CapitalGainsProblem[] {
  const problems: CapitalGainsProblem[] = [];
  const cost = money(disposal.costOfAcquisition);
  const sale = money(disposal.saleValue);
  const exempt = money(disposal.exemptGain);
  const gain = sale - cost;

  if (cost < 0) {
    problems.push({ kind: "negative_amount", disposalId: disposal.id, field: "costOfAcquisition" });
  }
  if (sale < 0) {
    problems.push({ kind: "negative_amount", disposalId: disposal.id, field: "saleValue" });
  }
  if (!disposal.acquiredOn) {
    problems.push({ kind: "missing_disposal_date", disposalId: disposal.id, field: "acquiredOn" });
  }
  if (!disposal.disposedOn) {
    problems.push({ kind: "missing_disposal_date", disposalId: disposal.id, field: "disposedOn" });
  }

  const acquired = toDate(disposal.acquiredOn);
  const disposed = toDate(disposal.disposedOn);
  if (acquired !== null && disposed !== null && disposed < acquired) {
    problems.push({ kind: "disposal_before_acquisition", disposalId: disposal.id });
  }
  if (exempt > 0 && exempt > gain) {
    problems.push({ kind: "exempt_exceeds_gain", disposalId: disposal.id });
  }

  const section = resolveCapitalGainsSection(disposal);
  if (section === null) {
    problems.push({ kind: "unknown_asset_type", disposalId: disposal.id });
  } else if (section === "securities_37A") {
    const bucket = resolveSecuritiesBucket(disposal);
    if (bucket === null) {
      problems.push({
        kind: "missing_disposal_date",
        disposalId: disposal.id,
        field: "acquiredOn",
      });
    } else if (bucket.status === "NEEDS_REVIEW") {
      problems.push({
        kind: "security_without_rate_bucket",
        disposalId: disposal.id,
        candidates: bucket.candidates,
      });
    }
  }

  return problems;
}

// ---------------------------------------------------------------------------
// Aggregation into the IRIS rows
// ---------------------------------------------------------------------------

function emptyRow(
  code: string,
  label: string,
  enterable: boolean,
  source: "capital_assets_37" | "securities_37A",
): CapitalGainsRowTotal {
  return {
    source,
    code,
    label,
    costOfAcquisition: 0,
    saleValue: 0,
    exemptGain: 0,
    gain: 0,
    taxableGain: 0,
    taxDeducted: 0,
    enterable,
    disposalIds: [],
  };
}

/**
 * Aggregates disposals into the rows the captured sheet actually has.
 *
 * A disposal that produced any problem is deliberately left out of the money
 * totals: an unreviewed row must not inflate a figure that the packet would
 * then write into IRIS.
 */
export function deriveCapitalGainsSummary(
  disposals: readonly CapitalGainsDisposal[],
): CapitalGainsSummary {
  const problems: CapitalGainsProblem[] = [];
  const rows = new Map<string, CapitalGainsRowTotal>();
  const debtSecurities = { grossGain: 0, taxDeducted: 0, disposalIds: [] as string[] };

  for (const disposal of disposals) {
    const disposalProblems = listDisposalProblems(disposal);
    if (disposalProblems.length > 0) {
      problems.push(...disposalProblems);
      continue;
    }

    const section = resolveCapitalGainsSection(disposal);
    if (section === null) continue;

    const cost = money(disposal.costOfAcquisition);
    const sale = money(disposal.saleValue);
    const exempt = money(disposal.exemptGain);
    const tax = money(disposal.taxDeducted);

    if (section === "debt_securities_151A") {
      debtSecurities.grossGain += sale - cost;
      debtSecurities.taxDeducted += tax;
      debtSecurities.disposalIds.push(disposal.id);
      continue;
    }

    if (section === "capital_assets_37") {
      const type = getCapitalAssetType(disposal.assetType as string);
      if (!type) continue;
      const key = type.code;
      const row =
        rows.get(key) ?? emptyRow(type.code, type.label, type.enterable, "capital_assets_37");
      row.costOfAcquisition += cost;
      row.saleValue += sale;
      row.exemptGain += exempt;
      row.taxDeducted += tax;
      (row.disposalIds as string[]).push(disposal.id);
      rows.set(key, row);
      continue;
    }

    const bucket = resolveSecuritiesBucket(disposal);
    if (!bucket || bucket.status !== "RESOLVED") continue;
    const definition = getSecuritiesGainBucket(bucket.code);
    if (!definition) continue;
    const row =
      rows.get(bucket.code) || emptyRow(definition.code, definition.label, true, "securities_37A");
    // The 37A Final Tax grid wants the taxable gain, not cost and sale.
    row.saleValue += sale;
    row.costOfAcquisition += cost;
    row.exemptGain += exempt;
    row.taxDeducted += tax;
    (row.disposalIds as string[]).push(disposal.id);
    rows.set(bucket.code, row);
  }

  const ordered = [...rows.values()].map((row) => {
    const gain = row.saleValue - row.costOfAcquisition;
    const taxableGain = Math.max(0, gain - row.exemptGain);
    return { ...row, gain, taxableGain };
  });

  // Sheet order: the eight s.37 rows first, then the 37A buckets in sheet order.
  const assetOrder = new Map(CAPITAL_ASSET_TYPES.map((type, index) => [type.code, index]));
  const bucketOrder = new Map(SECURITIES_GAIN_BUCKETS.map((bucket, index) => [bucket.code, index]));
  ordered.sort((a, b) => {
    if (a.source !== b.source) return a.source === "capital_assets_37" ? -1 : 1;
    const order = a.source === "capital_assets_37" ? assetOrder : bucketOrder;
    return (order.get(a.code) ?? 99) - (order.get(b.code) ?? 99);
  });

  const totals = ordered.reduce(
    (sum, row) => ({
      costOfAcquisition: sum.costOfAcquisition + row.costOfAcquisition,
      saleValue: sum.saleValue + row.saleValue,
      exemptGain: sum.exemptGain + row.exemptGain,
      gain: sum.gain + row.gain,
      taxableGain: sum.taxableGain + row.taxableGain,
      taxDeducted: sum.taxDeducted + row.taxDeducted,
    }),
    {
      costOfAcquisition: 0,
      saleValue: 0,
      exemptGain: 0,
      gain: 0,
      taxableGain: 0,
      taxDeducted: 0,
    },
  );

  return {
    rows: ordered,
    problems,
    totals,
    property: {
      requiresWealthStatement: true,
      summaryCode: "4042",
      finalTaxCode: "64220050",
    },
    securitiesBuckets: ordered
      .filter((row) => row.source === "securities_37A")
      .map((row) => ({
        code: row.code,
        taxableGain: row.taxableGain,
        taxDeducted: row.taxDeducted,
      })),
    debtSecurities,
  };
}

/** Holding period in whole days, for the LT/ST split a s.37A rate may need. */
export function holdingPeriodDays(
  acquiredOn: string | null,
  disposedOn: string | null,
): number | null {
  const acquired = toDate(acquiredOn);
  const disposed = toDate(disposedOn);
  if (acquired === null || disposed === null) return null;
  return Math.round((disposed - acquired) / DAY);
}

/** True when the instrument was held for more than twelve months. */
export function isLongTerm(acquiredOn: string | null, disposedOn: string | null): boolean | null {
  const days = holdingPeriodDays(acquiredOn, disposedOn);
  if (days === null) return null;
  return days > 365;
}
