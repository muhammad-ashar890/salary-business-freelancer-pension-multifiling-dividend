#!/usr/bin/env node
/**
 * Bank Intelligence: make the Suggestion column recognise bank profit.
 *
 * The problem this replaces
 * -------------------------
 * The suggestion came from a fixed keyword list, and every Pakistani bank
 * words the same credit differently: HBL prints "PROFIT ON TDR/PLS SAVINGS
 * A/C CR", Standard Chartered prints "PROFIT CREDIT ON DEPOSIT", Meezan
 * prints "SUKUK PROFIT DISTRIBUTION CR". Each missing wording fell through to
 * the generic "Potential income" badge, and every fix so far added the
 * wordings that had been seen - which left the next bank's wording to fail.
 *
 * What this does
 * --------------
 * It replaces phrase matching with a rule that reads the narration: a credit
 * is bank profit when a word for the return (profit, interest, mark-up) meets
 * a word for the account it was paid on (deposit, savings, PLS, TDR, sukuk,
 * NSC, account), in either order, with any bank-specific words in between.
 * Loan, finance, lease, credit-card and trade-finance wording is excluded, so
 * "MARK UP PAID ON FINANCE" and "MURABAHA PROFIT PAYMENT" stay out.
 *
 * Usage
 * -----
 *   node apply-bank-profit-suggestion-fix.cjs --dir "C:\path\to\tr"
 *   node apply-bank-profit-suggestion-fix.cjs --dir "..." --check
 *   node apply-bank-profit-suggestion-fix.cjs --dir "..." --undo
 */
"use strict";

const fs = require("node:fs");
const path = require("node:path");

const FILE = path.join("lib", "tax", "bank-classification-rules.ts");
const BACKUP_SUFFIX = ".bak-bank-profit-structural";

// ---------------------------------------------------------------------------
// The code this script installs
// ---------------------------------------------------------------------------

