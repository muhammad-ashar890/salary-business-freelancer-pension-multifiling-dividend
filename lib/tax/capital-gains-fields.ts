/**
 * Capital gains — the IRIS 114(1) sheet as captured on 09-Nov-2026.
 *
 * Everything in this file is transcribed from the live captures in
 * `~/uploads` (MHTML -> html):
 *   cg.html                     the Capital Gain tab, nothing added
 *   cg_assets_sel.html          all eight s.37 asset types added
 *   cg_prop_popup.html          "+ Section" on the s.37(1A) row
 *   td.html / td_final_sel.html the Tax Deductions tab, 37A buckets added
 *
 * The shape that matters, and that no earlier code in this repo had:
 *
 *   Tab "Capital Gain on Asset / Property / Securities"
 *     4000  Total Capital Gain/(Loss)              [4 columns, all computed]
 *     4041  s.37  Capital Assets (summary)         [computed]
 *       64340xxx  one row per asset type           [cost / sale / exempt enterable]
 *     4042  s.37(1A) Property (summary)            [computed, fed by the 116
 *                                                   Wealth Statement property list]
 *     4043  s.37A Securities (summary)             [computed, fed by the Tax
 *                                                   Deductions Final Tax rows]
 *
 *   Tab "Tax Deductions"
 *     999916 Final Tax (summary)
 *       64220050  s.37(1A) Capital Gains on Immovable Property  [via + Section]
 *       6422015x  s.37A, one row per acquisition-period rate band
 *     999917 Minimum Tax (summary)
 *       64050050  s.152(1DA) non-resident debt-instrument gains
 *
 * Deliberate correction: the codes previously sitting in
 * `iris-field-codes.ts` for this module (4006/4016/4017/4026/4036/4037) do
 * NOT exist anywhere on the captured 114(1) form. They are not used here and
 * must not be mapped onto this sheet.
 */

/** A positional cell of an IRIS grid row. */
export type CapitalGainsCell = {
  /** IRIS column heading, verbatim from the capture's `.heading-bar`. */
  label: string;
  /**
   * `false` = the operator can type here, `true` = IRIS computes it.
   * Taken from the `disabled` attribute of every `.data-middle-child-wapper
   * input` in the capture, in column order.
   */
  disabled: boolean;
};

/** One IRIS grid row, keyed by its 114(1) system code. */
export type CapitalGainsIrisRow = {
  code: string;
  label: string;
  cells: readonly CapitalGainsCell[];
};

// ---------------------------------------------------------------------------
// 1 — the four summary rows of the Capital Gain tab
// ---------------------------------------------------------------------------

export const CAPITAL_GAINS_SECTION_CODES = {
  totalCapitalGain: "4000",
  capitalAssets37: "4041",
  property37_1A: "4042",
  securities37A: "4043",
} as const;

export const CAPITAL_GAINS_SHEET_SECTIONS = [
  {
    key: "total",
    title: "Capital Gain/(Loss) on Capital Asset / Property / Securities",
    columns: [
      "Total Amount",
      "Subject to Final Tax",
      "Subject to Exemption",
      "Subject to Normal Tax",
    ],
    row: {
      code: "4000",
      label: "Total Capital Gain /(Loss)",
      cells: [
        { label: "Total Amount", disabled: true },
        { label: "Subject to Final Tax", disabled: true },
        { label: "Subject to Exemption", disabled: true },
        { label: "Subject to Normal Tax", disabled: true },
      ],
    } satisfies CapitalGainsIrisRow,
  },
  {
    key: "capital_assets_37",
    title: "Capital Gain u/s 37 (Capital Assets)",
    columns: [
      "Cost of Acquisition",
      "Sale / Transfer Value",
      "Exempt",
      "Capital Gain / Loss",
    ],
    row: {
      code: "4041",
      label: "Capital Gain u/s 37(Capital Assets)",
      cells: [
        { label: "Cost of Acquisition", disabled: true },
        { label: "Sale / Transfer Value", disabled: true },
        { label: "Exempt", disabled: true },
        { label: "Capital Gain / Loss", disabled: true },
      ],
    } satisfies CapitalGainsIrisRow,
  },
  {
    key: "property_37_1a",
    title: "Capital Gain u/s 37(1A) (Property)",
    columns: [
      "Cost of Acquisition",
      "Sale / Transfer Value",
      "Exempt",
      "Capital Gain",
      "Capital Gain / Loss",
      "Tax Chargeable",
    ],
    row: {
      code: "4042",
      label: "Capital Gain u/s 37(1A)(Property)",
      cells: [
        { label: "Cost of Acquisition", disabled: true },
        { label: "Sale / Transfer Value", disabled: true },
        { label: "Exempt", disabled: true },
        { label: "Capital Gain", disabled: true },
        { label: "Capital Gain / Loss", disabled: true },
        { label: "Tax Chargeable", disabled: true },
      ],
    } satisfies CapitalGainsIrisRow,
  },
  {
    key: "securities_37A",
    title: "Capital Gain u/s 37A (Securities)",
    columns: ["Taxable Amount / Capital Gain / Loss", "Tax Deducted", "Tax Chargeable"],
    row: {
      code: "4043",
      label: "Capital Gain u/s 37A (Securities)",
      cells: [
        { label: "Taxable Amount / Capital Gain / Loss", disabled: true },
        { label: "Tax Deducted", disabled: true },
        { label: "Tax Chargeable", disabled: true },
      ],
    } satisfies CapitalGainsIrisRow,
  },
] as const;

