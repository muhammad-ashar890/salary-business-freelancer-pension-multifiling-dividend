# Bank Profit unblock — Phase 2 & 3 implemented (19-Nov-2026)

**Status:** gate flag ke peeche khul gaya + missing desktop guard likh diya. **Default behaviour byte-identical hai** — kuch bhi configure na karein to aaj jaisa hi chalega.

---

## Kya badla (5 files + 3 tests)

| # | File | Change |
|---|---|---|
| 1 | **`lib/tax/bank-profit-enablement.ts`** (naya) | Single source of truth for the switch. `TAXROCKET_BANK_PROFIT_PACKET=on` → enabled; **baqi har value = blocked**. `process` na ho (test sandboxes) to `{}` — crash nahi. |
| 2 | **`app/actions/packet.ts`** | Hard block → flag. **Source-set gate pehle** (TY2026 + Myself + sirf bank_profit), **flag baad mein**. Is tarteeb se flag galat combination kabhi admit nahi kar sakta. |
| 3 | **`electron-connect/iris-bank-profit-existing-income.js`** (naya) | Divided ke barabar read-only preflight: IRIS mein pehle se jo hai wo packet se compare hota hai; mismatch par **kuch type nahi hota**. |
| 4 | **`electron-connect/main.js`** | Guard wire — dividend preflight ke bilkul baad, kisi bhi setup/typing/Save se pehle. |
| 5 | **`electron-connect/package.json`** | Naya guard `build.files` mein (warna packaged app mein missing hota). |
| 6 | **`electron-connect/start-live.ps1`** | Opt-in env + restore-on-exit (baqi flags ki tarah). |

### Backup
`patch-backups/bank-profit-unblock-20261119/` — `packet.ts`, `main.js`, `iris-bank-profit-entry.js`, `start-live.ps1` ke original.

---

## Gate ka exact behaviour

```ts
// app/actions/packet.ts — order matters
if (bank_profit && (taxYear !== 2026 || filerType !== "myself" || sources.length !== 1))
    → refuse "Bank Profit packets support only TY2026 Myself Bank Profit-only filings."

const gate = bankProfitEnablement();
if (bank_profit && !gate.enabled)
    → refuse "Bank Profit packets remain blocked by default; set
              TAXROCKET_BANK_PROFIT_PACKET=on for a supervised test run."
```

Verified matrix:

| `TAXROCKET_BANK_PROFIT_PACKET` | Nateeja |
|---|---|
| unset | ❌ blocked (default_off) |
| `"off"` | ❌ blocked |
| `"true"` | ❌ blocked (sirf exact `on`) |
| `" on "` | ✅ enabled (trim + lowercase) |
| `"ON"` | ✅ enabled |
| `process` nahi | ❌ blocked — throw nahi |

---

## Downstream guards (sab intact)

Gate khulne ke baad bhi ye sab pehle jaisa chalta hai:

- `buildBankProfitEvidence` — CNIC 13-digit, printed §151 section regex, PKR-only, duplicate cert, Sukuk band, `gross − WHT = classified net credits`
- `taxCredits > 0` → hard fail (duplicate credit)
- `buildBankProfitPacketPlan` — revision match, per-category binding, Final Tax grid contract
- `bankProfitPacketValidationError` — har read surface par fresh re-read (packet reuse/PDF/dispatch/context 409)
- **naya:** desktop existing-income guard — IRIS grid read-only compare
- `main.js:4050` dedicated-only guard — koi doosra schedule ho to pause
- post-tab read + post-Save read + `7033`/`703000` Wealth proof

---

## Tests

### Naye
- **`verify-bank-profit-existing-income.cjs`** — 15/15
  - empty grid accepted · matching rows accepted · lone detail row (blank read-only parent) accepted
  - inactive route · torn census · open dialog · multiple summaries · several detail rows · foreign row · unmatched code · unreadable amount — sab refuse
  - header rows `999918/999919` ignore · allowlist exactly 4 §151 codes · read-only (koi writer export nahi)

### Updated (gate pin karne wale)
- `verify-bank-profit-packet-action.cjs` — 29/29 (pehle 25)
  - purana "gate closed" test ab **flag off** ke liye
  - naya: **flag on → real packet banta hai + desktop route `active:true`**
  - naya: flag on + TY2025 / company filer → refuse
  - naya: flag on + combination → refuse (aur error "Bank Profit-only" kehta hai)
  - harness: `process` VM mein expose, `taxYear`/`filerType` override
- `verify-bank-profit-main.cjs` — 13/13 (preflight dependency register)
- `verify-dividend-packet-action.cjs` — 10/10 (naya message match)

### Regression — ZERO new failures
```
              BEFORE   AFTER
PASS            142      144   (+2: existing-income, economic-packet-sync)
FAIL             26       26   (same suites)
NO_SUMMARY        2        1
```
`diff` of failing-suite names: **koi naya fail nahi**. `verify-economic-packet-sync` bhi ab pass hai (uska assertion gate string par tha).

`npx tsc --noEmit` → **exit 0** · `node --check main.js` → OK

---

## IRIS tak chalane ka tareeqa

```powershell
# 1) WEB APP process (ye zaroori hai — flag server-side read hota hai)
$env:TAXROCKET_BANK_PROFIT_PACKET = "on"

# 2) Desktop agent
cd electron-connect
./start-live.ps1     # ab ye bhi flag set karta hai

# 3) Filing
#    TY2026 / Myself / sirf "Bank Profit" source
#    ek category + ek MAPPED certificate (e.g. 151(1)(b), gross 1,000,000, WHT 150,000, net 850,000
#    ledger mein BANK_PROFIT income 850,000)
#    → Calculate → Generate packet → Approve → FBR Connect → job
```

**Agent kya karega:** Other Sources > Tax Deductions preflight → Investment detail setup → sirf 2 cells (Taxable Amount, Tax Deducted) → Tax Chargeable **read-only verify** → 1 draft Save → cell-by-cell readback + `7033`/`703000` check.

**Agent kya nahi karega:** Calculate, Submit, PSID, koi doosra section, koi delete/overwrite.

### Rollback
Flag hata dein (`Remove-Item Env:TAXROCKET_BANK_PROFIT_PACKET`) → exact purana behaviour. Code revert ki zaroorat nahi.

---

## Jo abhi bhi baqi hai (Phase 4–6)

| Phase | Kaam | Kyun zaroori |
|---|---|---|
| **1 (adhoora)** | Real IRIS HTML capture + selector audit | `bankProfitCellOp` `panels.length!==1` par fail karta hai — real page par kitne "Final Tax" panels hain, ye capture se hi pata chalega |
| **4** | Multi-certificate per category | aaj `documentIds.length !== 1` → refuse. Do deposits = manual |
| **5** | Real-capture DOM suite | aaj sirf JSDOM fake (`scripts/lib/fake-iris-bank-profit.cjs`) |
| **6** | Supervised live dry run | offline green ≠ live proof |

---

## Ek line

> Gate khul gaya aur **default band hai** — flag `on` karne par packet banta hai aur agent IRIS mein sirf §151 Final Tax grid ki 2 cells type karta hai, baqi sab guard pehle jaise. **144 PASS / 26 FAIL baseline se kam nahi, koi naya fail nahi, tsc clean.**
