"use strict";
const {readWealthTotals,checkPreviousReturn}=require("./iris-other-sources-wealth");

const driver = require("./iris-tax-deduction-driver");

// Only cash §150 rows. §236Z needs its own non-cash asset/payment evidence;
// Capital Gains and Bank Profit are deliberately absent from this contract.
const CASH_DIVIDEND_LABELS = Object.freeze({
  "64030052": "Dividend u/s 150 @7.5%",
  "64030055": "Dividend u/s 150 @15%",
  "64030090": "Person receiving dividend from a company where the company's income is exempt from tax u/s 5 (@ 25% u/s 150)",
  "64330050": "Dividend u/s 150 - Dividend received from debt securities / mutual funds",
  "64330066": "Dividend u/s 150 @0%",
  "64030064": "Dividend u/s 150 (ATL @ 35% / Non-ATL @ 70%)",
});

/** Refuse old/malformed/unscoped packets BEFORE acquiring a portal window. */
function getDividendPacketRoute(snapshot) {
  let sources = snapshot?.filing?.incomeSources ?? [];
  try { if (typeof sources === "string") sources = JSON.parse(sources); } catch { sources = []; }
  sources = Array.isArray(sources) ? sources.map(String) : [];
  const plan = snapshot?.otherSources?.taxDeductions;
  const selected = sources.includes("dividend") || Boolean(plan);
  const fail = (reason) => ({selected, active: false, reason, agentFields: []});
  if (!selected) return fail("not_selected");
  if (sources.length !== 1 || sources[0] !== "dividend" || Number(snapshot?.filing?.taxYear) !== 2026 || snapshot?.filing?.filerType !== "myself") return fail("unsupported_dividend_source_set");
  if (plan?.version !== "dividend-final-tax-v1" || !Array.isArray(plan.agentFields) || !plan.agentFields.length || typeof plan.evidenceFingerprint !== "string" || !plan.evidenceFingerprint.trim()) return fail("dividend_payload_missing_or_stale");
  const seen = new Set();
  let gross = 0, withheld = 0;
  for (const field of plan.agentFields) {
    if (!field || !Object.hasOwn(CASH_DIVIDEND_LABELS, String(field.irisCode)) || field.label !== CASH_DIVIDEND_LABELS[String(field.irisCode)] || seen.has(String(field.irisCode))) return fail("dividend_row_not_allowlisted_or_duplicate");
    seen.add(String(field.irisCode));
    const checked = driver.prepareTaxDeductionField(field, {regimes: driver.OTHER_SOURCES_REGIMES, typedRegimes: driver.OTHER_SOURCES_TYPED_REGIMES, typedCells: driver.OTHER_SOURCES_TYPED_CELLS});
    if (!checked.valid || field.values.length !== 2 || field.regime !== "final" || field.cells !== "EED") return fail("dividend_grid_contract_mismatch");
    const amount = Number(field.values.find((value) => value.columnIndex === 0)?.value);
    const tax = Number(field.values.find((value) => value.columnIndex === 1)?.value);
    if (!Number.isSafeInteger(amount) || amount <= 0 || !Number.isSafeInteger(tax) || tax < 0 || tax > amount) return fail("dividend_amount_invalid");
    gross += amount; withheld += tax;
    if (!Number.isSafeInteger(gross) || !Number.isSafeInteger(withheld)) return fail("dividend_amount_overflow");
  }
  if (plan.wealth?.finalTaxIncome?.irisCode !== "7033" || plan.wealth.finalTaxIncome.readOnly !== true || plan.wealth.finalTaxIncome.expected !== gross || plan.wealth?.taxOutflow?.irisCode !== "7098" || plan.wealth.taxOutflow.section !== "150" || plan.wealth.taxOutflow.amount !== withheld || plan.wealth.netBankCredits !== gross - withheld) return fail("dividend_wealth_proof_mismatch");
  const map = snapshot?.portalFieldMap;
  const wealthFields = Array.isArray(map) ? map.filter((field) => field.sourceGroup === "wealthFields") : (map?.wealthFields || []);
  const outflows = wealthFields.filter((field) => String(field.irisCode) === "7098");
  if ((withheld > 0 && (outflows.length !== 1 || outflows[0].rowDescriptionIncludes !== "Income tax deducted u/s 150" || Number(outflows[0].value ?? outflows[0].ourAmount) !== withheld)) || (withheld === 0 && outflows.length !== 0)) return fail("dividend_wealth_outflow_missing_or_duplicate");
  return {selected, active: true, reason: "verified_cash_dividend", agentFields: plan.agentFields, wealth: plan.wealth};
}

