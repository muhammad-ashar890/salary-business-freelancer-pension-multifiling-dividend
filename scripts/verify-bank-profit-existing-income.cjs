#!/usr/bin/env node
"use strict";
/**
 * Bank Profit existing-income guard — the read-only preflight that runs BEFORE
 * any Bank Profit cell is typed.
 *
 * Contract:
 *   1. Only an active, verified Bank Profit route may proceed.
 *   2. An incomplete/torn census or an open dialog pauses the run.
 *   3. Rows are grouped by IRIS code; a parent summary and its Investment
 *      detail children are NEVER added together.
 *   4. Multiple summaries, detail rows without a summary, a row outside the
 *      approved packet, and a differing (gross, tax) pair are all conflicts.
 *   5. Any conflict means: nothing typed, nothing deleted, no balancing figure.
 */

const assert = require("node:assert/strict");
const test = require("node:test");
const path = require("node:path");

const guard = require(path.join(__dirname, "..", "electron-connect", "iris-bank-profit-existing-income.js"));

const VIEW = "Other Sources > Tax Deductions";

/** An approved route with two categories, as the packet plan would carry. */
function route() {
  return {
    active: true,
    rows: [
      {
        irisCode: "64040052",
        label: "Profit on Debt u/s 151(1)(b) from Bank Accounts / Deposits",
        detailMode: "investment",
        documentId: "doc-1",
        values: [
          { columnIndex: 0, column: "Taxable Amount", value: "1000000" },
          { columnIndex: 1, column: "Tax Deducted", value: "150000" },
        ],
      },
      {
        irisCode: "64330055",
        label: "Return on Investment in Sukuks u/s 151(1A) @ 12.5%",
        detailMode: "direct",
        documentId: "doc-2",
        values: [
          { columnIndex: 0, column: "Taxable Amount", value: "200000" },
          { columnIndex: 1, column: "Tax Deducted", value: "25000" },
        ],
      },
    ],
  };
}

function census(rows, { complete = true, ok = true, dialogsOpen = false } = {}) {
  return {
    complete,
    views: [
      {
        key: VIEW,
        ok,
        dialogsOpen,
        rows: rows.map((row) => ({
          code: row.code,
          description: row.description ?? "",
          cells: [
            { value: row.gross === undefined ? "" : String(row.gross) },
            { value: row.tax === undefined ? "" : String(row.tax) },
          ],
        })),
      },
    ],
  };
}

test("an empty grid is accepted", () => {
  const out = guard.checkExistingBankProfitIncome(census([]), route());
  assert.equal(out.ok, true, out.reason);
  assert.deepEqual(out.conflicts, []);
});

test("rows that match the approved packet are accepted", () => {
  const out = guard.checkExistingBankProfitIncome(
    census([
      {
        code: "64040052",
        description: "Profit on Debt u/s 151(1)(b) from Bank Accounts / Deposits -- 00123456789",
        gross: "1000000",
        tax: "150000",
      },
      {
        code: "64330055",
        description: "Return on Investment in Sukuks u/s 151(1A) @ 12.5%",
        gross: "200000",
        tax: "25000",
      },
    ]),
    route(),
  );
  assert.equal(out.ok, true, out.reason);
});

test("an inactive route is refused before anything is read", () => {
  const out = guard.checkExistingBankProfitIncome(census([]), { active: false, rows: [] });
  assert.equal(out.ok, false);
  assert.match(out.reason, /not verified/);
});

test("a torn census or an open dialog pauses the run", () => {
  for (const broken of [
    { ...census([]), complete: false },
    census([], { ok: false }),
    census([], { dialogsOpen: true }),
    { complete: true, views: [] },
    { complete: true, views: [census([]).views[0], census([]).views[0]] },
  ]) {
    const out = guard.checkExistingBankProfitIncome(broken, route());
    assert.equal(out.ok, false);
    assert.match(out.reason, /could not be checked completely/);
  }
});

test("a differing gross or withholding is a conflict", () => {
  for (const row of [
    { code: "64040052", gross: "1000001", tax: "150000" },
    { code: "64040052", gross: "1000000", tax: "150001" },
  ]) {
    const out = guard.checkExistingBankProfitIncome(census([row]), route());
    assert.equal(out.ok, false);
    assert.equal(out.conflicts.length, 1);
    assert.match(out.conflicts[0].reason, /differs from the approved packet/);
  }
});

