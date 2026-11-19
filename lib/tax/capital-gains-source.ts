/**
 * Capital gains — reading the CGT statement.
 *
 * The document was already required by the filing (document-requirements.ts)
 * and already classified (extraction.ts), but nothing ever read it: the gain
 * only existed if an operator typed it into the ledger. This file closes that
 * gap. It turns the extracted fields of a `cgt_statement` into disposal rows
 * and hands them to the derivation added in phase 0, which produces the exact
 * shape the IRIS 114(1) sheet expects.
 *
 * Two rules are enforced here rather than downstream:
 *
 *  - A row needs cost, sale value and BOTH dates. Without them §37A cannot be
 *    put in the right rate bucket and §37 cannot prove a holding period, so
 *    the review screen asks for them instead of the packet guessing.
 *  - Nothing is inferred from a rate. A statement that prints "CGT @ 15%"
 *    still has to print the cost; the rate is checked against the bucket in
 *    phase 3, it is never used to back out the gain.
 */

import {
  CAPITAL_GAINS_DISPOSAL_FIELDS,
  CAPITAL_GAINS_DISPOSAL_LABELS,
  type CapitalAssetTypeKey,
  type CapitalGainsDisposalFieldKind,
} from "./capital-gains-fields";
import {
  deriveCapitalGainsSummary,
  listDisposalProblems,
  type CapitalGainsDisposal,
  type CapitalGainsInstrumentKind,
  type CapitalGainsProblem,
  type CapitalGainsSummary,
} from "./capital-gains-derivation";

export type CapitalGainsFieldLike = { label?: unknown; value?: unknown };

