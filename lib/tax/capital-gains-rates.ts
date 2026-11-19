/**
 * Section 37A — capital gain on disposal of securities.
 *
 * The FBR withholding rate card carries only Section 151A (debt securities).
 * The equity, fund and PMEX rates live in **Division VII, Part I of the First
 * Schedule** of the Income Tax Ordinance 2001, and after the Finance Act 2024
 * they depend on the *acquisition date* rather than on the current year:
 *
 *   | Acquired                        | Rate                                        |
 *   |---------------------------------|---------------------------------------------|
 *   | before 01-Jul-2013              | 1%  — nil (exempt)                           |
 *   | 01-Jul-2013 – 30-Jun-2022       | 12.5% flat                                   |
 *   | 01-Jul-2022 – 30-Jun-2024       | holding-period taper 15% → nil over 6 years  |
 *   | on/after 01-Jul-2024            | 15% flat, ATL on the acquisition AND disposal dates |
 *
 * Mutual fund, collective-scheme and REIT units follow the fund rows: 15% for
 * an individual or AOP, and **no deduction at all once units acquired on or
 * before 30-Jun-2024 have been held more than six years** (the FA2024 proviso
 * deliberately kept that relief off post-Jul-2024 acquisitions). PMEX future
 * commodity contracts stay at 5%.
 *
 * A person who is not on the ATL pays the **higher of 15% and the Division I
 * slab rates**. This module only states the band; the comparison needs the
 * whole taxable income, so the engine moves such a gain onto the
 * `capital_gains_37a_non_atl` slab route and applies the 15% floor there
 * (see `tax-calculation.ts`).
 *
 * Losses inside the s.37A block are netted **band by band** before the rate
 * applies, in `capital-gains-route.ts`: a gain and a loss inside the same band
 * are summed, a band that ends in a loss is not priced at all (the loss is
 * carried forward for three tax years), and a statement with a loss in one
 * band and a gain in another is refused, because allocating a loss across
 * rate bands is not catalogued.
 */

export type SecuritiesCapitalGainsSubcategory =
  | "securities-listed-37a"
  | "funds-37a"
  | "pmex-futures-37a";

export const SECURITIES_CAPITAL_GAINS_SUBCATEGORIES: readonly SecuritiesCapitalGainsSubcategory[] =
  ["securities-listed-37a", "funds-37a", "pmex-futures-37a"];

/** Subcategory → the instrument families it covers, for the caller's check. */
export const SECURITIES_CAPITAL_GAINS_INSTRUMENTS: Readonly<
  Record<SecuritiesCapitalGainsSubcategory, readonly string[]>
> = {
  "securities-listed-37a": ["listed-share"],
  "funds-37a": ["mutual-fund-or-reit", "stock-fund", "other-than-stock-fund"],
  "pmex-futures-37a": ["pmex-cash-settled"],
};

export type SecuritiesCapitalGainsBand = {
  ruleId: string;
  subcategory: SecuritiesCapitalGainsSubcategory;
  label: string;
  ratePercent: number;
  /** The 114(1) Final Tax row this rate is reported on. */
  irisCode: string;
  basis: string;
};

/**
 * IRIS 114(1) Final Tax rows captured from the live sheet:
 * 64220151 @0, 64220152 @2.5, 64220153 @5 (the only 5% row, labelled PMEX),
 * 64220157 @7.5, 64220162 @10, 64220155 @12.5, 64220156 @15,
 * 64220158 funds/REIT @15, 64220161 stock funds, 64220159 other-than-stock.
 */
const IRIS = {
  nil: "64220151",
  twoPointFive: "64220152",
  five: "64220153",
  sevenPointFive: "64220157",
  ten: "64220162",
  twelvePointFive: "64220155",
  fifteen: "64220156",
  fifteenFunds: "64220158",
  fifteenStockFund: "64220161",
  fifteenOtherFund: "64220159",
} as const;