test("a parent summary and its detail children are not added together", () => {
  const out = guard.checkExistingBankProfitIncome(
    census([
      {
        code: "64040052",
        description: "Profit on Debt u/s 151(1)(b) from Bank Accounts / Deposits",
        gross: "1000000",
        tax: "150000",
      },
      {
        code: "64040052",
        description: "Profit on Debt u/s 151(1)(b) from Bank Accounts / Deposits -- Term Deposit -- Example Bank",
        gross: "1000000",
        tax: "150000",
      },
    ]),
    route(),
  );
  assert.equal(out.ok, true, out.reason);
});

test("two summary rows for one code require a human", () => {
  const out = guard.checkExistingBankProfitIncome(
    census([
      { code: "64040052", description: "row A", gross: "1000000", tax: "150000" },
      { code: "64040052", description: "row B", gross: "1000000", tax: "150000" },
    ]),
    route(),
  );
  assert.equal(out.ok, false);
  assert.match(out.conflicts[0].reason, /multiple existing rows require review/);
});

test("a lone detail row (blank read-only parent) matches the approved packet", () => {
  const out = guard.checkExistingBankProfitIncome(
    census([
      {
        code: "64040052",
        description: "Profit on Debt u/s 151(1)(b) from Bank Accounts / Deposits -- Term Deposit -- Example Bank",
        gross: "1000000",
        tax: "150000",
      },
    ]),
    route(),
  );
  assert.equal(out.ok, true, out.reason);
});

test("several detail rows for one code require a human", () => {
  const out = guard.checkExistingBankProfitIncome(
    census([
      { code: "64040052", description: "Profit on Debt -- Term Deposit -- Bank A", gross: "500000", tax: "75000" },
      { code: "64040052", description: "Profit on Debt -- Term Deposit -- Bank B", gross: "500000", tax: "75000" },
    ]),
    route(),
  );
  assert.equal(out.ok, false);
  assert.match(out.conflicts[0].reason, /several detail rows for one code require review/);
});

test("any Other Sources row outside the approved packet is a conflict", () => {
  const out = guard.checkExistingBankProfitIncome(
    census([{ code: "64030055", description: "Dividend u/s 150 @15%", gross: "50000", tax: "7500" }]),
    route(),
  );
  assert.equal(out.ok, false);
  assert.match(out.conflicts[0].reason, /not included in the approved Bank Profit-only packet/);
});

test("a Bank Profit code present in IRIS but absent from the packet is a conflict", () => {
  const out = guard.checkExistingBankProfitIncome(
    census([{ code: "64040054", description: "151(1) (d) - Profit on Debt u/s 151 from Others", gross: "9000", tax: "1350" }]),
    route(),
  );
  assert.equal(out.ok, false);
  assert.match(out.conflicts[0].reason, /row exists in IRIS but is not part of the approved packet/);
});

test("grid header rows are ignored and never treated as income", () => {
  const out = guard.checkExistingBankProfitIncome(
    census([
      { code: "999918", description: "header", gross: "999999", tax: "999999" },
      { code: "999919", description: "header", gross: "999999", tax: "999999" },
    ]),
    route(),
  );
  assert.equal(out.ok, true, out.reason);
});

test("an unidentifiable or unreadable row pauses instead of being interpreted", () => {
  assert.equal(
    guard.checkExistingBankProfitIncome(census([{ code: "abc", gross: "1", tax: "1" }]), route()).ok,
    false,
  );
  const out = guard.checkExistingBankProfitIncome(census([{ code: "64040052", gross: "1e6", tax: "150000" }]), route());
  assert.equal(out.ok, false);
  assert.match(out.reason, /could not be read safely/);
});

test("the allowlist contains exactly the four captured section 151 Final Tax codes", () => {
  assert.deepEqual(Object.keys(guard.BANK_PROFIT_ROWS).sort(), [
    "64040052",
    "64040054",
    "64330054",
    "64330055",
  ]);
});

test("the guard is read-only: it exposes no writer and returns no write plan", () => {
  assert.deepEqual(Object.keys(guard).sort(), ["BANK_PROFIT_ROWS", "VIEW", "checkExistingBankProfitIncome"]);
  const out = guard.checkExistingBankProfitIncome(census([]), route());
  assert.deepEqual(Object.keys(out).sort(), ["conflicts", "ok", "reason"]);
});