const normalize = (value: unknown) =>
  String(value ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");

function isMissing(value: unknown) {
  return value === null || value === undefined || String(value).trim() === "";
}

/** Money as printed: "1,250,000", "PKR 1 250 000.00", "(3,000)" for negatives. */
export function parseCapitalGainsAmount(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  let text = String(value).trim();
  if (text === "") return null;
  let negative = false;
  if (/^\(.*\)$/.test(text)) {
    negative = true;
    text = text.slice(1, -1);
  }
  text = text.replace(/(pkr|rs\.?|rupees)/gi, "").replace(/[,\s]/g, "");
  if (!/^-?\d+(\.\d+)?$/.test(text)) return null;
  const amount = Number(text);
  if (!Number.isFinite(amount)) return null;
  return negative ? -Math.abs(amount) : amount;
}

const MONTHS = [
  "jan",
  "feb",
  "mar",
  "apr",
  "may",
  "jun",
  "jul",
  "aug",
  "sep",
  "oct",
  "nov",
  "dec",
];

/** ISO date out of the formats a broker statement actually prints. */
export function parseCapitalGainsDate(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  if (text === "") return null;

  const iso = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
  if (iso) return text;

  const dmy = /^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})$/.exec(text);
  if (dmy) {
    const [, d, m, y] = dmy;
    return `${y}-${m.padStart(2, "0")}-${d.padStart(2, "0")}`;
  }

  const named = /^(\d{1,2})[\s-]+([A-Za-z]{3,})[\s-]+(\d{4})$/.exec(text);
  if (named) {
    const [, d, monthName, y] = named;
    const index = MONTHS.indexOf(monthName.slice(0, 3).toLowerCase());
    if (index >= 0) {
      return `${y}-${String(index + 1).padStart(2, "0")}-${d.padStart(2, "0")}`;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Field -> row -> kind
//
// The extractor appends a row number to repeated labels ("Cost of Acquisition
// (PKR) 2"), exactly like the invoice rows. The suffix is stripped before the
// alias lookup, and rows are rebuilt from it.
// ---------------------------------------------------------------------------

const FIELD_BY_ALIAS = new Map<string, CapitalGainsDisposalFieldKind>();
for (const field of CAPITAL_GAINS_DISPOSAL_FIELDS) {
  for (const alias of [field.label, ...field.aliases]) {
    FIELD_BY_ALIAS.set(normalize(alias), field.kind);
  }
}

export function capitalGainsFieldKind(label: unknown): CapitalGainsDisposalFieldKind | null {
  const normalized = normalize(label);
  if (!normalized) return null;
  const direct = FIELD_BY_ALIAS.get(normalized);
  if (direct) return direct;
  const withoutRow = normalized.replace(/_(?:row_)?\d+$/, "");
  return FIELD_BY_ALIAS.get(withoutRow) ?? null;
}

/** Trailing row number, defaulting to 1 for an unnumbered label. */
export function capitalGainsRowNumber(label: unknown): number {
  const normalized = normalize(label);
  const match = /_(?:row_)?(\d+)$/.exec(normalized);
  if (!match) return 1;
  const row = Number(match[1]);
  return Number.isFinite(row) && row > 0 ? row : 1;
}

export type CapitalGainsRows = {
  /** row number -> field kind -> raw value */
  rows: Map<number, Map<CapitalGainsDisposalFieldKind, unknown>>;
  /** Canonical labels seen more than once in the SAME row. */
  duplicateErrors: string[];
};

export function groupCapitalGainsRows(fields: readonly CapitalGainsFieldLike[]): CapitalGainsRows {
  const rows = new Map<number, Map<CapitalGainsDisposalFieldKind, unknown>>();
  const duplicateErrors: string[] = [];
  for (const field of fields) {
    const kind = capitalGainsFieldKind(field.label);
    if (!kind) continue;
    const rowNumber = capitalGainsRowNumber(field.label);
    const row = rows.get(rowNumber) ?? new Map<CapitalGainsDisposalFieldKind, unknown>();
    if (row.has(kind) && !isMissing(field.value)) {
      const label = CAPITAL_GAINS_DISPOSAL_LABELS[kind];
      duplicateErrors.push(
        `Row ${rowNumber}: "${label}" appears more than once. Keep one value per disposal.`,
      );
    }
    row.set(kind, field.value);
    rows.set(rowNumber, row);
  }
  return { rows, duplicateErrors };
}

// ---------------------------------------------------------------------------
// Asset type / instrument kind from the words on the statement
// ---------------------------------------------------------------------------

const ASSET_TYPE_PHRASES: readonly [CapitalAssetTypeKey, readonly string[]][] = [
  [
    "shares-listed-outside-nccpl",
    ["listed shares outside", "listed share outside", "shares sold outside", "paper shares"],
  ],
  [
    "shares-company-outside-nccpl",
    ["unlisted shares", "private company shares", "shares of company outside"],
  ],
  ["jewelry", ["jewellery", "jewelry", "ornaments"]],
  ["coins", ["coins", "coin"]],
  ["gold", ["gold", "bullion"]],
  ["painting", ["painting", "artwork", "art"]],
  ["motor-vehicle", ["motor vehicle", "vehicle", "car"]],
  ["others", ["other asset", "others", "other capital asset", "plot file", "membership"]],
];

export type CapitalGainsAssetReading = {
  assetType: CapitalAssetTypeKey | null;
  soldThroughNccplOrPsx: boolean;
  instrumentKind: CapitalGainsInstrumentKind | null;
};

/**
 * True when the row describes immovable property. Section 37(1A) is not a
 * statement item at all: IRIS only shows row 4042 (and its Final Tax row
 * 64220050) once the property exists in the 116 Wealth Statement, so a
 * property disposal found here is reported with that route, not priced.
 */
export function looksLikeImmovableProperty(...values: unknown[]): boolean {
  const text = values.map((value) => String(value ?? "")).join(" ").toLowerCase();
  return /\bplot\b|\bland\b|immovable|\bproperty\b|house|flat\b|apartment|commercial unit|constructed/.test(
    text,
  );
}

/**
 * Reads the asset description. It never upgrades a disposal to §37A on its
 * own: only an explicit exchange/depository mention does that, because §37A
 * and §37 are priced from different rate tables.
 */
export function readCapitalGainsAsset(...values: unknown[]): CapitalGainsAssetReading {
  const text = values.map((value) => String(value ?? "")).join(" ").toLowerCase();

  // A debt instrument is priced by Section 151A, so it is recognised before
  // anything else — but only when the row does not also name an equity or
  // fund instrument. A "bond fund" or a "sukuk fund" is a collective scheme
  // (a s.37A fund bucket), and a row whose figures are stated to be an
  // exchange trade of shares must not be re-priced at 15% just because a
  // description mentions a bond. Contradictory rows fall through to the
  // §37A path, which the calculator refuses rather than prices.
  const debtSignal =
    /\btfc\b|term finance|corporate bond|\bbond\b|debenture|sukuk|\bdsc\b|defence savings|\bpib\b|pakistan investment bond|ijara|\bncd\b|debt instrument|fixed income/.test(
      text,
    );
  const equityOrFundSignal =
    /share|scrip|equity|\bstock\b|mutual fund|\bfund\b|reit|etf|collective scheme|pmex/.test(text);
  if (debtSignal && !equityOrFundSignal) {
    return { assetType: null, soldThroughNccplOrPsx: false, instrumentKind: "debt-security" };
  }

  const soldThroughNccplOrPsx =
    /nccpl|psx|pakistan stock exchange|stock exchange|cdc|central depository|broker|clearing member/.test(text);

  let instrumentKind: CapitalGainsAssetReading["instrumentKind"] = null;
  if (/pmex|cash settled|cash-settled/.test(text)) instrumentKind = "pmex-cash-settled";
  // "other-than-stock fund" contains "stock fund", so the narrower row is read
  // first — otherwise every non-equity fund would be filed on the stock-fund
  // line (64220161) instead of its own (64220159).
  else if (/other[- ]than[- ]stock/.test(text)) instrumentKind = "other-than-stock-fund";
  else if (/stock fund|equity fund/.test(text)) instrumentKind = "stock-fund";
  else if (/mutual fund|\bfund\b|reit|collective scheme|\bscheme\b|etf|unit trust/.test(text))
    instrumentKind = "mutual-fund-or-reit";
  else if (/shares|scrip|security|securities|equity|stock/.test(text)) instrumentKind = "listed-share";

  if (soldThroughNccplOrPsx) {
    return { assetType: null, soldThroughNccplOrPsx: true, instrumentKind };
  }

  for (const [key, phrases] of ASSET_TYPE_PHRASES) {
    if (phrases.some((phrase) => text.includes(phrase))) {
      return { assetType: key, soldThroughNccplOrPsx: false, instrumentKind };
    }
  }
  return { assetType: null, soldThroughNccplOrPsx: false, instrumentKind };
}

// ---------------------------------------------------------------------------
// Rows -> disposals
// ---------------------------------------------------------------------------

export type CapitalGainsExtraction = {
  disposals: CapitalGainsDisposal[];
  /** Problems that stop a row becoming a disposal at all. */
  problems: CapitalGainsProblem[];
  /** Review-screen messages, one per missing or unusable field. */
  errors: string[];
  /**
   * Things the operator must read but that do not block: figures that are
   * already net of incidental costs, or FIFO-matched rows whose cost is not
   * the original purchase price.
   */
  notices: string[];
};

export function extractCapitalGainsDisposals(
  fields: readonly CapitalGainsFieldLike[] | undefined,
): CapitalGainsExtraction {
  if (!fields || fields.length === 0) {
    return {
      disposals: [],
      problems: [],
      errors: ["No capital gains disposal was extracted from the statement."],
      notices: [],
    };
  }

  const { rows, duplicateErrors } = groupCapitalGainsRows(fields);
  const disposals: CapitalGainsDisposal[] = [];
  const errors: string[] = [...duplicateErrors];

  // NCCPL bakes a 0.5% incidental-cost adjustment into the printed cost and
  // sale proceeds (0.5% of consideration on a client trade, 0.25% for a
  // broker's own account) and matches disposals FIFO. Both facts change what
  // the printed "cost" means, so they are surfaced rather than recomputed:
  // adjusting them again would understate the gain twice over.
  const allText = fields
    .map((entry) => `${entry.label ?? ""} ${entry.value ?? ""}`)
    .join(" ")
    .toLowerCase();
  const notices: string[] = [];
  if (allText.includes("incidental") || allText.includes("0.5%") || allText.includes("0.5 %")) {
    notices.push(
      "This statement mentions incidental expenses (brokerage/levy). NCCPL already adjusts a client trade by 0.5% of the consideration, so the printed cost and sale value must be used exactly as printed — do not deduct the same expense again.",
    );
  }
  if (allText.includes("fifo")) {
    notices.push(
      "Costs on this statement are FIFO-matched (first in, first out), so the printed cost is not the original purchase price of every lot. Use the printed figure.",
    );
  }

  for (const rowNumber of [...rows.keys()].sort((a, b) => a - b)) {
    const row = rows.get(rowNumber)!;
    const value = (kind: CapitalGainsDisposalFieldKind) => row.get(kind);

    const cost = parseCapitalGainsAmount(value("costOfAcquisition"));
    const sale = parseCapitalGainsAmount(value("saleValue"));
    const exempt = parseCapitalGainsAmount(value("exemptGain"));
    const tax = parseCapitalGainsAmount(value("taxDeducted"));
    const acquiredOn = parseCapitalGainsDate(value("acquiredOn"));
    const disposedOn = parseCapitalGainsDate(value("disposedOn"));

    const label = (kind: CapitalGainsDisposalFieldKind) => CAPITAL_GAINS_DISPOSAL_LABELS[kind];

    if (!isMissing(value("costOfAcquisition")) && cost === null) {
      errors.push(`Row ${rowNumber}: "${label("costOfAcquisition")}" is not a readable amount.`);
    }
    if (!isMissing(value("saleValue")) && sale === null) {
      errors.push(`Row ${rowNumber}: "${label("saleValue")}" is not a readable amount.`);
    }
    if (!isMissing(value("acquiredOn")) && acquiredOn === null) {
      errors.push(`Row ${rowNumber}: "${label("acquiredOn")}" is not a readable date.`);
    }
    if (!isMissing(value("disposedOn")) && disposedOn === null) {
      errors.push(`Row ${rowNumber}: "${label("disposedOn")}" is not a readable date.`);
    }

    const reading = readCapitalGainsAsset(
      value("assetType"),
      value("assetDescription"),
      value("payerName"),
    );

    const disposal: CapitalGainsDisposal = {
      id: `cgt-row-${rowNumber}`,
      costOfAcquisition: cost ?? 0,
      saleValue: sale ?? 0,
      ...(exempt !== null ? { exemptGain: exempt } : {}),
      ...(tax !== null ? { taxDeducted: tax } : {}),
      acquiredOn,
      disposedOn,
      assetType: reading.assetType,
      soldThroughNccplOrPsx: reading.soldThroughNccplOrPsx,
      instrumentKind: reading.instrumentKind,
      description: isMissing(value("assetDescription"))
        ? null
        : String(value("assetDescription")),
      evidenceReference: isMissing(value("evidenceReference"))
        ? null
        : String(value("evidenceReference")),
    };

    // Dates and amounts are enforced here so the review screen can ask for
    // them by name instead of the derivation reporting an anonymous problem.
    if (cost === null) {
      errors.push(`Row ${rowNumber}: enter the ${label("costOfAcquisition")} printed on the statement.`);
    }
    if (sale === null) {
      errors.push(`Row ${rowNumber}: enter the ${label("saleValue")} printed on the statement.`);
    }
    if (acquiredOn === null) {
      errors.push(`Row ${rowNumber}: enter the ${label("acquiredOn")} printed on the statement.`);
    }
    if (disposedOn === null) {
      errors.push(`Row ${rowNumber}: enter the ${label("disposedOn")} printed on the statement.`);
    }
    if (cost === null || sale === null || acquiredOn === null || disposedOn === null) {
      continue;
    }

    const problems = listDisposalProblems(disposal);
    if (problems.length > 0) {
      for (const problem of problems) {
        if (problem.kind === "unknown_asset_type") {
          errors.push(
            looksLikeImmovableProperty(value("assetType"), value("assetDescription"))
              ? `Row ${rowNumber}: immovable property is Section 37(1A), and IRIS only opens that row (4042) once the property is in the 116 Wealth Statement. Add the property there; this statement cannot place it.`
              : `Row ${rowNumber}: say what was sold — a listed security sold through NCCPL/PSX, or which capital asset type.`,
          );
        } else if (problem.kind === "security_without_rate_bucket") {
          errors.push(
            `Row ${rowNumber}: the 15% Final Tax band differs between a listed share (64220156) and a fund or REIT (64220158); name the instrument.`,
          );
        }
      }
      continue;
    }

    disposals.push(disposal);
  }

  if (disposals.length === 0 && errors.length === 0) {
    errors.push("The statement produced no usable disposal row.");
  }

  return { disposals, problems: [], errors, notices };
}

/** Review-screen gate: everything the statement must show before it is used. */
export function getCapitalGainsDocumentReviewErrors(
  fields: readonly CapitalGainsFieldLike[] | undefined,
): string[] {
  return extractCapitalGainsDisposals(fields).errors;
}

export type CapitalGainsDocumentEvaluation = {
  ok: boolean;
  errors: string[];
  disposals: CapitalGainsDisposal[];
  summary: CapitalGainsSummary | null;
  /** Set when the document exists but is not approved yet. */
  blockedByReviewStatus: boolean;
};

/**
 * The gate the calculation uses. A statement that is not approved is not
 * evidence: the draft must fall back to "manual IRIS entry required" rather
 * than price a figure nobody signed off.
 */
export function evaluateCapitalGainsDocument(input: {
  fields: readonly CapitalGainsFieldLike[] | undefined;
  reviewStatus?: string | null;
}): CapitalGainsDocumentEvaluation {
  const status = String(input.reviewStatus ?? "").toUpperCase();
  if (status && status !== "APPROVED") {
    return {
      ok: false,
      errors: ["The capital gains statement must be reviewed and approved before it is used."],
      disposals: [],
      summary: null,
      blockedByReviewStatus: true,
    };
  }

  const extraction = extractCapitalGainsDisposals(input.fields);
  if (extraction.errors.length > 0) {
    return {
      ok: false,
      errors: extraction.errors,
      disposals: extraction.disposals,
      summary: null,
      blockedByReviewStatus: false,
    };
  }

  const summary = deriveCapitalGainsSummary(extraction.disposals);
  if (summary.problems.length > 0) {
    return {
      ok: false,
      errors: ["The capital gains statement produced rows that cannot be placed on the IRIS sheet."],
      disposals: extraction.disposals,
      summary,
      blockedByReviewStatus: false,
    };
  }

  return {
    ok: true,
    errors: [],
    disposals: extraction.disposals,
    summary,
    blockedByReviewStatus: false,
  };
}