export const SECURITIES_CAPITAL_GAINS_BANDS: readonly SecuritiesCapitalGainsBand[] =
  [
    {
      ruleId: "TY2026-37A-SEC-PRE-2013",
      subcategory: "securities-listed-37a",
      label: "Listed security acquired before 01-Jul-2013 — exempt",
      ratePercent: 0,
      irisCode: IRIS.nil,
      basis: "Division VII, Part I, First Schedule: a security acquired before 1 July 2013 carries no tax.",
    },
    {
      ruleId: "TY2026-37A-SEC-2013-2022",
      subcategory: "securities-listed-37a",
      label: "Listed security acquired 01-Jul-2013 to 30-Jun-2022",
      ratePercent: 12.5,
      irisCode: IRIS.twelvePointFive,
      basis: "Division VII: securities acquired between 1 July 2013 and 30 June 2022 are taxed at 12.5% regardless of holding period.",
    },
    {
      ruleId: "TY2026-37A-SEC-2022-2024-LT-1Y",
      subcategory: "securities-listed-37a",
      label: "Acquired 01-Jul-2022 to 30-Jun-2024, held under 1 year",
      ratePercent: 15,
      irisCode: IRIS.fifteen,
      basis: "Division VII taper: under one year is 15%.",
    },
    {
      ruleId: "TY2026-37A-SEC-2022-2024-1-2Y",
      subcategory: "securities-listed-37a",
      label: "Acquired 01-Jul-2022 to 30-Jun-2024, held 1 to 2 years",
      ratePercent: 12.5,
      irisCode: IRIS.twelvePointFive,
      basis: "Division VII taper: one to two years is 12.5%.",
    },
    {
      ruleId: "TY2026-37A-SEC-2022-2024-2-3Y",
      subcategory: "securities-listed-37a",
      label: "Acquired 01-Jul-2022 to 30-Jun-2024, held 2 to 3 years",
      ratePercent: 10,
      irisCode: IRIS.ten,
      basis: "Division VII taper: two to three years is 10%.",
    },
    {
      ruleId: "TY2026-37A-SEC-2022-2024-3-4Y",
      subcategory: "securities-listed-37a",
      label: "Acquired 01-Jul-2022 to 30-Jun-2024, held 3 to 4 years",
      ratePercent: 7.5,
      irisCode: IRIS.sevenPointFive,
      basis: "Division VII taper: three to four years is 7.5%.",
    },
    {
      ruleId: "TY2026-37A-SEC-2022-2024-4-5Y",
      subcategory: "securities-listed-37a",
      label: "Acquired 01-Jul-2022 to 30-Jun-2024, held 4 to 5 years",
      ratePercent: 5,
      irisCode: IRIS.five,
      basis:
        "Division VII taper: four to five years is 5%. IRIS shows one 5% row (64220153, labelled for PMEX contracts); confirm its label before filing.",
    },
    {
      ruleId: "TY2026-37A-SEC-2022-2024-5-6Y",
      subcategory: "securities-listed-37a",
      label: "Acquired 01-Jul-2022 to 30-Jun-2024, held 5 to 6 years",
      ratePercent: 2.5,
      irisCode: IRIS.twoPointFive,
      basis: "Division VII taper: five to six years is 2.5%.",
    },
    {
      ruleId: "TY2026-37A-SEC-2022-2024-OVER-6Y",
      subcategory: "securities-listed-37a",
      label: "Acquired 01-Jul-2022 to 30-Jun-2024, held over 6 years",
      ratePercent: 0,
      irisCode: IRIS.nil,
      basis: "Division VII taper: more than six years is nil.",
    },
    {
      ruleId: "TY2026-37A-SEC-POST-JUN-2024",
      subcategory: "securities-listed-37a",
      label: "Listed security acquired on or after 01-Jul-2024",
      ratePercent: 15,
      irisCode: IRIS.fifteen,
      basis:
        "Division VII (Finance Act 2024): 15% flat where the seller is on the ATL on the acquisition date and on the disposal date; the six-year relief does not apply.",
    },
    {
      ruleId: "TY2026-37A-FUND-STOCK",
      subcategory: "funds-37a",
      label: "Stock (equity) fund units redeemed",
      ratePercent: 15,
      irisCode: IRIS.fifteenStockFund,
      basis: "Division VII fund rows: 15% for an individual or AOP on stock-fund units.",
    },
    {
      ruleId: "TY2026-37A-FUND-SCHEME-REIT",
      subcategory: "funds-37a",
      label: "Mutual fund, collective scheme or REIT units redeemed",
      ratePercent: 15,
      irisCode: IRIS.fifteenFunds,
      basis:
        "Division VII fund rows: 15% for an individual or AOP on mutual fund, collective scheme and REIT units.",
    },
    {
      ruleId: "TY2026-37A-FUND-OTHER",
      subcategory: "funds-37a",
      label: "Units of a fund other than a stock fund",
      ratePercent: 15,
      irisCode: IRIS.fifteenOtherFund,
      basis:
        "Division VII fund rows: 15% for an individual or AOP on units other than stock funds.",
    },
    {
      ruleId: "TY2026-37A-FUND-OVER-6Y",
      subcategory: "funds-37a",
      label: "Fund or REIT units acquired on or before 30-Jun-2024 and held over 6 years",
      ratePercent: 0,
      irisCode: IRIS.nil,
      basis:
        "FA2024 proviso: no capital gains tax is deducted where units acquired on or before 30 June 2024 have been held more than six years.",
    },
    {
      ruleId: "TY2026-37A-PMEX-FUTURES",
      subcategory: "pmex-futures-37a",
      label: "Future commodity contracts entered into by PMEX members",
      ratePercent: 5,
      irisCode: IRIS.five,
      basis: "Division VII, serial 5: 5% on future commodity contracts traded by PMEX members.",
    },
  ] as const;