// ---------------------------------------------------------------------------
// 2 — s.37 Capital Assets: one row per asset type
//
// The sheet has exactly one row per type. "+ Capital Asset" opens a checkbox
// list of these eight types (capture: cg_assets_popup.html) and the row then
// becomes enterable. There is no per-scrip grid on IRIS, so a disposal-level
// model has to aggregate into these eight rows before filing.
//
// `disabled` per capture (cg_assets_sel.html, all eight added):
//   six types  E E E D  -> cost, sale and exempt are typed; gain is computed
//   Gold       D D D D  -> nothing typeable on this row
//   Motor Vehicle D D D D -> nothing typeable on this row
// Gold and Motor Vehicle being fully computed is asserted by the verify
// script; the reason behind it is still an open question for the analyst and
// is treated as "cannot be written by the packet" until answered.
// ---------------------------------------------------------------------------

export type CapitalAssetTypeKey =
  | "shares-listed-outside-nccpl"
  | "shares-company-outside-nccpl"
  | "jewelry"
  | "coins"
  | "gold"
  | "painting"
  | "motor-vehicle"
  | "others";

export type CapitalAssetType = {
  key: CapitalAssetTypeKey;
  code: string;
  label: string;
  /** Positional cells in IRIS order. */
  cells: readonly CapitalGainsCell[];
  /** False when every cell is IRIS-computed, so the packet must not target it. */
  enterable: boolean;
};

const ENTERABLE_37_CELLS = [
  { label: "Cost of Acquisition", disabled: false },
  { label: "Sale / Transfer Value", disabled: false },
  { label: "Exempt", disabled: false },
  { label: "Capital Gain / Loss", disabled: true },
] as const;

const COMPUTED_37_CELLS = [
  { label: "Cost of Acquisition", disabled: true },
  { label: "Sale / Transfer Value", disabled: true },
  { label: "Exempt", disabled: true },
  { label: "Capital Gain / Loss", disabled: true },
] as const;

export const CAPITAL_ASSET_TYPES: readonly CapitalAssetType[] = [
  {
    key: "shares-listed-outside-nccpl",
    code: "64340217",
    label: "Shares of Listed Company sold outside the preview of NCCPL / PSX",
    cells: ENTERABLE_37_CELLS,
    enterable: true,
  },
  {
    key: "shares-company-outside-nccpl",
    code: "64340216",
    label: "Shares of Company sold outside the preview of NCCPL / PSX",
    cells: ENTERABLE_37_CELLS,
    enterable: true,
  },
  { key: "jewelry", code: "64340213", label: "Jewelry", cells: ENTERABLE_37_CELLS, enterable: true },
  { key: "coins", code: "64340214", label: "Coins", cells: ENTERABLE_37_CELLS, enterable: true },
  { key: "gold", code: "64340111", label: "Gold", cells: COMPUTED_37_CELLS, enterable: false },
  { key: "painting", code: "64340215", label: "Painting", cells: ENTERABLE_37_CELLS, enterable: true },
  {
    key: "motor-vehicle",
    code: "64340218",
    label: "Motor Vehicle",
    cells: COMPUTED_37_CELLS,
    enterable: false,
  },
  { key: "others", code: "64340219", label: "Others", cells: ENTERABLE_37_CELLS, enterable: true },
] as const;