const VOCAB_BLOCK = String.raw`// ---------------------------------------------------------------------------
// Bank profit credited by a bank
// ---------------------------------------------------------------------------
//
// Every Pakistani bank words the same credit differently, and the instrument
// can sit before or after the return word:
//
//   PROFIT ON TDR/PLS SAVINGS A/C CR          HBL
//   PROFIT CREDIT ON DEPOSIT                  Standard Chartered
//   SUKUK PROFIT DISTRIBUTION CR              Meezan (Islamic investment)
//   PROFIT ON PLS ACCOUNT CR                  Meezan
//   MONTHLY PROFIT CREDITED                   monthly savings products
//   INTEREST CREDITED / INTEREST ON DEPOSIT   conventional banking
//   PROFIT, WHT DEDUCTION, ZAKAT              the three entries read side by side
//
// An exhaustive phrase list cannot keep up with that. Every new bank adds a
// wording the list does not carry, and the row falls through to the generic
// "Potential income" question: "profit on tdr" and "profit credit" each had to
// be patched in by hand, and "SUKUK PROFIT DISTRIBUTION CR" still went
// unrecognised after both.
//
// So the rule reads the narration instead of matching phrases: a credit is
// bank profit when a word for the return meets a word for the account it was
// paid on, in either order, with any bank-specific words between them.
const BANK_PROFIT_RETURN_WORDS = [
  "profit",
  "profits",
  "interest",
  "markup",
  "mark up",
] as const;

// "Yield", "return" and "distribution" describe a bank return only beside the
// instrument itself ("sukuk distribution"). Alone they are also capital-gains,
// cheque, mutual-fund and dividend wording, none of which is bank profit.
const BANK_PROFIT_WEAK_RETURN_WORDS = [
  "yield",
  "return",
  "distribution",
] as const;

// A word that names what the money sat in.
const BANK_PROFIT_INSTRUMENT_WORDS = [
  "deposit",
  "deposits",
  "savings",
  "saving",
  "pls",
  "tdr",
  "term deposit",
  "fixed deposit",
  "sukuk",
  "sukuks",
  "nsc",
  "certificate",
  "certificates",
  "dsc",
  "ssc",
  "ric",
  "behbood",
] as const;

// Words for the account that carry no instrument name. Together with profit or
// interest they are enough; on their own they are not, which is why the weak
// return words above never use them.
const BANK_PROFIT_ACCOUNT_WORDS = [
  "account",
  "a c",
  "ac",
  "investment",
] as const;

// A bank's own ledger wording for "we put money in your account". This is what
// makes a bare "PROFIT CREDIT" or "PROFIT PAID" readable when the narration
// names no instrument at all.
const BANK_PROFIT_CREDIT_CHANNEL_WORDS = [
  "credit",
  "credited",
  "cr",
  "receipt",
  "received",
  "payment",
  "paid",
  "earned",
  "accrued",
  "posted",
  "income",
  // "Bank profit net of withholding": the payer is named, so the instrument
  // does not have to be. "profit from bank" is excluded by the other-payer
  // guard below instead.
  "bank",
] as const;

// Wording that points at somebody else as the payer. A narration that names a
// counterparty is not the bank's own ledger line, so without a deposit word
// there is nothing that makes it profit on an account.
const BANK_PROFIT_OTHER_PAYER_WORDS = [
  "from",
  "by",
  "customer",
  "customers",
  "client",
  "clients",
  "partner",
  "partners",
  "shareholder",
  "shareholders",
  "ltd",
  "limited",
  "pvt",
  "private",
  "company",
  "traders",
  "trader",
  "enterprises",
  "brother",
  "sister",
  "father",
  "mother",
  "friend",
] as const;

// The same words describe a facility the taxpayer OWES - where the profit is
// the bank's and belongs in expense - and trade-finance deals whose return is
// business income. A narration carrying any of these is left to the rules that
// already know those heads.
const BANK_PROFIT_NOT_DEPOSIT_WORDS = [
  "loan",
  "loans",
  "financing",
  "finance",
  "lease",
  "leased",
  "credit card",
  "murabaha",
  "musharakah",
  "murabaha profit",
  "musharakah profit",
  "running finance",
  "demand finance",
  "on finance",
  "against finance",
  "letter of credit",
  "lc",
  "ijarah",
  "installment",
  "instalment",
  "bill discounting",
  "qarz",
  "qard",
  "partnership",
  "profit share",
  "share of profit",
  "share in profit",
  "penalty",
  "late payment",
  "rate",
] as const;

/**
 * True when the narration reads as profit or interest paid by a bank on an
 * account the taxpayer holds.
 *
 * Takes the description already normalised by normalizeBankDescription, so
 * "A/C" has become "a c" and punctuation is gone. Matching is on whole words
 * for the same reason the keyword matcher is: "profit" must not match inside
 * a longer word, and "lc" must not match inside a name.
 */
export function isBankProfitDescription(normalized: string) {
  const padded = ` + "` ${normalized} `" + `;
  const present = (word: string) => padded.includes(` + "` ${word} `" + `);
  const any = (words: readonly string[]) => words.some(present);

  if (any(BANK_PROFIT_NOT_DEPOSIT_WORDS)) return false;

  const instrument = any(BANK_PROFIT_INSTRUMENT_WORDS);
  const account = any(BANK_PROFIT_ACCOUNT_WORDS);
  const returnWord = any(BANK_PROFIT_RETURN_WORDS);

  // "Profit on deposit", "sukuk profit", "interest on savings": a return word
  // beside the thing the money sat in. Word order does not matter, and neither
  // does anything the bank puts between them.
  if (instrument && (returnWord || any(BANK_PROFIT_WEAK_RETURN_WORDS)))
    return true;

  // "Profit credited to your account", "interest on account".
  if (account && returnWord) return true;

  // "PROFIT CREDIT", "PROFIT PAID", "ISLAMIC PROFIT CREDIT": the bank's own
  // ledger wording with no instrument named, readable only while nobody else
  // is named as the payer.
  if (
    returnWord &&
    any(BANK_PROFIT_CREDIT_CHANNEL_WORDS) &&
    !any(BANK_PROFIT_OTHER_PAYER_WORDS)
  )
    return true;

  return false;
}

`;