export function getSecuritiesCapitalGainsBand(
  ruleId: string,
): SecuritiesCapitalGainsBand | null {
  return SECURITIES_CAPITAL_GAINS_BANDS.find((band) => band.ruleId === ruleId) ?? null;
}

// ---------------------------------------------------------------------------
// Dates
// ---------------------------------------------------------------------------

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

function toUtcDate(value: unknown): { year: number; month: number; day: number } | null {
  if (typeof value !== "string") return null;
  const match = ISO_DATE.exec(value.trim());
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  // 31 February parses as a shape but not as a day. Ask the calendar.
  const probe = new Date(Date.UTC(year, month - 1, day));
  if (
    probe.getUTCFullYear() !== year ||
    probe.getUTCMonth() !== month - 1 ||
    probe.getUTCDate() !== day
  ) {
    return null;
  }
  return { year, month, day };
}

/** Whole months between two ISO dates, counting a month only once it is complete. */
export function completedMonthsBetween(
  acquiredOn: unknown,
  disposedOn: unknown,
): number | null {
  const from = toUtcDate(acquiredOn);
  const to = toUtcDate(disposedOn);
  if (!from || !to) return null;
  let months = (to.year - from.year) * 12 + (to.month - from.month);
  if (to.day < from.day) months -= 1;
  return months < 0 ? null : months;
}

const PRE_2013 = "2013-07-01";
const AFTER_JUN_2022 = "2022-07-01";
const AFTER_JUN_2024 = "2024-07-01";

// ---------------------------------------------------------------------------
// Resolution
// ---------------------------------------------------------------------------

export type SecuritiesCapitalGainsResolution =
  | {
      band: SecuritiesCapitalGainsBand;
      holdingMonths: number;
      holdingYears: number;
    }
  | { error: string };

/**
 * Picks the single band that applies to one disposal. Dates come from the CGT
 * statement, never from a guess: a missing or impossible date is an error, not
 * a default rate.
 */