export function getCapitalAssetType(key: string): CapitalAssetType | null {
  return CAPITAL_ASSET_TYPES.find((type) => type.key === key) ?? null;
}

/** "+ Capital Asset" checklist labels, in capture order. */
export const CAPITAL_ASSET_PICKER_LABELS: readonly string[] = CAPITAL_ASSET_TYPES.map(
  (type) => type.label,
);

// ---------------------------------------------------------------------------
// 3 — s.37A Securities: the gain is declared on the Tax Deductions tab
//
// The 37A summary row (4043) is fully computed. The capture's own hint says
// it plainly: "Please add Capital Gain on Securities as Final Income on Tax
// Deduction page". The enterable rows are the Final Tax buckets below, each
// keyed by the rate that applies to the period the security was acquired in.
// ---------------------------------------------------------------------------

export const SECURITIES_FINAL_TAX_SUMMARY_CODE = "999916";

export type SecuritiesGainBucket = {
  code: string;
  label: string;
  /** Percent printed in the row label; null where the label carries none. */
  ratePercent: number | null;
  /** Acquisition window the row is reserved for, when the label states one. */
  acquiredFrom?: string;
  acquiredTo?: string;
  /** True where the row is instrument-specific and cannot be date-derived. */
  requiresInstrumentSelection: boolean;
  cells: readonly CapitalGainsCell[];
};

const SECURITIES_BUCKET_CELLS = [
  { label: "Taxable Amount", disabled: false },
  { label: "Tax Deducted", disabled: false },
  { label: "Tax Chargeable", disabled: true },
] as const;

export const SECURITIES_GAIN_BUCKETS: readonly SecuritiesGainBucket[] = [
  {
    code: "64220151",
    label: "Capital Gains on Securities u/s 37A @0% (where security was acquired prior to July 1, 2013)",
    ratePercent: 0,
    acquiredTo: "2013-06-30",
    requiresInstrumentSelection: false,
    cells: SECURITIES_BUCKET_CELLS,
  },
  {
    code: "64220155",
    label:
      "Capital Gains on Securities u/s 37A @12.5% (where securities acquired between July 01, 2013 to June 30, 2022)",
    ratePercent: 12.5,
    acquiredFrom: "2013-07-01",
    acquiredTo: "2022-06-30",
    requiresInstrumentSelection: false,
    cells: SECURITIES_BUCKET_CELLS,
  },
  {
    code: "64220162",
    label:
      "Capital Gains on Securities u/s 37A @10%(where securities acquired between 1st day of July, 2022 and 30th June, 2024)",
    ratePercent: 10,
    acquiredFrom: "2022-07-01",
    acquiredTo: "2024-06-30",
    requiresInstrumentSelection: false,
    cells: SECURITIES_BUCKET_CELLS,
  },
  {
    code: "64220156",
    label: "Capital Gains on Securities u/s 37A @15%",
    ratePercent: 15,
    acquiredFrom: "2024-07-01",
    requiresInstrumentSelection: false,
    cells: SECURITIES_BUCKET_CELLS,
  },
  {
    code: "64220158",
    label:
      "Capital Gains on Securities / Mutual Funds / Collective Schemes / REIT u/s 37A @15%",
    ratePercent: 15,
    acquiredFrom: "2024-07-01",
    requiresInstrumentSelection: true,
    cells: SECURITIES_BUCKET_CELLS,
  },
  {
    code: "64220161",
    label:
      "Capital Gains on Securities / Mutual Funds / Collective Schemes / REIT (For stock funds) u/s 37A",
    ratePercent: null,
    requiresInstrumentSelection: true,
    cells: SECURITIES_BUCKET_CELLS,
  },
  {
    code: "64220159",
    label:
      "Capital Gains on Securities / Mutual Funds / Collective Schemes / REIT (Other than stock funds) u/s 37A",
    ratePercent: null,
    requiresInstrumentSelection: true,
    cells: SECURITIES_BUCKET_CELLS,
  },
  {
    code: "64220157",
    label: "Capital Gains on Securities u/s 37A @7.5%",
    ratePercent: 7.5,
    requiresInstrumentSelection: true,
    cells: SECURITIES_BUCKET_CELLS,
  },
  {
    code: "64220153",
    label: "Capital Gains on Securities u/s 37A @5% (PMEX/Cash Settled Securities)",
    ratePercent: 5,
    requiresInstrumentSelection: true,
    cells: SECURITIES_BUCKET_CELLS,
  },
  {
    code: "64220152",
    label: "Capital Gains on Securities u/s 37A @2.5%",
    ratePercent: 2.5,
    requiresInstrumentSelection: true,
    cells: SECURITIES_BUCKET_CELLS,
  },
] as const;

