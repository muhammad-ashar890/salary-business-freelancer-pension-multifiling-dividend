/**
 * Phase 5 — the approved statement's figures, placed on the IRIS 114(1)
 * Capital Gain sheet.
 *
 * The derivation produces the sheet's own shape; `capital-gains-portal-rows.ts`
 * turns that into fill instructions. This suite pins the placement rules
 * against the live capture (09-Nov-2026):
 *
 *   - a s.37 asset row takes cost, sale value and exempt; IRIS computes the
 *     gain column, so it is never written;
 *   - Gold (64340111) and Motor Vehicle (64340218) are fully computed on the
 *     captured sheet, so a figure on them is reported for manual entry;
 *   - a s.37A row takes the gain and the tax deducted; the tax-chargeable
 *     column is computed;
 *   - the summary rows (4000 / 4041 / 4043 / 999916 / 999917) are never
 *     written;
 *   - property (4042 / 64220050) only exists through the 116 Wealth
 *     Statement;
 *   - a s.151A debt-security gain is not a s.37A bucket and is reported
 *     separately.
 */

const fs = require("fs");
const path = require("path");
const ts = require("typescript");
const Module = require("module");

const projectRoot = path.join(__dirname, "..");
const originalResolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...rest) {
  if (request.startsWith("@/")) request = path.join(projectRoot, request.slice(2));
  return originalResolve.call(this, request, ...rest);
};
require.extensions[".ts"] = function (module, filename) {
  const source = fs.readFileSync(filename, "utf8");
  const output = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  }).outputText;
  module._compile(output, filename);
};

const source = require(path.join(projectRoot, "lib/tax/capital-gains-source.ts"));
const portal = require(path.join(projectRoot, "lib/tax/capital-gains-portal-rows.ts"));
const derivation = require(path.join(projectRoot, "lib/tax/capital-gains-derivation.ts"));
const fields = require(path.join(projectRoot, "lib/tax/capital-gains-fields.ts"));

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
const field = (label, value) => ({ label, value });

const row = (n, overrides = {}) => {
  const values = {
    assetType: "Jewellery",
    description: "Gold necklace",
    acquired: "2019-06-01",
    disposed: "2025-10-15",
    cost: "1200000",
    sale: "2000000",
    tax: "0",
    exempt: "0",
    ...overrides,
  };
  const suffix = n === 1 ? "" : ` ${n}`;
  return [
    field(`Capital Asset Type${suffix}`, values.assetType),
    field(`Asset Description / Scrip${suffix}`, values.description),
    field(`Date of Acquisition${suffix}`, values.acquired),
    field(`Date of Disposal${suffix}`, values.disposed),
    field(`Cost of Acquisition (PKR)${suffix}`, values.cost),
    field(`Sale / Transfer Value (PKR)${suffix}`, values.sale),
    field(`Exempt Gain (PKR)${suffix}`, values.exempt),
    field(`Tax Deducted (PKR)${suffix}`, values.tax),
  ];
};

const planFor = (fieldRows) => {
  const evaluation = source.evaluateCapitalGainsDocument({
    fields: fieldRows,
    reviewStatus: "APPROVED",
  });
  if (!evaluation.summary) {
    throw new Error(`statement refused: ${evaluation.errors.join(" ")}`);
  }
  return portal.buildCapitalGainsPortalPlan(evaluation.summary);
};

// ---------------------------------------------------------------------------
// 1 — a s.37 asset row: three cells typed, gain computed
// ---------------------------------------------------------------------------

const jewellery = planFor(row(1));
check("one row is produced", jewellery.rows.length, 1);
check("for the jewellery code", jewellery.rows[0].code, "64340213");
check("on the Capital Gain sheet", jewellery.rows[0].area, "Capital Gain");
check("with exactly the three typeable cells", jewellery.rows[0].cells, [
  { columnIndex: 0, column: "Cost of Acquisition", value: 1200000 },
  { columnIndex: 1, column: "Sale / Transfer Value", value: 2000000 },
  { columnIndex: 2, column: "Exempt", value: 0 },
]);
checkTrue(
  "the computed gain column is never written",
  jewellery.rows[0].cells.every((cell) => cell.column !== "Capital Gain / Loss"),
);
check("nothing is skipped", jewellery.skipped.filter((entry) => entry.value !== 0), []);

// ---------------------------------------------------------------------------
// 2 — Gold and Motor Vehicle are computed rows: manual entry, not a write
// ---------------------------------------------------------------------------

