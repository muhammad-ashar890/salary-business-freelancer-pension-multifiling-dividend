/**
 * Phase 0 — the capital gains data contract.
 *
 * Every expectation below is transcribed from the FBR IRIS 114(1) captures
 * taken on 09-Nov-2026 (Capital Gain tab, its two popups, and the Tax
 * Deductions tab). The suite is deliberately pedantic about two things:
 *
 *   1. The codes are the ones the form actually shows. The 4006/4016/4017/
 *      4026/4036/4037 codes that used to sit in iris-field-codes.ts are NOT
 *      on the form, so this suite fails if they come back.
 *   2. Nothing is priced or placed by guess. A security whose 15% bucket is
 *      ambiguous must come back as a review problem with both candidates, not
 *      as a coin flip.
 */

const fs = require("fs");
const path = require("path");
const ts = require("typescript");
const Module = require("module");

const projectRoot = path.join(__dirname, "..");

const originalResolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...rest) {
  if (request.startsWith("@/")) {
    request = path.join(projectRoot, request.slice(2));
  }
  return originalResolve.call(this, request, ...rest);
};
require.extensions[".ts"] = function (module, filename) {
  const source = fs.readFileSync(filename, "utf8");
  const output = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  }).outputText;
  module._compile(output, filename);
};

const fields = require(path.join(projectRoot, "lib/tax/capital-gains-fields.ts"));
const derivation = require(path.join(projectRoot, "lib/tax/capital-gains-derivation.ts"));

const failures = [];
let assertionCount = 0;

function check(label, actual, expected) {
  assertionCount += 1;
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) failures.push(`${label}: expected ${e}, received ${a}`);
}

function checkTrue(label, value) {
  check(label, Boolean(value), true);
}

// ---------------------------------------------------------------------------
// 1 — the four summary rows of the Capital Gain tab
// ---------------------------------------------------------------------------

check(
  "the four summary codes are the captured ones",
  fields.CAPITAL_GAINS_SECTION_CODES,
  { totalCapitalGain: "4000", capitalAssets37: "4041", property37_1A: "4042", securities37A: "4043" },
);

for (const section of fields.CAPITAL_GAINS_SHEET_SECTIONS) {
  check(`s.${section.key} summary row is fully computed`, section.row.cells.every((c) => c.disabled), true);
}

check(
  "the 4000 row has the four sheet columns",
  fields.CAPITAL_GAINS_SHEET_SECTIONS[0].row.cells.map((c) => c.label),
  ["Total Amount", "Subject to Final Tax", "Subject to Exemption", "Subject to Normal Tax"],
);

// ---------------------------------------------------------------------------
// 2 — s.37: one row per asset type, exactly the eight the popup offers
// ---------------------------------------------------------------------------

check(
  "all eight s.37 asset types, in capture order",
  fields.CAPITAL_ASSET_TYPES.map((type) => type.code),
  [
    "64340217",
    "64340216",
    "64340213",
    "64340214",
    "64340111",
    "64340215",
    "64340218",
    "64340219",
  ],
);

check(
  "six of the eight rows let cost, sale and exempt be typed",
  fields.CAPITAL_ASSET_TYPES.filter((type) => type.enterable).map((type) => type.code),
  ["64340217", "64340216", "64340213", "64340214", "64340215", "64340219"],
);

check(
  "Gold and Motor Vehicle have no enterable cell",
  fields.CAPITAL_ASSET_TYPES.filter((type) => !type.enterable).map((type) => type.label),
  ["Gold", "Motor Vehicle"],
);

check(
  "an enterable s.37 row exposes exactly cost, sale, exempt and a computed gain",
  fields.getCapitalAssetType("jewelry").cells.map((c) => [c.label, c.disabled]),
  [
    ["Cost of Acquisition", false],
    ["Sale / Transfer Value", false],
    ["Exempt", false],
    ["Capital Gain / Loss", true],
  ],
);

check("the asset-type keys are unique", new Set(fields.CAPITAL_ASSET_TYPES.map((t) => t.key)).size, 8);

// ---------------------------------------------------------------------------
// 3 — s.37A: ten Final Tax buckets, the four date windows, the rest by instrument
// ---------------------------------------------------------------------------

check(
  "ten 37A buckets, in sheet order",
  fields.SECURITIES_GAIN_BUCKETS.map((bucket) => bucket.code),
  [
    "64220151",
    "64220155",
    "64220162",
    "64220156",
    "64220158",
    "64220161",
    "64220159",
    "64220157",
    "64220153",
    "64220152",
  ],
);