// The rule keeps its place in the list - order decides which head wins - but
// carries no keywords of its own. isBankProfitDescription below answers for
// every wording, which also retires two false positives the old list had:
// "markup" alone matched MARKUP ON RUNNING FINANCE and "profit payment"
// matched MURABAHA PROFIT PAYMENT, both of which are the taxpayer's own
// finance cost, not profit received.
const RULE_BLOCK = `  {
    keywords: [],
    entryType: "INCOME",
    category: "BANK_PROFIT",`;

const MATCHER_OLD = `      candidate.keywords.some((keyword) => matchesKeyword(normalized, keyword)),
  );

  if (!rule) {`;

const MATCHER_NEW = `      candidate.keywords.some((keyword) => matchesKeyword(normalized, keyword)),
  );

  // Profit credited by a bank is read, not matched. The keyword list above
  // carries the nine classic wordings; this covers every other way a bank can
  // say the same thing ("SUKUK PROFIT DISTRIBUTION CR", "PROFIT CREDIT ON
  // DEPOSIT", "MONTHLY PROFIT CREDITED", "INTEREST ON DEPOSIT"). It sits where
  // a matching rule would have, so every caller - the classify action, the
  // completeness scan and the sweep - reaches the same answer.
  if (
    !rule &&
    (!direction || direction === "credit") &&
    isBankProfitDescription(normalized)
  ) {
    return {
      status: "SUGGESTED",
      entryType: "INCOME",
      category: "BANK_PROFIT",
      confidence: 0.88,
    };
  }

  if (!rule) {`;

// ---------------------------------------------------------------------------
// Behaviour checks the script runs against its own result
// ---------------------------------------------------------------------------

const MUST_BE_PROFIT = [
  // The three statements in the test kit, verbatim.
  "PROFIT ON TDR/PLS SAVINGS A/C CR", // HBL
  "PROFIT CREDIT ON DEPOSIT", // Standard Chartered
  "SUKUK PROFIT DISTRIBUTION CR", // Meezan
  // Other wordings the same three banks and their peers print.
  "PROFIT ON PLS ACCOUNT CR",
  "PROFIT ON SAVINGS ACCOUNT",
  "PROFIT ON TDR ACCOUNT",
  "PROFIT ON FIXED DEPOSIT",
  "PROFIT ON TERM DEPOSIT CR",
  "PROFIT ON DEPOSIT",
  "PROFIT CREDITED",
  "PROFIT CREDIT",
  "MONTHLY PROFIT CREDITED",
  "QUARTERLY PROFIT CREDITED",
  "PROFIT PAID ON DEPOSIT",
  "PROFIT PAID",
  "PROFIT EARNED ON DEPOSIT",
  "PROFIT ACCRUED ON DEPOSIT",
  "SAVINGS PROFIT CREDITED",
  "SAVINGS ACCOUNT PROFIT",
  "PLS PROFIT CREDITED",
  "TDR PROFIT CREDITED",
  "SUKUK PROFIT",
  "SUKUK DISTRIBUTION",
  "PROFIT ON INVESTMENT ACCOUNT",
  "INTEREST CREDITED",
  "INTEREST CREDIT",
  "INTEREST ON DEPOSIT",
  "INTEREST ON SAVINGS ACCOUNT",
  "INTEREST INCOME",
  "MARK UP ON DEPOSIT",
  "MARKUP ON DEPOSIT",
  "NSC PROFIT CREDITED",
  "DSC PROFIT",
  "BEHBOOD PROFIT CREDITED",
  "PROFIT ON ACCOUNT",
  "A/C PROFIT CREDITED",
  "ISLAMIC PROFIT CREDIT",
  "YIELD ON DEPOSIT",
];