const gold = planFor(row(1, { assetType: "Gold", description: "Gold bars" }));
check("gold produces no writable row", gold.rows.length, 0);
check("it is reported as skipped", gold.skipped[0].code, "64340111");
checkTrue(
  "with the reason naming the disabled cells",
  gold.skipped[0].reason.includes("IRIS-computed"),
);
check("and a manual-entry note", gold.manualEntry, ["64340111 Gold"]);

const vehicle = planFor(
  row(1, { assetType: "Motor Vehicle", description: "Toyota Corolla" }),
);
check("a motor vehicle is skipped too", vehicle.skipped[0].code, "64340218");

// ---------------------------------------------------------------------------
// 3 — s.37A buckets: gain and tax deducted, in sheet order
// ---------------------------------------------------------------------------

const shares = planFor(
  row(1, {
    assetType: "Listed shares sold through NCCPL",
    description: "OGDC",
    acquired: "2020-03-01",
    disposed: "2025-09-30",
    cost: "2000000",
    sale: "2400000",
    tax: "50000",
  }),
);
check("the s.37A gain becomes one bucket row", shares.rows.map((r) => r.code), ["64220155"]);
// Captured evidence: the buckets live under Tax Deductions > Final Tax, not on
// the Capital Gain sheet (4043 there is a computed summary).
check("and it is placed on the Final Tax grid", shares.rows[0].area, "Tax Deductions");
check("with two cells only", shares.rows[0].cells.map((c) => c.column), [
  "Taxable Amount / Capital Gain / Loss",
  "Tax Deducted",
]);
check("never on the sheet's 4043 summary", shares.rows.some((r) => r.code === "4043"), false);
check("with gain and tax deducted", shares.rows[0].cells, [
  { columnIndex: 0, column: "Taxable Amount / Capital Gain / Loss", value: 400000 },
  { columnIndex: 1, column: "Tax Deducted", value: 50000 },
]);

// Several buckets are written top to bottom, in the order the derivation gave.
const mixed = planFor([
  ...row(1, {
    assetType: "Listed shares sold through NCCPL",
    description: "OGDC",
    acquired: "2020-03-01",
    disposed: "2025-09-30",
    cost: "2000000",
    sale: "2400000",
    tax: "50000",
  }),
  ...row(2, {
    assetType: "Listed shares sold through NCCPL",
    description: "PSO",
    acquired: "2024-08-01",
    disposed: "2025-06-01",
    cost: "1000000",
    sale: "1300000",
    tax: "45000",
  }),
]);
check(
  "two vintages produce two bucket rows",
  mixed.rows.map((r) => r.code),
  ["64220155", "64220156"],
);
check(
  "ordered for a top-to-bottom fill",
  mixed.rows.map((r) => r.order),
  [0, 1],
);

// ---------------------------------------------------------------------------
// 4 — a mixed statement: both sections, one plan
// ---------------------------------------------------------------------------

const bothSections = planFor([
  ...row(1, {
    assetType: "Listed shares sold through NCCPL",
    description: "OGDC",
    acquired: "2020-03-01",
    disposed: "2025-09-30",
    cost: "2000000",
    sale: "2400000",
    tax: "50000",
  }),
  ...row(2),
]);
check(
  "an asset row and a securities row are both planned",
  bothSections.rows.map((r) => r.code),
  ["64340213", "64220155"],
);
check("each with its own cell count", bothSections.rows.map((r) => r.cells.length), [3, 2]);

// ---------------------------------------------------------------------------
// 5 — summary rows are never written
// ---------------------------------------------------------------------------

const summaryCodes = ["4000", "4041", "4042", "4043", "999916", "999917"];
check(
  "no summary row appears in the fill plan",
  jewellery.rows
    .concat(mixed.rows)
    .filter((entry) => summaryCodes.includes(entry.code))
    .map((entry) => entry.code),
  [],
);
check(
  "property is reported as unfillable from a statement",
  jewellery.skipped.some((entry) => entry.code === "64220050"),
  true,
);
checkTrue(
  "with the 116 route named",
  jewellery.skipped.find((entry) => entry.code === "64220050").reason.includes(
    "116 Wealth Statement",
  ),
);

// ---------------------------------------------------------------------------
// 6 — a debt-security gain is not a s.37A bucket
// ---------------------------------------------------------------------------