check(
  "the date-driven windows and their rates",
  fields.SECURITIES_GAIN_BUCKETS.filter((b) => !b.requiresInstrumentSelection).map((b) => [
    b.code,
    b.ratePercent,
  ]),
  [
    ["64220151", 0],
    ["64220155", 12.5],
    ["64220162", 10],
    ["64220156", 15],
  ],
);

check(
  "the five instrument-priced rows are flagged as such",
  fields.SECURITIES_GAIN_BUCKETS.filter((b) => b.requiresInstrumentSelection).map((b) => b.code),
  ["64220158", "64220161", "64220159", "64220157", "64220153", "64220152"],
);

check("the Final Tax summary code is 999916", fields.SECURITIES_FINAL_TAX_SUMMARY_CODE, "999916");

check(
  "a 37A bucket types taxable amount and tax deducted, IRIS computes tax chargeable",
  fields.getSecuritiesGainBucket("64220156").cells.map((c) => [c.label, c.disabled]),
  [
    ["Taxable Amount", false],
    ["Tax Deducted", false],
    ["Tax Chargeable", true],
  ],
);

// ---------------------------------------------------------------------------
// 4 — s.37(1A): the row cannot be produced without the 116 wealth statement
// ---------------------------------------------------------------------------

checkTrue("the property branch is gated on the wealth statement", fields.PROPERTY_ROW_REQUIRES_WEALTH_STATEMENT);
check("the property codes are the captured pair", fields.PROPERTY_SECTION_CODES, {
  summaryCapitalGainTab: "4042",
  finalTaxRow: "64220050",
  finalTaxSummary: "999916",
});
checkTrue(
  "the capture's own refusal is kept as the hint",
  fields.PROPERTY_ROW_CAPTURE_HINT.includes("Wealth Statement"),
);

// ---------------------------------------------------------------------------
// 5 — the non-resident 152(1DA) row
// ---------------------------------------------------------------------------

check("the non-resident row is 64050050", fields.NON_RESIDENT_DEBT_GAIN_ROW.code, "64050050");
check(
  "only its first two cells are enterable",
  fields.NON_RESIDENT_DEBT_GAIN_ROW.cells.map((c) => !c.disabled),
  [true, true, false, false, false, false],
);

// ---------------------------------------------------------------------------
// 6 — regression: the codes that are not on the form must not come back
// ---------------------------------------------------------------------------

const source = fs.readFileSync(path.join(projectRoot, "lib/tax/capital-gains-fields.ts"), "utf8");
const body = source.slice(source.indexOf("export const CAPITAL_GAINS_SECTION_CODES"));
for (const legacy of ["4006", "4016", "4017", "4026", "4036", "4037"]) {
  check(`legacy code ${legacy} is absent from the module`, body.includes(legacy), false);
}

// ---------------------------------------------------------------------------
// 7 — derivation: disposals are summed into the IRIS rows
// ---------------------------------------------------------------------------

const jewelry = derivation.deriveCapitalGainsSummary([
  {
    id: "d1",
    costOfAcquisition: 1_200_000,
    saleValue: 2_000_000,
    acquiredOn: "2020-01-10",
    disposedOn: "2025-10-01",
    assetType: "jewelry",
  },
  {
    id: "d2",
    costOfAcquisition: 300_000,
    saleValue: 500_000,
    acquiredOn: "2021-03-05",
    disposedOn: "2025-11-01",
    assetType: "jewelry",
  },
]);

check("two jewellery disposals become one IRIS row", jewelry.rows.length, 1);
check("the row is the jewellery code", jewelry.rows[0].code, "64340213");
check("cost is summed", jewelry.rows[0].costOfAcquisition, 1_500_000);
check("sale is summed", jewelry.rows[0].saleValue, 2_500_000);
check("the gain is sale minus cost", jewelry.rows[0].gain, 1_000_000);
check("no exempt amount means the whole gain is taxable", jewelry.rows[0].taxableGain, 1_000_000);
check("both disposals are traceable from the row", jewelry.rows[0].disposalIds, ["d1", "d2"]);
check("a clean sheet has no problems", jewelry.problems, []);
check("the section total rolls up", jewelry.totals.taxableGain, 1_000_000);