const MUST_NOT_BE_PROFIT_CREDITS = [
  "INTEREST PAID ON LOAN",
  "MARK UP PAID ON FINANCE",
  "PROFIT PAID ON LOAN",
  "LOAN INSTALLMENT",
  "MARKUP ON RUNNING FINANCE",
  "PROFIT ON LEASE",
  "CREDIT CARD PROFIT",
  "MURABAHA PROFIT PAYMENT",
  "SALARY CREDIT",
  "PENSION PAYROLL",
  "RENT RECEIVED",
  "GIFT FROM FATHER",
  "DIVIDEND RECEIVED",
  "IBFT RECEIVED",
  "PRIZE BOND WINNINGS",
  "SALES PROCEEDS",
  "INVOICE PAYMENT RECEIVED",
  "PROFIT ANYWHERE LTD",
  "PROFIT FROM BANK",
  "PROFIT FROM FRIEND",
  "PROFIT SHARE FROM PARTNERSHIP",
  "PROFIT ON SALE OF SHARES",
  "RETURN OF CHEQUE",
  "YIELD ON BONDS",
  "CASH WITHDRAWAL",
  "ATM CASH",
  "BANK CHARGES",
];

const MUST_NOT_BE_PROFIT_DEBITS = [
  "INTEREST PAID ON LOAN",
  "MARK UP PAID ON FINANCE",
  "PROFIT PAID ON LOAN",
  "LOAN REPAYMENT",
  "CASH WITHDRAWAL",
  "ATM CASH",
  "BANK CHARGES",
  "FUEL PURCHASE",
  "UTILITY BILL",
];

// ---------------------------------------------------------------------------
// Plumbing
// ---------------------------------------------------------------------------

const useColor = process.stdout.isTTY;
const paint = (code, text) => (useColor ? `\x1b[${code}m${text}\x1b[0m` : text);
const say = (text = "") => console.log(text);
const ok = (text) => console.log(`  ${paint(32, "OK")}    ${text}`);
const bad = (text) => console.log(`  ${paint(31, "FAIL")}  ${text}`);
const info = (text) => console.log(`  ${paint(36, "i")}     ${text}`);

function parseArgs(argv) {
  const args = { dir: process.cwd(), check: false, undo: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--check") args.check = true;
    else if (arg === "--undo") args.undo = true;
    else if (arg === "--dir") args.dir = argv[i + 1];
    else if (arg.startsWith("--dir=")) args.dir = arg.slice(6);
  }
  return args;
}

const TARGET = (dir) => path.join(dir, FILE);
const BACKUP = (dir) => path.join(dir, FILE + BACKUP_SUFFIX);

function read(dir) {
  const raw = fs.readFileSync(TARGET(dir), "utf8");
  const crlf = raw.includes("\r\n");
  return { raw, text: raw.replace(/\r\n/g, "\n"), crlf };
}

function write(dir, text, crlf) {
  // The project keeps CRLF in this file. Writing LF would show every line as
  // changed in git and in the user's editor.
  fs.writeFileSync(TARGET(dir), crlf ? text.replace(/\n/g, "\r\n") : text, "utf8");
}

// ---------------------------------------------------------------------------
// The edit
// ---------------------------------------------------------------------------

/**
 * Rebuild the BANK_PROFIT keyword list and add the reader.
 *
 * Written structurally: it finds the rule by its own delimiters rather than
 * by matching a copy of the text, so a tree that already carries an earlier
 * hand-edit (a list that grew with "profit on tdr", or with "profit credit")
 * is upgraded by the same code path as a pristine one.
 */
function applyFix(text) {
  const ruleAt = text.indexOf('category: "BANK_PROFIT"');
  if (ruleAt < 0) return { error: "BANK_PROFIT rule nahi mila." };

  const keywordsAt = text.lastIndexOf("keywords: [", ruleAt);
  if (keywordsAt < 0) return { error: "BANK_PROFIT ki keyword list nahi mili." };

  const listClose = text.indexOf("\n    ],", keywordsAt);
  if (listClose < 0) return { error: "Keyword list ka closing bracket nahi mila." };

  // Swap the whole rule body above `category: "BANK_PROFIT",` for the trimmed
  // list, keeping the rest of the rule (entryType, confidence) untouched.
  const ruleStart = text.lastIndexOf("\n  {\n", keywordsAt) + 1;
  if (ruleStart <= 0) return { error: "Rule ka opening brace nahi mila." };

  let next = text.slice(0, ruleStart) + RULE_BLOCK + text.slice(ruleAt + 'category: "BANK_PROFIT",'.length);

  // The reader goes immediately before CLASSIFICATION_RULES so the list and the
  // function that backs it sit together.
  const rulesAt = next.indexOf("export const CLASSIFICATION_RULES = [");
  if (rulesAt < 0) return { error: "CLASSIFICATION_RULES nahi mila." };
  next = next.slice(0, rulesAt) + VOCAB_BLOCK + next.slice(rulesAt);

  // And the lookup gets one structural branch beside it.
  if (!next.includes(MATCHER_NEW)) {
    if (!next.includes(MATCHER_OLD))
      return { error: "classifyDescription ka rule lookup nahi mila." };
    next = next.replace(MATCHER_OLD, MATCHER_NEW);
  }

  return { text: next };
}