export function resolveSecuritiesCapitalGainsBand(input: {
  subcategory: string;
  acquiredOn?: unknown;
  disposedOn?: unknown;
  instrumentKind?: unknown;
}): SecuritiesCapitalGainsResolution {
  const subcategory = input.subcategory as SecuritiesCapitalGainsSubcategory;
  if (!SECURITIES_CAPITAL_GAINS_SUBCATEGORIES.includes(subcategory)) {
    return {
      error: `"${input.subcategory}" is not a Section 37A securities category this calculator prices.`,
    };
  }

  const allowed = SECURITIES_CAPITAL_GAINS_INSTRUMENTS[subcategory];
  const kind = typeof input.instrumentKind === "string" ? input.instrumentKind : null;
  if (!kind) {
    // A fund unit and a listed share carry different rates before July 2024
    // (15% against a 12.5%/taper band) and land on different 114(1) rows, so
    // the instrument has to be named before anything is priced.
    return {
      error:
        "The statement does not say what kind of security this was. A listed share, a fund/REIT unit and a PMEX contract are priced differently (and are reported on different 114(1) rows), so the instrument has to be named.",
    };
  }
  if (!allowed.includes(kind)) {
    return {
      error:
        `A "${kind}" disposal does not belong in the "${subcategory}" category ` +
        `(that category covers ${allowed.join(", ")}).`,
    };
  }

  const acquiredOn = typeof input.acquiredOn === "string" ? input.acquiredOn.trim() : "";
  const disposedOn = typeof input.disposedOn === "string" ? input.disposedOn.trim() : "";
  const holdingMonths = completedMonthsBetween(acquiredOn, disposedOn);
  if (holdingMonths === null) {
    return {
      error:
        "A Section 37A gain needs a valid acquisition date and disposal date (YYYY-MM-DD); " +
        "the rate depends on the acquisition vintage and the holding period.",
    };
  }

  const bandFor = (ruleId: string): SecuritiesCapitalGainsResolution => {
    const band = getSecuritiesCapitalGainsBand(ruleId);
    if (!band) {
      return { error: `The Section 37A band "${ruleId}" is not catalogued.` };
    }
    return { band, holdingMonths, holdingYears: Math.floor(holdingMonths / 12) };
  };

  if (subcategory === "pmex-futures-37a") {
    return bandFor("TY2026-37A-PMEX-FUTURES");
  }

  if (subcategory === "funds-37a") {
    const acquiredOnOrBeforeJun2024 = acquiredOn < AFTER_JUN_2024;
    if (acquiredOnOrBeforeJun2024 && holdingMonths > 72) {
      return bandFor("TY2026-37A-FUND-OVER-6Y");
    }
    if (kind === "stock-fund") return bandFor("TY2026-37A-FUND-STOCK");
    if (kind === "other-than-stock-fund") return bandFor("TY2026-37A-FUND-OTHER");
    return bandFor("TY2026-37A-FUND-SCHEME-REIT");
  }

  // Listed shares: the acquisition date decides the regime.
  if (acquiredOn < PRE_2013) return bandFor("TY2026-37A-SEC-PRE-2013");
  if (acquiredOn < AFTER_JUN_2022) return bandFor("TY2026-37A-SEC-2013-2022");
  if (acquiredOn >= AFTER_JUN_2024) return bandFor("TY2026-37A-SEC-POST-JUN-2024");

  const years = Math.floor(holdingMonths / 12);
  if (years < 1) return bandFor("TY2026-37A-SEC-2022-2024-LT-1Y");
  if (years < 2) return bandFor("TY2026-37A-SEC-2022-2024-1-2Y");
  if (years < 3) return bandFor("TY2026-37A-SEC-2022-2024-2-3Y");
  if (years < 4) return bandFor("TY2026-37A-SEC-2022-2024-3-4Y");
  if (years < 5) return bandFor("TY2026-37A-SEC-2022-2024-4-5Y");
  if (years < 6) return bandFor("TY2026-37A-SEC-2022-2024-5-6Y");
  return bandFor("TY2026-37A-SEC-2022-2024-OVER-6Y");
}

/**
 * The subcategory a statement row belongs to, from the instrument it names.
 * Debt securities are Section 151A and never land here.
 */