/** The same guarded driver as Business, with only its exact Other Sources spec. */
async function fillDividendEntries(windowInstance, route, options = {}) {
  if (!route?.active) throw new Error("Dividend route is not verified; no portal action is allowed.");
  return driver.fillTaxDeductions(windowInstance, route.agentFields, {
    ...options,
    spec: driver.OTHER_SOURCES_SPEC,
    sectionId: driver.OTHER_SOURCES_SECTION_ID,
    sourceGroup: "incomeFields",
    censusView: driver.OTHER_SOURCES_CENSUS_VIEW,
    typedRegimes: driver.OTHER_SOURCES_TYPED_REGIMES,
    typedCells: driver.OTHER_SOURCES_TYPED_CELLS,
  });
}

/** Read-only final Wealth checks; never type 7033 or invent a 703000 plug. */
function checkDividendWealth(route, irisTotals, parseAmount) {
  if (!route?.active) return {ok: false, reason: "dividend_route_not_verified"};
  const read = (code) => {
    const raw = irisTotals?.[code];
    if (raw === null || raw === undefined || !String(raw).trim()) return null;
    const amount = typeof parseAmount === "function" ? parseAmount(raw) : Number(String(raw).replace(/,/g, ""));
    return Number.isFinite(amount) ? amount : null;
  };
  const finalTaxIncome = read("7033"), unreconciled = read("703000");
  const ok = finalTaxIncome !== null && finalTaxIncome === route.wealth.finalTaxIncome.expected && unreconciled === 0;
  return {ok, reason: ok ? "dividend_wealth_verified" : "Dividend Wealth readback must show certified gross on 7033 and zero on 703000. Missing or mismatched figures block completion; nothing is plugged.", finalTaxIncome, expected: route.wealth.finalTaxIncome.expected, unreconciled};
}

/** Completion needs exact cell readback AND fresh Wealth totals after a Save. */
function checkDividendCompletion(route, {saveOutcome, censusAfterSave, results, census}) {
  if (!route?.active) return {ok: false, reason: "dividend_route_not_verified"};
  if (!saveOutcome?.clicked || saveOutcome.dialog && !saveOutcome.dialog.closed || !censusAfterSave?.complete) {
    return {ok: false, reason: "Dividend draft Save and complete post-Save readback are required; review the return in FBR."};
  }
  const checks = census.compareTypedEntries(censusAfterSave, results);
  const expectedCells = route.agentFields.reduce((sum, field) => sum + field.values.length, 0);
  const dividendResults = results.filter(entry => entry.censusView === "Other Sources > Tax Deductions");
  const proof = readWealthTotals(censusAfterSave,census.parseIrisAmount);
  const wealth = checkDividendWealth(route, proof.totals, census.parseIrisAmount);
  const ok = dividendResults.length === expectedCells && checks.length === results.length && checks.every(check => check.status === "match") && wealth.ok;
  return {ok, reason: ok ? "dividend_post_save_verified" : "Dividend post-Save cell or Wealth readback is missing or mismatched; review the return in FBR.", checks, wealth};
}

module.exports = {readWealthTotals,checkPreviousReturn,CASH_DIVIDEND_LABELS, getDividendPacketRoute, fillDividendEntries, checkDividendWealth, checkDividendCompletion};