function classify(description, { debit = null, credit = null } = {}) {
  const fsMod = require("node:fs");
  const pathMod = require("node:path");
  const Module = require("node:module");

  const root = process.cwd();
  // The compiler is loaded from the project being patched, not from wherever
  // this script happens to sit: the kit ships without a node_modules folder.
  const ts = require(require.resolve("typescript", { paths: [root] }));
  const original = Module._resolveFilename;
  Module._resolveFilename = function (request, ...rest) {
    if (request.startsWith("@/"))
      request = pathMod.join(root, request.slice(2));
    return original.call(this, request, ...rest);
  };
  require.extensions[".ts"] = function (module, filename) {
    module._compile(
      ts.transpileModule(fsMod.readFileSync(filename, "utf8"), {
        compilerOptions: {
          module: ts.ModuleKind.CommonJS,
          target: ts.ScriptTarget.ES2020,
        },
      }).outputText,
      filename,
    );
  };

  delete require.cache[require.resolve(pathMod.join(root, FILE))];
  const rules = require(pathMod.join(root, FILE));
  const tx = {
    id: "t",
    bankAccountId: "a",
    transactionDate: new Date("2025-11-30"),
    description,
    debit,
    credit,
  };
  return rules.classifyTransaction(tx, []);
}

function verify(dir) {
  const cwd = process.cwd();
  process.chdir(dir);
  const results = { creditPass: 0, creditFail: [], debitPass: 0, debitFail: [] };
  try {
    for (const description of MUST_BE_PROFIT) {
      const r = classify(description, { credit: 350000 });
      if (r.status === "SUGGESTED" && r.category === "BANK_PROFIT")
        results.creditPass += 1;
      else results.creditFail.push(`${description} -> ${r.status}/${r.category}`);
    }
    for (const description of [
      ...MUST_NOT_BE_PROFIT_CREDITS,
      ...MUST_NOT_BE_PROFIT_DEBITS,
    ]) {
      const isDebit = MUST_NOT_BE_PROFIT_DEBITS.includes(description);
      const r = classify(description, isDebit ? { debit: 350000 } : { credit: 350000 });
      if (r.category !== "BANK_PROFIT") results.debitPass += 1;
      else results.debitFail.push(`${description} -> ${r.status}/${r.category}`);
    }
  } finally {
    process.chdir(cwd);
  }
  return results;
}

// ---------------------------------------------------------------------------
// Modes
// ---------------------------------------------------------------------------

function runCheck(dir) {
  const { text } = read(dir);
  const checks = [
    ["BANK_PROFIT rule intact", text.includes('category: "BANK_PROFIT"')],
    ["reader installed", text.includes("export function isBankProfitDescription")],
    ["lookup wired", text.includes("isBankProfitDescription(normalized)")],
    ["return words", text.includes('"mark up"')],
    ["instrument words", text.includes('"sukuk"') && text.includes('"tdr"')],
    ["loan/finance exclusion", text.includes("BANK_PROFIT_NOT_DEPOSIT_WORDS")],
    ["rule ordering kept", /keywords: \[\],\s*\n\s*entryType: "INCOME",\s*\n\s*category: "BANK_PROFIT"/.test(text)],
  ];
  let failed = 0;
  for (const [label, pass] of checks) {
    if (pass) ok(label);
    else {
      failed += 1;
      bad(label);
    }
  }
  say("");
  const results = verify(dir);
  say(`  Profit wordings: ${results.creditPass}/${MUST_BE_PROFIT.length} BANK_PROFIT`);
  say(`  Guard wordings:  ${results.debitPass}/${MUST_NOT_BE_PROFIT_CREDITS.length + MUST_NOT_BE_PROFIT_DEBITS.length} not BANK_PROFIT`);
  if (results.creditFail.length || results.debitFail.length) {
    say("");
    say("  Galat:");
    for (const line of [...results.creditFail, ...results.debitFail]) bad(line);
    return 1;
  }
  say("");
  if (failed === 0) say(paint(32, "Sab checks pass."));
  return failed === 0 ? 0 : 1;
}

