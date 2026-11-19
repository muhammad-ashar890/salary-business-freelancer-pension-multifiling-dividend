/** Isolated donor vocabulary. NOT wired to production classification.
 * Detection is a review hint only, never proof of a disposal or a gain. */
/** Ledger category carrying a *realised gain* once it has been evidenced. */
export const CAPITAL_GAINS_CATEGORY = "CAPITAL_GAINS";

/** Ledger category carrying sale money that is not, by itself, income. */
export const ASSET_SALE_PROCEEDS_CATEGORY = "ASSET_SALE_PROCEEDS";

export const POTENTIAL_ASSET_DISPOSAL_STATUS = "POTENTIAL_ASSET_DISPOSAL";

/**
 * Narration words that mark a credit as the return of capital from a disposal.
 *
 * Deliberately narrow. Bare "settlement" and bare "sale" are excluded because
 * they appear on ordinary client receipts and shop takings; every phrase here
 * names a market, a depository or a redemption.
 */
export const ASSET_DISPOSAL_KEYWORDS = [
  "nccpl",
  "cdc",
  "central depository",
  "psx",
  "pakistan stock exchange",
  "stock exchange settlement",
  "broker settlement",
  "brokerage settlement",
  "settlement against sale",
  "sale of shares",
  "shares sold",
  "share sale",
  "scrip sold",
  "securities sold",
  "security sold",
  "sale of securities",
  "sale proceeds of securities",
  "mutual fund redemption",
  "fund redemption",
  "redemption proceeds",
  "unit redemption",
  "units redeemed",
  "sale of mutual fund units",
  "tfc redemption",
  "bond redemption",
  "sukuk redemption",
  "prize bond encashment",
  "defence savings certificate encashment",
  "dsc encashment",
  "behbood encashment",
] as const;

/**
 * What the operator must be told when a disposal credit is detected: the
 * money in the bank is not the number that belongs on the return.
 */
export const ASSET_SALE_PROCEEDS_NOTICE =
  "This credit is money received from selling an asset, not a gain. Tax is charged on the sale value minus the cost of acquisition, so the gain has to come from the capital gains statement (cost, sale value and dates). Leave this row as a disposal: do not book the full credit as income.";

export const CAPITAL_GAINS_GAIN_NOTICE =
  "A capital gain must be evidenced: sale value, cost of acquisition and the acquisition and disposal dates. Enter the gain from the CGT statement, not the amount that landed in the bank.";

/** True when a ledger category stands for a realised gain rather than proceeds. */
export function isCapitalGainsCategory(category: string | null | undefined) {
  return (
    String(category ?? "")
      .trim()
      .toUpperCase() === CAPITAL_GAINS_CATEGORY
  );
}

/** True when a ledger category stands for sale proceeds (never taxable alone). */
export function isAssetSaleProceedsCategory(category: string | null | undefined) {
  return (
    String(category ?? "")
      .trim()
      .toUpperCase() === ASSET_SALE_PROCEEDS_CATEGORY
  );
}

/**
 * Matches a narration against the disposal vocabulary. `matcher` is injected
 * so this module keeps using the repo's whole-word keyword matcher rather than
 * inventing a second one.
 */
export function looksLikeAssetDisposal(
  normalizedDescription: string,
  matcher: (haystack: string, needle: string) => boolean,
) {
  return ASSET_DISPOSAL_KEYWORDS.some((keyword) =>
    matcher(normalizedDescription, keyword),
  );
}