const withExempt = derivation.deriveCapitalGainsSummary([
  {
    id: "e1",
    costOfAcquisition: 1_000_000,
    saleValue: 4_000_000,
    exemptGain: 500_000,
    acquiredOn: "2019-06-01",
    disposedOn: "2025-09-01",
    assetType: "painting",
  },
]);
check("exempt gain is subtracted from the taxable gain", withExempt.rows[0].taxableGain, 2_500_000);

const gold = derivation.deriveCapitalGainsSummary([
  {
    id: "g1",
    costOfAcquisition: 500_000,
    saleValue: 800_000,
    acquiredOn: "2018-01-01",
    disposedOn: "2025-08-01",
    assetType: "gold",
  },
]);
check("a Gold disposal still totals", gold.rows[0].gain, 300_000);
check("but its row is marked not enterable", gold.rows[0].enterable, false);

// ---------------------------------------------------------------------------
// 8 — s.37A routing: through the exchange means securities, not s.37
// ---------------------------------------------------------------------------

const securities = derivation.deriveCapitalGainsSummary([
  {
    id: "s1",
    costOfAcquisition: 1_000_000,
    saleValue: 1_500_000,
    taxDeducted: 75_000,
    acquiredOn: "2015-02-01",
    disposedOn: "2025-10-20",
    soldThroughNccplOrPsx: true,
    instrumentKind: "listed-share",
  },
  {
    id: "s2",
    costOfAcquisition: 2_000_000,
    saleValue: 2_400_000,
    taxDeducted: 40_000,
    acquiredOn: "2023-01-15",
    disposedOn: "2025-10-21",
    soldThroughNccplOrPsx: true,
    instrumentKind: "listed-share",
  },
]);

check(
  "a 2015 acquisition lands in the 12.5% bucket and a 2023 one in the 10% bucket",
  securities.securitiesBuckets.map((b) => [b.code, b.taxableGain, b.taxDeducted]),
  [
    ["64220155", 500_000, 75_000],
    ["64220162", 400_000, 40_000],
  ],
);

check("the securities total is the sum of the buckets", securities.totals.taxableGain, 900_000);
check("a share sold outside NCCPL is a s.37 row, not a 37A bucket", (() => {
  const outside = derivation.deriveCapitalGainsSummary([
    {
      id: "o1",
      costOfAcquisition: 100_000,
      saleValue: 150_000,
      acquiredOn: "2022-01-01",
      disposedOn: "2025-05-01",
      assetType: "shares-company-outside-nccpl",
    },
  ]);
  return outside.rows.map((row) => [row.source, row.code]);
})(), [["capital_assets_37", "64340216"]]);

// ---------------------------------------------------------------------------
// 9 — the 15% ambiguity is a review problem, never a guess
// ---------------------------------------------------------------------------

const ambiguous = derivation.deriveCapitalGainsSummary([
  {
    id: "a1",
    costOfAcquisition: 1_000_000,
    saleValue: 1_300_000,
    acquiredOn: "2024-09-01",
    disposedOn: "2025-10-01",
    soldThroughNccplOrPsx: true,
  },
]);
check("an unclassified post-2024 security is refused", ambiguous.rows.length, 0);
check("and both 15% candidates are named", ambiguous.problems, [
  {
    kind: "security_without_rate_bucket",
    disposalId: "a1",
    candidates: ["64220156", "64220158"],
  },
]);
check("a refused disposal does not enter the totals", ambiguous.totals.taxableGain, 0);

check(
  "the same disposal resolves once the instrument is named (listed share)",
  derivation.resolveSecuritiesBucket({
    id: "a2",
    costOfAcquisition: 1,
    saleValue: 2,
    acquiredOn: "2024-09-01",
    disposedOn: "2025-10-01",
    soldThroughNccplOrPsx: true,
    instrumentKind: "listed-share",
  }).code,
  "64220156",
);

check(
  "and to the fund row when it is a fund or REIT",
  derivation.resolveSecuritiesBucket({
    id: "a3",
    costOfAcquisition: 1,
    saleValue: 2,
    acquiredOn: "2024-09-01",
    disposedOn: "2025-10-01",
    soldThroughNccplOrPsx: true,
    instrumentKind: "mutual-fund-or-reit",
  }).code,
  "64220158",
);

check(
  "the PMEX row is reached only by naming the instrument",
  derivation.resolveSecuritiesBucket({
    id: "a4",
    costOfAcquisition: 1,
    saleValue: 2,
    acquiredOn: "2024-09-01",
    disposedOn: "2025-10-01",
    soldThroughNccplOrPsx: true,
    instrumentKind: "pmex-cash-settled",
  }).code,
  "64220153",
);

