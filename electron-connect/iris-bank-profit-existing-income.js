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

function normDescription(value) {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

function isDetailRow(code, description) {
  if (/--/.test(description || "")) return true;
  const base = BANK_PROFIT_ROWS[code];
  if (!base) return false;
  const normDesc = normDescription(description);
  const normBase = normDescription(base);
  return normDesc.startsWith(`${normBase} -`) || normDesc.startsWith(`${normBase}-`);
}

/**
 * Read-only comparison, grouped by IRIS code. Never adds a parent and its
 * detail children together — a single-row category allows at most one summary
 * row, while multi-certificate Investment categories match each child row by
 * its normalized Investment description.
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

  // Code -> list of planned (gross, tax, detailDescription) entries.
  const planned = new Map();
  for (const row of route.rows || []) {
    const code = String(row.irisCode || "");
    if (!Object.hasOwn(BANK_PROFIT_ROWS, code)) continue;
    const gross = Number(row.values?.find((value) => value.columnIndex === 0)?.value);
    const tax = Number(row.values?.find((value) => value.columnIndex === 1)?.value);
    const detailDescription =
      row.detailMode === "investment"
        ? normDescription(`${row.label} - ${row.investment} - ${row.contents}`)
        : normDescription(row.label);
    const list = planned.get(code) || [];
    list.push({ gross, tax, detailDescription });
    planned.set(code, list);
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
      detail: isDetailRow(code, row.description || ""),
    });
    grouped.set(code, list);
  }

  const conflicts = [];
  for (const [code, rows] of grouped) {
    const plannedRows = planned.get(code);
    if (!Object.hasOwn(BANK_PROFIT_ROWS, code)) {
      conflicts.push({ ...rows[0], reason: "not included in the approved Bank Profit-only packet" });
      continue;
    }
    if (!plannedRows?.length) {
      conflicts.push({ ...rows[0], reason: "row exists in IRIS but is not part of the approved packet" });
      continue;
    }

    if (plannedRows.length === 1) {
      // Single-certificate route: keep strict single-summary / single-detail checks.
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
      const values = plannedRows[0];
      if (row.gross !== values.gross || row.tax !== values.tax)
        conflicts.push({ ...row, reason: "differs from the approved packet" });
      continue;
    }

    // Multi-certificate Investment route: match each detail row by its description.
    const summaries = rows.filter((entry) => !entry.detail);
    const details = rows.filter((entry) => entry.detail);
    if (summaries.length > 1) {
      conflicts.push({ ...summaries[0], reason: "multiple existing rows require review" });
      continue;
    }
    const totalGross = plannedRows.reduce((sum, entry) => sum + entry.gross, 0);
    const totalTax = plannedRows.reduce((sum, entry) => sum + entry.tax, 0);
    if (details.length > plannedRows.length) {
      conflicts.push({ ...details[0], reason: "several detail rows for one code require review" });
      continue;
    }
    const used = new Set();
    const unmatchedDetails = [];
    let detailConflict = false;
    let matchedDetailGross = 0;
    let matchedDetailTax = 0;
    for (const detailRow of details) {
      const desc = normDescription(detailRow.description);
      const idx = plannedRows.findIndex(
        (candidate, candidateIndex) => !used.has(candidateIndex) && candidate.detailDescription === desc,
      );
      if (idx !== -1) {
        used.add(idx);
        const expected = plannedRows[idx];
        if (detailRow.gross !== expected.gross || detailRow.tax !== expected.tax) {
          detailConflict = true;
          conflicts.push({ ...detailRow, reason: "differs from the approved packet" });
        } else {
          matchedDetailGross += detailRow.gross;
          matchedDetailTax += detailRow.tax;
        }
      } else {
        unmatchedDetails.push(detailRow);
      }
    }
    for (const detailRow of unmatchedDetails) {
      const desc = normDescription(detailRow.description);
      const duplicatesApprovedDescription = plannedRows.some((candidate) => candidate.detailDescription === desc);
      const matchingCandidates = !duplicatesApprovedDescription
        ? plannedRows
            .map((candidate, candidateIndex) => ({ candidate, candidateIndex }))
            .filter(
              ({ candidate, candidateIndex }) =>
                !used.has(candidateIndex) &&
                candidate.gross === detailRow.gross &&
                candidate.tax === detailRow.tax,
            )
        : [];
      const siblingSameAmounts = unmatchedDetails.filter(
        (other) => other !== detailRow && other.gross === detailRow.gross && other.tax === detailRow.tax,
      ).length;
      if (matchingCandidates.length === 1 && siblingSameAmounts === 0) {
        used.add(matchingCandidates[0].candidateIndex);
        matchedDetailGross += detailRow.gross;
        matchedDetailTax += detailRow.tax;
      } else {
        detailConflict = true;
        conflicts.push({ ...detailRow, reason: "row exists in IRIS but is not part of the approved packet" });
      }
    }
    if (summaries.length === 1) {
      const matchesTotal = summaries[0].gross === totalGross && summaries[0].tax === totalTax;
      const matchesPartialFbrDetails =
        details.length >= 1 &&
        !detailConflict &&
        summaries[0].gross === matchedDetailGross &&
        summaries[0].tax === matchedDetailTax;
      if (!matchesTotal && !matchesPartialFbrDetails) {
        conflicts.push({ ...summaries[0], reason: "differs from the approved packet" });
      }
    }
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