test("multi-certificate route matches multiple distinct detail rows by description and refuses foreign or mismatched rows", () => {
  const multiRoute = {
    active: true,
    rows: [
      {
        irisCode: "64040052",
        label: "Profit on Debt u/s 151(1)(b) from Bank Accounts / Deposits",
        detailMode: "investment",
        investment: "Savings Account",
        contents: "1. PK111\n2. Savings Account\n3. Alpha Bank",
        values: [
          { columnIndex: 0, value: "1000000" },
          { columnIndex: 1, value: "150000" },
        ],
      },
      {
        irisCode: "64040052",
        label: "Profit on Debt u/s 151(1)(b) from Bank Accounts / Deposits",
        detailMode: "investment",
        investment: "Term Deposit",
        contents: "1. PK222\n2. Term Deposit\n3. Beta Bank",
        values: [
          { columnIndex: 0, value: "500000" },
          { columnIndex: 1, value: "75000" },
        ],
      },
    ],
  };

  // Matches both detail rows + parent summary with combined total
  const okOut = guard.checkExistingBankProfitIncome(
    census([
      { code: "64040052", description: "Profit on Debt u/s 151(1)(b) from Bank Accounts / Deposits", gross: "1500000", tax: "225000" },
      { code: "64040052", description: "Profit on Debt u/s 151(1)(b) from Bank Accounts / Deposits - Savings Account - 1. PK111\n2. Savings Account\n3. Alpha Bank", gross: "1000000", tax: "150000" },
      { code: "64040052", description: "Profit on Debt u/s 151(1)(b) from Bank Accounts / Deposits  -  Term Deposit  -  1. PK222\n2. Term Deposit\n3. Beta Bank", gross: "500000", tax: "75000" },
    ]),
    multiRoute,
  );
  assert.equal(okOut.ok, true, okOut.reason);

  // Refuses mismatched detail amount
  const badAmt = guard.checkExistingBankProfitIncome(
    census([
      { code: "64040052", description: "Profit on Debt u/s 151(1)(b) from Bank Accounts / Deposits - Savings Account - 1. PK111\n2. Savings Account\n3. Alpha Bank", gross: "999999", tax: "150000" },
    ]),
    multiRoute,
  );
  assert.equal(badAmt.ok, false);
  assert.match(badAmt.conflicts[0].reason, /differs from the approved packet/);

  // Refuses foreign unrecognized detail row under same code
  const foreignRow = guard.checkExistingBankProfitIncome(
    census([
      { code: "64040052", description: "Profit on Debt u/s 151(1)(b) from Bank Accounts / Deposits - Foreign Bond - 1. X\n2. Foreign Bond\n3. Z", gross: "100000", tax: "15000" },
    ]),
    multiRoute,
  );
  assert.equal(foreignRow.ok, false);
  assert.match(foreignRow.conflicts[0].reason, /not part of the approved packet/);

  // Accepts an FBR-prepopulated MIS detail row alongside a second unadded certificate when amounts uniquely match
  const fbrPrepopulatedMulti = guard.checkExistingBankProfitIncome(
    census([
      { code: "64040052", description: "Profit on Debt u/s 151(1)(b) from Bank Accounts / Deposits", gross: "500000", tax: "75000" },
      { code: "64040052", description: "Profit on Debt u/s 151(1)(b) from Bank Accounts / Deposits--123456-BETA BANK", gross: "500000", tax: "75000" },
      { code: "64040052", description: "Profit on Debt u/s 151(1)(b) from Bank Accounts / Deposits-MIS", gross: "0", tax: "0" },
    ].slice(0, 2)),
    multiRoute,
  );
  assert.equal(fbrPrepopulatedMulti.ok, true, fbrPrepopulatedMulti.reason);

  // Supports label-suffix without space as a detail row
  const hyphenNoSpace = guard.checkExistingBankProfitIncome(
    census([
      { code: "64040052", description: "Profit on Debt u/s 151(1)(b) from Bank Accounts / Deposits", gross: "500000", tax: "75000" },
      { code: "64040052", description: "Profit on Debt u/s 151(1)(b) from Bank Accounts / Deposits-MIS BANK", gross: "500000", tax: "75000" },
    ]),
    multiRoute,
  );
  assert.equal(hyphenNoSpace.ok, true, hyphenNoSpace.reason);

  // Refuses ambiguous FBR-prepopulated MIS row when two packet certificates share identical amounts
  const identicalAmountsRoute = {
    active: true,
    rows: [
      { ...multiRoute.rows[0], values: [{ columnIndex: 0, value: "500000" }, { columnIndex: 1, value: "75000" }] },
      { ...multiRoute.rows[1], values: [{ columnIndex: 0, value: "500000" }, { columnIndex: 1, value: "75000" }] },
    ],
  };
  const ambiguousFbr = guard.checkExistingBankProfitIncome(
    census([
      { code: "64040052", description: "Profit on Debt u/s 151(1)(b) from Bank Accounts / Deposits", gross: "500000", tax: "75000" },
      { code: "64040052", description: "Profit on Debt u/s 151(1)(b) from Bank Accounts / Deposits--MIS", gross: "500000", tax: "75000" },
    ]),
    identicalAmountsRoute,
  );
  assert.equal(ambiguousFbr.ok, false);
});