// ---------------------------------------------------------------------------
// 10 — validation problems
// ---------------------------------------------------------------------------

const missingDate = derivation.deriveCapitalGainsSummary([
  {
    id: "m1",
    costOfAcquisition: 100,
    saleValue: 200,
    acquiredOn: null,
    disposedOn: "2025-01-01",
    soldThroughNccplOrPsx: true,
    instrumentKind: "listed-share",
  },
]);
checkTrue(
  "a missing acquisition date is reported",
  missingDate.problems.some((p) => p.kind === "missing_disposal_date" && p.field === "acquiredOn"),
);
check("and the row is withheld from the money", missingDate.rows.length, 0);

check(
  "a disposal dated before its acquisition is reported",
  derivation
    .listDisposalProblems({
      id: "x1",
      costOfAcquisition: 100,
      saleValue: 200,
      acquiredOn: "2025-06-01",
      disposedOn: "2025-01-01",
      assetType: "others",
    })
    .map((p) => p.kind),
  ["disposal_before_acquisition"],
);

check(
  "an exemption larger than the gain is reported",
  derivation
    .listDisposalProblems({
      id: "x2",
      costOfAcquisition: 1000,
      saleValue: 1500,
      exemptGain: 900,
      acquiredOn: "2020-01-01",
      disposedOn: "2025-01-01",
      assetType: "others",
    })
    .map((p) => p.kind),
  ["exempt_exceeds_gain"],
);

check(
  "a negative amount is reported",
  derivation
    .listDisposalProblems({
      id: "x3",
      costOfAcquisition: -5,
      saleValue: 200,
      acquiredOn: "2020-01-01",
      disposedOn: "2025-01-01",
      assetType: "others",
    })
    .map((p) => p.kind),
  ["negative_amount"],
);

check(
  "a disposal with neither an asset type nor an instrument is refused",
  derivation
    .listDisposalProblems({
      id: "x4",
      costOfAcquisition: 100,
      saleValue: 200,
      acquiredOn: "2020-01-01",
      disposedOn: "2025-01-01",
    })
    .map((p) => p.kind),
  ["unknown_asset_type"],
);

// ---------------------------------------------------------------------------
// 11 — holding period helpers (the LT/ST split s.37A rates depend on)
// ---------------------------------------------------------------------------

check("a 471-day holding period is measured in days", derivation.holdingPeriodDays("2024-01-01", "2025-04-16"), 471);
check("less than a year is short term", derivation.isLongTerm("2024-09-01", "2025-06-01"), false);
check("more than a year is long term", derivation.isLongTerm("2023-01-01", "2025-01-02"), true);
check("no dates means no answer", derivation.isLongTerm(null, "2025-01-01"), null);

// ---------------------------------------------------------------------------
// 12 — the sheet the module writes to is internally consistent
// ---------------------------------------------------------------------------

const allCodes = [
  ...Object.values(fields.CAPITAL_GAINS_SECTION_CODES),
  ...fields.CAPITAL_ASSET_TYPES.map((t) => t.code),
  ...fields.SECURITIES_GAIN_BUCKETS.map((b) => b.code),
  fields.PROPERTY_SECTION_CODES.finalTaxRow,
  fields.NON_RESIDENT_DEBT_GAIN_ROW.code,
];
check("every code in the module is unique", new Set(allCodes).size, allCodes.length);
checkTrue(
  "s.37 asset rows are all 6434xxxx",
  fields.CAPITAL_ASSET_TYPES.every((t) => t.code.startsWith("6434")),
);
checkTrue(
  "37A buckets are all 6422xxxx",
  fields.SECURITIES_GAIN_BUCKETS.every((b) => b.code.startsWith("6422")),
);

// ---------------------------------------------------------------------------

if (failures.length > 0) {
  console.error(`\ncapital-gains-fields: ${failures.length} of ${assertionCount} checks failed\n`);
  for (const failure of failures) console.error(`  ✗ ${failure}`);
  process.exit(1);
}

console.log(
  `capital-gains-fields: ${assertionCount} checks passed — ` +
    `${fields.CAPITAL_ASSET_TYPES.length} s.37 asset rows, ` +
    `${fields.SECURITIES_GAIN_BUCKETS.length} s.37A buckets, ` +
    `property gated on the 116 wealth statement.`,
);