const debt = planFor(
  row(1, {
    assetType: "TFC",
    description: "Habib Bank TFC 2021",
    acquired: "2020-03-01",
    disposed: "2025-09-30",
    cost: "1000000",
    sale: "2000000",
    tax: "150000",
  }),
);
check("a debt-security gain writes no sheet row", debt.rows, []);
check(
  "and is reported separately",
  debt.skipped.find((entry) => entry.label.includes("151A")).value,
  1000000,
);

// ---------------------------------------------------------------------------
// 7 — the plan agrees with the sheet contract
// ---------------------------------------------------------------------------

const assetCodes = fields.CAPITAL_ASSET_TYPES.map((type) => type.code);
check(
  "every planned asset code is on the captured sheet",
  jewellery.rows
    .concat(bothSections.rows)
    .filter((entry) => entry.code.startsWith("6434"))
    .filter((entry) => !assetCodes.includes(entry.code)),
  [],
);
const bucketCodes = fields.SECURITIES_GAIN_BUCKETS.map((bucket) => bucket.code);
check(
  "every planned securities code is a captured bucket",
  mixed.rows.filter((entry) => !bucketCodes.includes(entry.code)),
  [],
);
check(
  "every bucket row's first cell is the gain column",
  mixed.rows.every(
    (row_) => row_.cells[0].column === "Taxable Amount / Capital Gain / Loss",
  ),
  true,
);

// ---------------------------------------------------------------------------
// 8 — the description is honest about what needs a human
// ---------------------------------------------------------------------------

checkTrue(
  "the one-line description counts rows and cells",
  portal.describeCapitalGainsPortalPlan(mixed).includes("2 row(s), 4 cell(s)"),
);
checkTrue(
  "and calls out manual entry",
  portal
    .describeCapitalGainsPortalPlan(
      planFor(row(1, { assetType: "Gold", description: "Gold bars" })),
    )
    .includes("manual entry"),
);

// ---------------------------------------------------------------------------
// 9 — the derivation and the plan never disagree on an amount
// ---------------------------------------------------------------------------

const summary = derivation.deriveCapitalGainsSummary([
  {
    id: "d1",
    assetType: "jewelry",
    costOfAcquisition: 1200000,
    saleValue: 2000000,
    acquiredOn: "2019-06-01",
    disposedOn: "2025-10-15",
    quantity: null,
    exemptGain: 100000,
    taxDeducted: 0,
    description: null,
    instrumentKind: null,
    soldThroughNccplOrPsx: false,
  },
]);
const directPlan = portal.buildCapitalGainsPortalPlan(summary);
check(
  "the exempt column carries the statement's exemption",
  directPlan.rows[0].cells[2],
  { columnIndex: 2, column: "Exempt", value: 100000 },
);
check(
  "and cost/sale are the statement's own figures",
  [directPlan.rows[0].cells[0].value, directPlan.rows[0].cells[1].value],
  [1200000, 2000000],
);

// ---------------------------------------------------------------------------
// 10 — immovable property is routed to the 116 Wealth Statement
// ---------------------------------------------------------------------------

const propertyStatement = source.evaluateCapitalGainsDocument({
  fields: row(1, { assetType: "Immovable property", description: "Plot 12, DHA Phase 6" }),
  reviewStatus: "APPROVED",
});
check("a property disposal is refused", propertyStatement.ok, false);
checkTrue(
  "and the message names the 116 statement",
  String(propertyStatement.errors[0]).includes("116 Wealth Statement"),
);
checkTrue(
  "not the generic \"say what was sold\" message",
  !String(propertyStatement.errors[0]).includes("say what was sold"),
);

check(
  "a plot is recognised as immovable property",
  source.looksLikeImmovableProperty("Immovable property", "Plot 12"),
  true,
);
check(
  "a listed share is not",
  source.looksLikeImmovableProperty("Listed shares sold through NCCPL", "OGDC"),
  false,
);

// ---------------------------------------------------------------------------

if (failures.length > 0) {
  console.error(`\ncapital-gains-portal-rows: ${failures.length} of ${assertionCount} checks failed\n`);
  for (const failure of failures) console.error(`  ✗ ${failure}`);
  process.exit(1);
}

console.log(
  `capital-gains-portal-rows: ${assertionCount} checks passed — ` +
    `the statement's figures are placed on the captured 114(1) Capital Gain sheet, ` +
    `computed cells and summary rows are never written, and gold/motor-vehicle/property are handed back for manual entry.`,
);