export function getSecuritiesGainBucket(code: string): SecuritiesGainBucket | null {
  return SECURITIES_GAIN_BUCKETS.find((bucket) => bucket.code === code) ?? null;
}

// ---------------------------------------------------------------------------
// 4 — s.37(1A) Property: the row is fed by the 116 Wealth Statement
//
// The capture's + Section popup refuses: "Please add through Wealth Statement/
// Immovable Properties". Nothing can be typed on 4042 or 64220050 until the
// property exists in the wealth statement, so this module cannot ship the
// property branch on its own.
// ---------------------------------------------------------------------------

export const PROPERTY_SECTION_CODES = {
  summaryCapitalGainTab: "4042",
  finalTaxRow: "64220050",
  finalTaxSummary: "999916",
} as const;

export const PROPERTY_ROW_REQUIRES_WEALTH_STATEMENT = true;

export const PROPERTY_ROW_CAPTURE_HINT =
  "Please add through Wealth Statement/ Immovable Properties";

// ---------------------------------------------------------------------------
// 5 — non-resident 152(1DA) minimum-tax row (out of Track A scope)
// ---------------------------------------------------------------------------

export const NON_RESIDENT_DEBT_GAIN_ROW = {
  code: "64050050",
  label:
    "Tax Deductible from Non-Residents on Capital Gains on Disposal of Debt Instruments/Goverment Securities/Certificates Invested through FCVA/NRVA u/s 152(1DA) /Division II, Part III,1st Schedule",
  cells: [
    { label: "Taxable Amount", disabled: false },
    { label: "Tax Collected / Deducted", disabled: false },
    { label: "Tax Chargeable", disabled: true },
    { label: "Attributable Taxable Income", disabled: true },
    { label: "Tax on Attributable Taxable Income", disabled: true },
    { label: "Difference of Minimum Tax Chargeable", disabled: true },
  ],
} as const;

// ---------------------------------------------------------------------------
// 6 — what we ask the taxpayer / the extractor for
//
// One disposal = one row on the supporting statement (broker, bank, fund).
// The IRIS sheet aggregates these into the eight s.37 type rows or into the
// 37A rate buckets, which is why the row carries an asset type and dates.
// ---------------------------------------------------------------------------

export const CAPITAL_GAINS_DISPOSAL_LABELS = {
  assetType: "Capital Asset Type",
  assetDescription: "Asset Description / Scrip",
  acquiredOn: "Date of Acquisition",
  disposedOn: "Date of Disposal",
  quantity: "Quantity / Units",
  costOfAcquisition: "Cost of Acquisition (PKR)",
  saleValue: "Sale / Transfer Value (PKR)",
  exemptGain: "Exempt Gain (PKR)",
  taxDeducted: "Tax Deducted (PKR)",
  payerName: "Broker / Payer Name",
  payerNtn: "Broker / Payer NTN",
  evidenceReference: "Evidence Reference",
} as const;

export type CapitalGainsDisposalFieldKind = keyof typeof CAPITAL_GAINS_DISPOSAL_LABELS;

export type CapitalGainsDisposalField = {
  kind: CapitalGainsDisposalFieldKind;
  label: string;
  aliases: readonly string[];
  required: boolean;
  kindOfValue: "text" | "amount" | "date" | "type";
};