export function securitiesSubcategoryForInstrument(
  instrumentKind: unknown,
): SecuritiesCapitalGainsSubcategory | null {
  const kind = typeof instrumentKind === "string" ? instrumentKind : "";
  if (kind === "pmex-cash-settled") return "pmex-futures-37a";
  if (
    kind === "mutual-fund-or-reit" ||
    kind === "stock-fund" ||
    kind === "other-than-stock-fund"
  ) {
    return "funds-37a";
  }
  if (kind === "listed-share") return "securities-listed-37a";
  return null;
}

/** True when the value is a well-formed YYYY-MM-DD date. */
export function isIsoDate(value: unknown): value is string {
  return toUtcDate(value) !== null;
}

// ---------------------------------------------------------------------------
// Section 37(1A) — immovable property
// ---------------------------------------------------------------------------

/**
 * The kind of immovable property the statement describes.
 *
 * The pre-July-2024 taper is NOT one table: an open plot keeps a rate for six
 * years, a constructed building for four, and a flat stops being charged after
 * two. So the kind is part of the rate, not a description.
 */
export type PropertyKind = "open-plot" | "constructed" | "flat";

export const PROPERTY_KINDS: readonly PropertyKind[] = [
  "open-plot",
  "constructed",
  "flat",
];

export type PropertyCapitalGainsBand = {
  ruleId: string;
  kind: PropertyKind | "any";
  label: string;
  ratePercent: number;
  /**
   * The 114(1) row every property gain is reported on. Unlike s.37A, the Final
   * Tax grid carries ONE property row (64220050) whatever the rate, so the band
   * decides the percentage and never the row.
   */
  irisCode: string;
  basis: string;
};

const PROPERTY_IRIS_ROW = "64220050";

/** Acquired on or after this date: one flat rate, no holding-period relief. */
export const PROPERTY_FLAT_FROM = "2024-07-01";

/**
 * Completed-year rate tables for property acquired on or before 30-Jun-2024.
 * Index = completed holding years (0 = under one year), taken from the
 * Division VIII style table the Finance Act 2024 left in place for the older
 * vintage: plots 15/12.5/10/7.5/5/2.5/0, constructed 15/10/7.5/5/0, flats
 * 15/7.5/0.
 */
export const PROPERTY_TAPER: Readonly<Record<PropertyKind, readonly number[]>> = {
  "open-plot": [15, 12.5, 10, 7.5, 5, 2.5, 0],
  constructed: [15, 10, 7.5, 5, 0],
  flat: [15, 7.5, 0],
};

/**
 * The taper's own rule id for a completed-year index.
 *
 * The last index of a kind is its "over" step (a building's fifth entry means
 * "four years or more", a flat's third "two years or more"), so the label is
 * derived from the table's length rather than a fixed six-year assumption.
 */
function propertyTaperRuleId(kind: PropertyKind, index: number, tableLength: number): string {
  const prefix = `TY2026-37-1A-${kind.toUpperCase()}`;
  if (index >= tableLength - 1) return `${prefix}-OVER-${index}Y`;
  return `${prefix}-${index === 0 ? "LT-1Y" : `${index}-${index + 1}Y`}`;
}

export const PROPERTY_CAPITAL_GAINS_BANDS: readonly PropertyCapitalGainsBand[] = [
  {
    ruleId: "TY2026-37-1A-PROPERTY-POST-JUN-2024",
    kind: "any",
    label: "Immovable property acquired on or after 01-Jul-2024",
    ratePercent: 15,
    irisCode: PROPERTY_IRIS_ROW,
    basis:
      "Section 37(1A) read with the Finance Act 2024: property acquired on or after 1 July 2024 is charged a flat 15% for a person on the ATL, whatever the holding period.",
  },
  ...PROPERTY_KINDS.flatMap((kind) =>
    PROPERTY_TAPER[kind].map((ratePercent, years) => ({
      ruleId: propertyTaperRuleId(kind, years, PROPERTY_TAPER[kind].length),
      kind,
      label:
        years === 0
          ? `${kind}: held under 1 year (acquired on or before 30-Jun-2024)`
          : years >= PROPERTY_TAPER[kind].length - 1
            ? `${kind}: held ${years} years or more (acquired on or before 30-Jun-2024)`
            : `${kind}: held ${years} to ${years + 1} years (acquired on or before 30-Jun-2024)`,
      ratePercent,
      irisCode: PROPERTY_IRIS_ROW,
      basis:
        ratePercent === 0
          ? `Section 37(1A) taper (property acquired on or before 30-Jun-2024): a ${kind.replace("-", " ")} held this long carries no tax.`
          : `Section 37(1A) taper (property acquired on or before 30-Jun-2024): a ${kind.replace("-", " ")} held this long is charged ${ratePercent}%.`,
    })),
  ),
] as const;