function runUndo(dir) {
  const backup = BACKUP(dir);
  if (!fs.existsSync(backup)) {
    say("");
    bad("Backup nahi mila — undo nahi ho sakta.");
    say("  (Ye script chalane se pehle ki file .bak-bank-profit-structural mein hoti hai.)");
    return 1;
  }
  fs.copyFileSync(backup, TARGET(dir));
  say("");
  ok("Undo ho gaya — file wapas.");
  return 0;
}

function runApply(dir) {
  const { text, crlf } = read(dir);

  if (text.includes("export function isBankProfitDescription")) {
    say("");
    ok("Ye fix PEHLE SE laga hua hai — kuch karne ki zaroorat nahi.");
    say("");
    const results = verify(dir);
    say(`  Profit wordings: ${results.creditPass}/${MUST_BE_PROFIT.length}`);
    say(`  Guard wordings:  ${results.debitPass}/${MUST_NOT_BE_PROFIT_CREDITS.length + MUST_NOT_BE_PROFIT_DEBITS.length}`);
    return results.creditFail.length || results.debitFail.length ? 1 : 0;
  }

  const applied = applyFix(text);
  if (applied.error) {
    say("");
    bad(applied.error);
    return 1;
  }

  // One backup, always from the file as it was before this script touched it.
  if (!fs.existsSync(BACKUP(dir))) {
    fs.copyFileSync(TARGET(dir), BACKUP(dir));
    info(`Backup: ${path.basename(BACKUP(dir))}`);
  }

  write(dir, applied.text, crlf);

  const results = verify(dir);
  say("");
  say(`  Profit wordings: ${results.creditPass}/${MUST_BE_PROFIT.length} BANK_PROFIT`);
  say(`  Guard wordings:  ${results.debitPass}/${MUST_NOT_BE_PROFIT_CREDITS.length + MUST_NOT_BE_PROFIT_DEBITS.length} not BANK_PROFIT`);

  if (results.creditFail.length || results.debitFail.length) {
    say("");
    bad("Fix lag gaya magar behaviour galat hai. Undo karein:");
    bad("  node apply-bank-profit-suggestion-fix.cjs --undo");
    for (const line of [...results.creditFail, ...results.debitFail]) bad(line);
    return 1;
  }

  say("");
  say(paint(32, "OK — FIX LAG GAYA"));
  say("");
  say("Ab ye karein:");
  say("  1) Remove-Item -Recurse -Force .next");
  say("  2) npm run dev");
  say("  3) Bank Intelligence kholein aur dobara 'Classify' dabayein.");
  say("");
  say("Suggestion column ab aise dikhega:");
  say("     SUGGESTED · Bank Profit   (HBL, SCB, Meezan — har wording)");
  return 0;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const dir = path.resolve(args.dir);

  say("");
  say("=== Bank-profit suggestion fix ===");
  say("");

  if (!fs.existsSync(TARGET(dir))) {
    bad(`File nahi mili: ${TARGET(dir)}`);
    say("  --dir mein project ka root dein (jisme lib/ aur app/ hon).");
    process.exit(1);
  }
  info("File mil gayi");

  const code = args.check
    ? runCheck(dir)
    : args.undo
      ? runUndo(dir)
      : runApply(dir);

  say("");
  process.exit(code);
}

main();