export const CAPITAL_GAINS_DISPOSAL_FIELDS: readonly CapitalGainsDisposalField[] = [
  {
    kind: "assetType",
    label: CAPITAL_GAINS_DISPOSAL_LABELS.assetType,
    aliases: [
      "asset type",
      "capital asset type",
      "nature of asset",
      "security type",
      "instrument type",
      "asset category",
      "category of asset",
      "asset class",
      "type of capital asset",
      "nature of security",
    ],
    required: true,
    kindOfValue: "type",
  },
  {
    kind: "assetDescription",
    label: CAPITAL_GAINS_DISPOSAL_LABELS.assetDescription,
    aliases: [
      "scrip",
      "symbol",
      "security name",
      "asset description",
      "description of asset",
      "instrument",
      "particulars",
      "description",
      "fund name",
      "scheme name",
      "company name",
      "name of security",
      "instrument name",
      "isin",
    ],
    required: true,
    kindOfValue: "text",
  },
  {
    kind: "acquiredOn",
    label: CAPITAL_GAINS_DISPOSAL_LABELS.acquiredOn,
    aliases: [
      "date of acquisition",
      "purchase date",
      "acquired on",
      "acquisition date",
      "date of purchase",
      "buy date",
      "date of investment",
      "purchase / acquisition date",
      "from date",
    ],
    required: true,
    kindOfValue: "date",
  },
  {
    kind: "disposedOn",
    label: CAPITAL_GAINS_DISPOSAL_LABELS.disposedOn,
    aliases: [
      "date of disposal",
      "sale date",
      "disposal date",
      "sold on",
      "date of sale",
      "sell date",
      "redemption date",
      "date of redemption",
      "maturity date",
      "encashment date",
      "to date",
    ],
    required: true,
    kindOfValue: "date",
  },
  {
    kind: "costOfAcquisition",
    label: CAPITAL_GAINS_DISPOSAL_LABELS.costOfAcquisition,
    aliases: [
      "cost",
      "cost of acquisition",
      "purchase cost",
      "acquisition cost",
      "cost of purchase",
      "cost of investment",
      "investment cost",
      "total cost",
      "purchase value",
      "book value",
      "holding cost",
      "cost including brokerage",
    ],
    required: true,
    kindOfValue: "amount",
  },
  {
    kind: "saleValue",
    label: CAPITAL_GAINS_DISPOSAL_LABELS.saleValue,
    aliases: [
      "sale value",
      "sale consideration",
      "consideration received",
      "net sale proceeds",
      "sale proceeds",
      "sale proceed",
      "gross sale value",
      "selling price",
      "sale price",
      "sale amount",
      "disposal proceeds",
      "net proceeds",
      "redemption value",
      "redemption proceeds",
      "encashment value",
    ],
    required: true,
    kindOfValue: "amount",
  },
  {
    kind: "exemptGain",
    label: CAPITAL_GAINS_DISPOSAL_LABELS.exemptGain,
    aliases: [
      "exempt gain",
      "exempt portion",
      "exemption claimed",
      "exempt capital gain",
      "gain exempt",
    ],
    required: false,
    kindOfValue: "amount",
  },
  {
    kind: "taxDeducted",
    label: CAPITAL_GAINS_DISPOSAL_LABELS.taxDeducted,
    aliases: [
      "tax deducted",
      "withholding tax",
      "tax withheld",
      "cgt deducted",
      "cgt paid",
      "capital gain tax deducted",
      "tax deducted at source",
      "tax on capital gain",
      "tds",
    ],
    required: false,
    kindOfValue: "amount",
  },
  {
    kind: "payerName",
    label: CAPITAL_GAINS_DISPOSAL_LABELS.payerName,
    aliases: [
      "broker",
      "broker name",
      "brokerage house",
      "clearing member",
      "payer name",
      "payer",
      "institution",
      "asset management company",
      "amc",
      "bank",
    ],
    required: false,
    kindOfValue: "text",
  },
  {
    kind: "payerNtn",
    label: CAPITAL_GAINS_DISPOSAL_LABELS.payerNtn,
    aliases: [
      "broker ntn",
      "payer ntn",
      "agent ntn",
      "clearing member ntn",
      "amc ntn",
      "ntn",
    ],
    required: false,
    kindOfValue: "text",
  },
  {
    kind: "quantity",
    label: CAPITAL_GAINS_DISPOSAL_LABELS.quantity,
    aliases: [
      "quantity",
      "units",
      "shares",
      "number of units",
      "no. of shares",
      "number of shares",
      "qty",
      "units redeemed",
      "quantity disposed",
    ],
    required: false,
    kindOfValue: "amount",
  },
  {
    kind: "evidenceReference",
    label: CAPITAL_GAINS_DISPOSAL_LABELS.evidenceReference,
    aliases: [
      "statement reference",
      "certificate",
      "certificate no",
      "page",
      "evidence reference",
      "contract note",
      "contract note no",
      "transaction id",
      "statement no",
      "uin",
      "cdc sub account",
      "sub account",
    ],
    required: false,
    kindOfValue: "text",
  },
] as const;

/** Suffix used by the extractor for the second, third … disposal of a statement. */
export function capitalGainsRowLabel(base: string, rowNumber: number) {
  return rowNumber <= 1 ? base : `${base} ${rowNumber}`;
}