export type PropertyCapitalGainsResolution =
  | {
      band: PropertyCapitalGainsBand;
      holdingMonths: number;
      /** Completed holding years, the taper's own unit. */
      holdingYears: number;
    }
  | { error: string };

/** The band a rule id names, or null. */
export function getPropertyCapitalGainsBand(
  ruleId: string,
): PropertyCapitalGainsBand | null {
  return PROPERTY_CAPITAL_GAINS_BANDS.find((band) => band.ruleId === ruleId) ?? null;
}

/**
 * Price a property disposal's RATE. It does not price the gain itself: under
 * Section 37(1A) the figures come from the 116 Wealth Statement, so the caller
 * supplies cost and sale value and this function only answers "how much".
 */
export function resolvePropertyCapitalGainsBand(input: {
  kind?: unknown;
  acquiredOn?: unknown;
  disposedOn?: unknown;
}): PropertyCapitalGainsResolution {
  const kind = typeof input.kind === "string" ? input.kind.trim() : "";
  if (!PROPERTY_KINDS.includes(kind as PropertyKind)) {
    return {
      error:
        "The statement does not say what kind of immovable property this was. An open plot, a constructed building and a flat taper differently before July 2024, so the kind has to be named.",
    };
  }
  const acquiredOn =
    typeof input.acquiredOn === "string" ? input.acquiredOn.trim() : "";
  const disposedOn =
    typeof input.disposedOn === "string" ? input.disposedOn.trim() : "";
  if (!isIsoDate(acquiredOn)) {
    return {
      error:
        "A Section 37(1A) gain needs a valid acquisition date (YYYY-MM-DD); the rate depends on the acquisition vintage.",
    };
  }
  if (!isIsoDate(disposedOn)) {
    return {
      error:
        "A Section 37(1A) gain needs a valid disposal date (YYYY-MM-DD); the rate depends on the holding period.",
    };
  }
  if (disposedOn < acquiredOn) {
    return {
      error:
        "The disposal date is before the acquisition date, so the holding period is negative and no Section 37(1A) band can be read.",
    };
  }
  const holdingMonths = completedMonthsBetween(acquiredOn, disposedOn);
  if (holdingMonths === null) {
    return {
      error:
        "A Section 37(1A) gain needs a valid acquisition date and disposal date (YYYY-MM-DD); the rate depends on the acquisition vintage and the holding period.",
    };
  }
  const holdingYears = Math.floor(holdingMonths / 12);

  if (acquiredOn >= PROPERTY_FLAT_FROM) {
    const band = getPropertyCapitalGainsBand(
      "TY2026-37-1A-PROPERTY-POST-JUN-2024",
    );
    if (!band) return { error: "The flat property band is not catalogued." };
    return { band, holdingMonths, holdingYears };
  }

  const table = PROPERTY_TAPER[kind as PropertyKind];
  const index = Math.min(holdingYears, table.length - 1);
  const ruleId = propertyTaperRuleId(kind as PropertyKind, index, table.length);
  const band = getPropertyCapitalGainsBand(ruleId);
  if (!band) return { error: `The Section 37(1A) band "${ruleId}" is not catalogued.` };
  return { band, holdingMonths, holdingYears };
}
