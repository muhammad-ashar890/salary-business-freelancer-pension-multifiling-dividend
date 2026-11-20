"use strict";
/**
 * Bank Profit — read-only "what is already in IRIS?" guard.
 *
 * Mirrors `iris-dividend-existing-income.js`. The packet cannot see rows that
 * are already saved on the IRIS Other Sources > Tax Deductions grid, so before
 * a single cell is typed this reads the grid and compares it with the approved
 * Bank Profit plan. Anything that does not match pauses the run and changes
 * nothing: no overwrite, no delete, no balancing figure.
 *
 * Bank Profit rows are the four §151 Final Tax codes with their exact captured
 * descriptions. Detail rows (Investment children) repeat their parent code, so
 * they are grouped by code before comparing — never summed twice.
 */
const VIEW = "Other Sources > Tax Deductions";

/** The only codes this route may ever own, with their exact IRIS descriptions. */
const BANK_PROFIT_ROWS = Object.freeze({
  "64040052": "Profit on Debt u/s 151(1)(b) from Bank Accounts / Deposits",
  "64040054": "151(1) (d) - Profit on Debt u/s 151 from Others",
  "64330054": "Return on Investment in Sukuks u/s 151(1A) @ 10%",
  "64330055": "Return on Investment in Sukuks u/s 151(1A) @ 12.5%",
});

function amount(value) {
  if (value === null || value === undefined || String(value).trim() === "") return 0;
  const text = String(value).trim().replace(/,/g, "");
  return /^-?\d+(\.\d+)?$/.test(text) && Number.isFinite(Number(text))
    ? Number(text)
    : null;
}

/**
 * Read-only comparison, grouped by IRIS code. Never adds a parent and its
 * detail children together — a code is represented by at most one summary row,
 * and anything else is reported for review instead of being interpreted.
 */
function checkExistingBankProfitIncome(census, route) {
  const fail = (reason) => ({ ok: false, reason, conflicts: [] });
  if (!route?.active) return fail("Bank Profit route is not verified.");
  const views = (census?.views || []).filter((view) => view.key === VIEW);
  if (
    !census?.complete ||
    views.length !== 1 ||
    !views[0].ok ||
    !Array.isArray(views[0].rows) ||
    views[0].dialogsOpen
  )
    return fail(
      "Existing IRIS income could not be checked completely. No values will be entered.",
    );

  // Code -> planned (gross, tax) for every approved Bank Profit row.
  const planned = new Map();
  for (const row of route.rows || []) {
    const code = String(row.irisCode || "");
    if (!Object.hasOwn(BANK_PROFIT_ROWS, code)) continue;
    const gross = Number(row.values?.find((value) => value.columnIndex === 0)?.value);
    const tax = Number(row.values?.find((value) => value.columnIndex === 1)?.value);
    planned.set(code, { gross, tax });
  }

  const grouped = new Map();
  for (const row of views[0].rows) {
    const code = String(row.code || "");
    if (!/^\d+$/.test(code)) return fail("An IRIS tax row could not be identified.");
    // Grid header rows are never income.
    if (code === "999918" || code === "999919") continue;
    const gross = amount(row.cells?.[0]?.value);
    const tax = amount(row.cells?.[1]?.value);
    if (gross === null || tax === null)
      return fail("An existing IRIS amount could not be read safely.");
    if (!gross && !tax) continue;
    const list = grouped.get(code) || [];
    list.push({
      code,
      description: row.description || code,
      gross,
      tax,
      detail: /--/.test(row.description || ""),
    });
    grouped.set(code, list);
  }

  const conflicts = [];
  for (const [code, rows] of grouped) {
    // A single non-empty row for a code is unambiguous — including an
    // Investment detail child whose (blank, read-only) parent row was already
    // skipped above. Only several non-empty rows need parent/summary
    // disambiguation, and anything ambiguous is reported, never summed.
    let row = rows[0];
    if (rows.length > 1) {
      const summaries = rows.filter((entry) => !entry.detail);
      if (summaries.length > 1) {
        conflicts.push({ ...summaries[0], reason: "multiple existing rows require review" });
        continue;
      }
      if (!summaries.length) {
        conflicts.push({
          ...rows[0],
          reason: "several detail rows for one code require review",
        });
        continue;
      }
      row = summaries[0];
    }
    if (!Object.hasOwn(BANK_PROFIT_ROWS, code)) {
      // Any non-Bank-Profit row already on the grid is outside this packet.
      conflicts.push({ ...row, reason: "not included in the approved Bank Profit-only packet" });
      continue;
    }
    const values = planned.get(code);
    if (!values) {
      conflicts.push({ ...row, reason: "row exists in IRIS but is not part of the approved packet" });
      continue;
    }
    if (row.gross !== values.gross || row.tax !== values.tax)
      conflicts.push({ ...row, reason: "differs from the approved packet" });
  }

  return {
    ok: conflicts.length === 0,
    reason: conflicts.length
      ? "Existing IRIS income or withholding differs from this Bank Profit-only filing."
      : "Existing Other Sources tax rows match the packet or are empty.",
    conflicts,
  };
}

module.exports = { checkExistingBankProfitIncome, VIEW, BANK_PROFIT_ROWS };
