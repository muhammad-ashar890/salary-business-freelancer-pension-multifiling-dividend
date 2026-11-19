"use strict";
/**
 * DP-3 (fix50): the business Tax Deduction driver against a page built with
 * the structure of captures 10 / 34 / 56 / 66 / 67 (~/iris-business-captures):
 * top tab titles; `.body.interface_21.active`; navigation panels
 * (`mat-expansion-panel` with `button.data-tab-left-btn`: Business ... "Tax
 * Deduction", "Balance Sheet"; Tax Chargeable / Payments); three grid panels
 * "Adjustable Tax" / "Final Tax" / "Minimum Tax" that can be collapsed, each
 * with one `.heading-bar` (Description | Code | value columns), a header row
 * 999913 / 999915 / 999914 (disabled cells, `button.btn-section-add`
 * "+ Section") and section rows `.tableRows.dataRow[id]` with one
 * `.data-middle-child-wapper` per value column; pickers
 * `mat-dialog-container > app-add-amount-code-row` titled "Add Adjustable Tax"
 * / "Add Minimum Tax" (`h6 .left` + close icon), `.source-card` (`p` name +
 * checkbox; checked + disabled = present), search box, ADD (disabled until a
 * tick) and Cancel. IRIS reactions (computing Tax Deducted, reverting a
 * figure) are [CHECK-LIVE]; each guard is exercised. Synthetic data only.
 */
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { chromium } = require("playwright");
const driver = require("../electron-connect/iris-tax-deduction-driver.js");
const businessRows = require("../electron-connect/iris-business-row-driver.js");
const rowFiller = require("../electron-connect/iris-row-filler.js");
const navigation = require("../electron-connect/iris-navigation.js");
const SERVICES_CONTRACT = require("../electron-connect/iris-services-contract.json");
const census = require("../electron-connect/iris-tour-census.js");

const ADJ = { code: "64060116", label: "Payment for Services u/s 153(1)(b) @8% u/c (42) of Part IV of Second Schedule" };
const ADJ_OTHER = { code: "64151305", label: "Purchase of Goods by Distributors, Dealers & Wholesalers u/s 236G @0.1%" };
const MIN_GOODS = { code: "64060052", label: "Payment for Goods u/s 153(1)(a) @1%" };
const MIN_IMPORT = { code: "64010052", label: "Import u/s 148 @1%" };
const MIN_OTHER = { code: "64060051", label: "Payment for Goods u/s 153(1)(a) @5%" };
const CATALOG = {
  adjustable: [ADJ_OTHER, ADJ].map((s) => ({ ...s, cells: "EE" })),
  final: [{ code: "64060285", label: "Export of services u/s 154A @1%", cells: "EED" }],
  minimum: [
    { ...MIN_IMPORT, cells: "EEDEDD" },
    { ...MIN_OTHER, cells: "EEDDDD" },
    { ...MIN_GOODS, cells: "EEDDDD" },
  ],
};
const HEADERS = {
  adjustable: ["Taxable Amount", "Tax Deducted"],
  final: ["Taxable Amount", "Tax Deducted", "Tax Chargeable"],
  minimum: ["Taxable Amount", "Tax Collected / Deducted", "Tax Chargeable", "Attributable Taxable Income", "Tax on Attributable Taxable Income", "Difference of Minimum Tax Chargeable"],
};
const TITLES = { adjustable: "Adjustable Tax", final: "Final Tax", minimum: "Minimum Tax" };
const HEADER_ROWS = { adjustable: "999913", final: "999915", minimum: "999914" };

// Same shape as lib/tax/business-tax-deductions.ts buildTaxDeductionsPlan().agentFields.
const field = (regime, section, values) => ({
  key: `${section.code}:taxDeduction`,
  regime,
  irisCode: section.code,
  label: section.label,
  panelTitle: TITLES[regime],
  pickerTitle: `Add ${TITLES[regime]}`,
  headerRowId: HEADER_ROWS[regime],
  headers: HEADERS[regime],
  cells: CATALOG[regime].find((s) => s.code === section.code).cells,
  values: values.map(([columnIndex, value]) => ({ columnIndex, column: HEADERS[regime][columnIndex], value: String(value) })),
});
const ADJ_FIELD = field("adjustable", ADJ, [[0, 1500000], [1, 120000]]);
const IMPORT_FIELD = field("minimum", MIN_IMPORT, [[0, 1000000], [1, 10000], [3, 150000]]);
const GOODS_FIELD = field("minimum", MIN_GOODS, [[0, 2000000], [1, 20000]]);

function page({
  onTab = false,
  businessOpen = false,
  panelsOpen = false,
  rows = {},
  dialog = "",
  headersOverride = null,
  presentInPickerOnly = [],
  irisComputesTax = false,
  revertLater = null,
  delayedEnableCodes = [],
} = {}) {
  return `<!doctype html><html><head><meta charset="utf-8"><style>
.closed > .mat-expansion-panel-content{display:none}.view{display:none}.view.shown{display:block}
</style></head><body>
<app-nitr-workflow><app-nitr-wf-body>
<div class="custom-tabs"><div class="sticky-tabs-head"><div class="head">
<div class="font-15 title active">Data</div><div class="font-15 title">Amortization</div><div class="font-15 title">Depreciation</div><div class="font-15 title">Business Details</div><div class="font-15 title">Payment</div><div class="font-15 title">Attachment</div>
</div></div></div>
<div class="body interface_21 active" id="data"><div class="row">
<div class="col-md-3"><mat-accordion>
<mat-expansion-panel id="nav-business" class="${businessOpen ? "" : "closed"}"><mat-expansion-panel-header aria-expanded="${businessOpen}" class="${businessOpen ? "mat-expanded" : ""}" onclick="toggle(this)"><span class="mat-content"><mat-panel-title>Business</mat-panel-title></span></mat-expansion-panel-header>
<div class="mat-expansion-panel-content"><div class="mat-expansion-panel-body">
<button class="data-tab-left-btn" onclick="left(this)">Manufacturing/ Trading Items</button>
<button class="data-tab-left-btn" onclick="left(this)">Adjustments</button>
<button class="data-tab-left-btn ${onTab ? "active" : ""}" onclick="left(this)">Tax Deduction</button>
<button class="data-tab-left-btn ${onTab ? "" : "active"}" onclick="left(this)">Balance Sheet</button>
</div></div></mat-expansion-panel>
<mat-expansion-panel id="nav-tcp" class="closed"><mat-expansion-panel-header aria-expanded="false" onclick="toggle(this)"><span class="mat-content"><mat-panel-title>Tax Chargeable / Payments</mat-panel-title></span></mat-expansion-panel-header>
<div class="mat-expansion-panel-content"><div class="mat-expansion-panel-body"><button class="data-tab-left-btn" onclick="left(this)">Withholding Tax</button></div></div></mat-expansion-panel>
</mat-accordion></div>
<div class="col-md-9">
<div class="view ${onTab ? "" : "shown"}" id="view-other"><div class="row tableRows dataRow" id="3319"><span class="row-description-text">Cash in hand</span><div class="data-middle-child-wapper"><input type="text"/></div></div></div>
<div class="view ${onTab ? "shown" : ""}" id="view-td"><mat-accordion class="wf-section-modal-accordion" id="grids"></mat-accordion></div>
</div></div></div>
</app-nitr-wf-body></app-nitr-workflow>
<div class="cdk-overlay-container" id="overlay">${dialog}</div>
<script>
window.clicks = [];
const CATALOG = ${JSON.stringify(CATALOG)};
const HEADERS = ${JSON.stringify(headersOverride || HEADERS)};
const TITLES = ${JSON.stringify(TITLES)};
const HEADER_ROWS = ${JSON.stringify(HEADER_ROWS)};
const START_ROWS = ${JSON.stringify(rows)};
const PICKER_ONLY = ${JSON.stringify(presentInPickerOnly)};
const IRIS_COMPUTES_TAX = ${JSON.stringify(irisComputesTax)};
const REVERT_LATER = ${JSON.stringify(revertLater)};
const DELAYED_ENABLE_CODES = ${JSON.stringify(delayedEnableCodes)};
document.addEventListener("click", (e) => {
  const t = e.target.closest("button, .title, mat-expansion-panel-header, input[type=checkbox]");
  if (!t) return;
  const label = t.matches("input[type=checkbox]") ? "tick:" + t.closest(".source-card").querySelector("p").textContent.trim() : t.textContent.replace(/\\s+/g, " ").trim();
  window.clicks.push(label);
}, true);
function toggle(header) {
  const panel = header.parentElement;
  const open = header.getAttribute("aria-expanded") !== "true";
  header.setAttribute("aria-expanded", String(open));
  header.classList.toggle("mat-expanded", open);
  panel.classList.toggle("closed", !open);
}
function left(button) {
  for (const b of document.querySelectorAll("button.data-tab-left-btn")) b.classList.toggle("active", b === button);
  const td = button.textContent.trim() === "Tax Deduction";
  document.getElementById("view-td").classList.toggle("shown", td);
  document.getElementById("view-other").classList.toggle("shown", !td);
}
function cellsHtml(cells, values, header) {
  return Array.from(cells).map((c, i) => '<div class="left h-padding-0 data-middle-child-wapper">' + (c === "-" ? "" : '<div><input class="data-middle-child form-control text-right amount-cell-input" type="text"' + (c === "D" ? " disabled" : "") + ' value="' + ((values && values[i]) || "") + '"/></div>') + "</div>").join("");
}
function rowHtml(id, label, cells, values, header) {
  return '<div class="dataRow ' + (header ? "form-head " : "") + 'row tableRows v-padding-5" id="' + id + '"><div class="col-lg-5"><div class="font-14 h-padding-20"><span class="row-description-text">' + label + ' </span></div></div><div class="col-lg-1">' + (header ? "" : '<span class="data-first-child font-14">' + id + "</span>") + '</div><div class="col-lg-5 columns-parent h-padding-0">' + cellsHtml(cells, values, header) + '</div><div class="col-lg-1"><div class="full-width actions">' + (header ? '<button class="btn-section-add h-margin-5" type="button" onclick="openPicker(\\'' + header + '\\')"> + Section </button>' : '<button aria-label="Delete" class="btn-section-delete" title="Delete" type="button"><i class="fa fa-trash"></i></button>') + "</div></div></div>";
}
function wire(row) {
  const inputs = row.querySelectorAll("input");
  if (IRIS_COMPUTES_TAX && inputs.length >= 2) {
    inputs[0].addEventListener("input", () => {
      const rate = /@(\\d+(?:\\.\\d+)?)%/.exec(row.querySelector(".row-description-text").textContent);
      if (rate && !inputs[1].value) inputs[1].value = String(Math.round(Number(inputs[0].value) * Number(rate[1]) / 100));
    });
  }
  if (REVERT_LATER && row.id === REVERT_LATER.code) {
    inputs[REVERT_LATER.index].addEventListener("blur", () => setTimeout(() => { inputs[REVERT_LATER.index].value = ""; }, 30));
  }
}
function addRow(regime, code, values) {
  const section = CATALOG[regime].find((s) => s.code === code);
  const body = document.querySelector('[data-regime="' + regime + '"] .mat-expansion-panel-body');
  const holder = document.createElement("div");
  const delayed = DELAYED_ENABLE_CODES.includes(code);
  holder.innerHTML = rowHtml(code, section.label, delayed ? "D".repeat(section.cells.length) : section.cells, values, null);
  const row = holder.firstElementChild;
  // Catalog order, after the header row.
  const order = CATALOG[regime].map((s) => s.code);
  const later = Array.from(body.querySelectorAll(".tableRows[id]")).find((r) => order.indexOf(r.id) > order.indexOf(code));
  if (later) later.before(row); else body.appendChild(row);
  wire(row);
  if (delayed) setTimeout(() => {
    Array.from(row.querySelectorAll("input")).forEach((input, i) => { if (section.cells[i] === "E") input.removeAttribute("disabled"); });
  }, 150);
}
function build() {
  const grids = document.getElementById("grids");
  grids.innerHTML = ["adjustable", "final", "minimum"].map((regime) =>
    '<mat-expansion-panel data-regime="' + regime + '" class="' + (${JSON.stringify(panelsOpen)} ? "" : "closed") + '"><mat-expansion-panel-header aria-expanded="' + ${JSON.stringify(panelsOpen)} + '" class="' + (${JSON.stringify(panelsOpen)} ? "mat-expanded" : "") + '" onclick="toggle(this)"><span class="mat-content"><mat-panel-title>' + TITLES[regime] + '</mat-panel-title></span><span class="mat-expansion-indicator"></span></mat-expansion-panel-header>' +
    '<div class="mat-expansion-panel-content"><div class="mat-expansion-panel-body"><div class="row heading-bar padding-10"><div class="col-lg-5"><strong>Description</strong></div><div class="col-lg-1 text-center"><strong>Code</strong></div><div class="col-lg-5 h-padding-0">' +
    HEADERS[regime].map((h) => '<div class="left text-center"><strong>' + h + ' </strong></div>').join("") + '</div><div aria-label="Actions" class="col-lg-1 text-center"></div></div>' +
    '<div class="h-padding-10">' + rowHtml(HEADER_ROWS[regime], TITLES[regime], "D".repeat(HEADERS[regime].length), null, regime) + "</div></div></div></mat-expansion-panel>"
  ).join("");
  for (const [code, spec] of Object.entries(START_ROWS)) addRow(spec.regime, code, spec.values || []);
}
build();
function openPicker(regime) {
  const present = new Set(Array.from(document.querySelectorAll('[data-regime="' + regime + '"] .tableRows[id]')).map((r) => r.id).concat(PICKER_ONLY));
  const dlg = document.createElement("mat-dialog-container");
  dlg.setAttribute("role", "dialog");
  dlg.innerHTML = '<app-add-amount-code-row><h6 class="mat-mdc-dialog-title dialog-title"><span class="left v-padding-top-5">Add ' + TITLES[regime] + '</span><span class="right pointer"><mat-icon class="mat-icon">close</mat-icon></span></h6><mat-dialog-content><input placeholder="Search Amount Code/Description" type="text"/>' +
    CATALOG[regime].map((s) => '<div class="source-card mb-2"><div class="checkbox-container"><mat-checkbox class="mat-mdc-checkbox"><input class="mdc-checkbox__native-control" type="checkbox"' + (present.has(s.code) ? " checked disabled" : "") + ' data-code="' + s.code + '"/></mat-checkbox></div><div class="ms-3"><p class="mb-0">' + s.label + "</p></div></div>").join("") +
    '</mat-dialog-content><mat-dialog-actions><button class="btn" type="button" disabled>ADD</button><button class="btn" type="button">Cancel</button></mat-dialog-actions></app-add-amount-code-row>';
  document.getElementById("overlay").appendChild(dlg);
  const [add, cancel] = dlg.querySelectorAll("mat-dialog-actions button");
  dlg.addEventListener("change", () => { add.disabled = !Array.from(dlg.querySelectorAll("input[type=checkbox]")).some((b) => b.checked && !b.disabled); });
  add.addEventListener("click", () => {
    for (const box of dlg.querySelectorAll("input[type=checkbox]")) if (box.checked && !box.disabled && !PICKER_ONLY.includes(box.dataset.code)) addRow(regime, box.dataset.code, []);
    dlg.remove();
  });
  cancel.addEventListener("click", () => dlg.remove());
}
</script></body></html>`;
}

let browser;
before(async () => { browser = await chromium.launch({ headless: true, args: ["--no-sandbox"] }); });
after(async () => { await browser?.close(); });

async function withPage(html, run) {
  const context = await browser.newContext();
  const pg = await context.newPage();
  await context.route("**/*", (route) => route.fulfill({ status: 200, contentType: "text/html", body: html }));
  await pg.goto("https://iris.fbr.gov.pk/nitr/workflow");
  const mainFrame = { get url() { return pg.url(); }, executeJavaScript: (source) => pg.evaluate(source) };
  mainFrame.framesInSubtree = [mainFrame];
  const win = { isDestroyed: () => false, webContents: { mainFrame, getURL: () => pg.url(), executeJavaScript: mainFrame.executeJavaScript } };
  try { await run(pg, win); } finally { await context.close(); }
}
const options = (extra = {}) => ({
  mode: "live",
  sleep: (ms) => new Promise((r) => setTimeout(r, Math.min(ms, 15))),
  attempts: 30,
  intervalMs: 10,
  settleMs: 60,
  ...extra,
});
const rowValues = (pg, code) => pg.evaluate((c) => { const r = document.querySelector('.tableRows[id="' + c + '"]'); return r ? Array.from(r.querySelectorAll(".data-middle-child-wapper")).map((w) => { const i = w.querySelector("input"); return i ? i.value : null; }) : null; }, code);
const clicks = (pg) => pg.evaluate(() => window.clicks);
const byKey = (out) => Object.fromEntries(out.results.map((r) => [`${r.irisCode}:${r.columnIndex}`, r]));
const FORBIDDEN = /Delete|Calculate|Save|Submit|Attribute|Normal Tax regime/i;


const dividendEntry = require("../electron-connect/iris-dividend-entry");
const fs = require("node:fs");
const vm = require("node:vm");
const ts = require("typescript");
const dividendField = {
 key:"64030055:dividendFinalTax", regime:"final",irisCode:"64030055",label:"Dividend u/s 150 @15%",panelTitle:"Final Tax",pickerTitle:"Add Final Tax",headerRowId:"999919",headers:["Taxable Amount","Tax Deducted","Tax Chargeable"],cells:"EED",values:[{columnIndex:0,column:"Taxable Amount",value:"100000"},{columnIndex:1,column:"Tax Deducted",value:"15000"}],
};
function snapshot() {return {filing:{taxYear:2026,filerType:"myself",incomeSources:["dividend"]},portalFieldMap:[{sourceGroup:"wealthFields",irisCode:"7098",rowDescriptionIncludes:"Income tax deducted u/s 150",value:"15000"}],otherSources:{taxDeductions:{version:"dividend-final-tax-v1",agentFields:[structuredClone(dividendField)],evidenceFingerprint:"tested-evidence-identity",wealth:{finalTaxIncome:{irisCode:"7033",expected:100000,readOnly:true},taxOutflow:{irisCode:"7098",section:"150",amount:15000},netBankCredits:85000}}}};}
function dividendPage(settings = {}) {
 return page(settings).replaceAll('>Business</mat-panel-title>', '>Other Sources</mat-panel-title>')
  .replaceAll('Tax Deduction', 'Tax Deductions')
  .replaceAll('64060285','64030055')
  .replaceAll('Export of services u/s 154A @1%', 'Dividend u/s 150 @15%')
  .replaceAll('999915','999919');
}
test("cash-dividend Electron route accepts only current source-scoped plan with one proven Wealth outflow", () => {
 const out=dividendEntry.getDividendPacketRoute(snapshot());assert.equal(out.active,true,out.reason);
 for(const mutate of [
  s=>s.filing.incomeSources.push("salary"),s=>s.filing.taxYear=2025,s=>s.filing.filerType="my_business",
  s=>delete s.otherSources,s=>s.otherSources.taxDeductions.version="old",
  s=>s.otherSources.taxDeductions.agentFields[0].irisCode="64220158",
  s=>s.otherSources.taxDeductions.agentFields[0].irisCode="64151351",
  s=>s.otherSources.taxDeductions.agentFields[0].label="Guessed label",
  s=>s.otherSources.taxDeductions.agentFields[0].headerRowId="999915",
  s=>s.otherSources.taxDeductions.agentFields.push(structuredClone(dividendField)),
  s=>s.otherSources.taxDeductions.wealth.finalTaxIncome.expected=85000,
  s=>s.otherSources.taxDeductions.wealth.netBankCredits=100000,
  s=>s.portalFieldMap.push({...s.portalFieldMap[0]}),s=>s.portalFieldMap=[],
 ]) {const s=snapshot();mutate(s);assert.equal(dividendEntry.getDividendPacketRoute(s).active,false);}
});
test("actual browser + shipped Dividend dispatch adds only Other Sources Final Tax and reads both amounts",async()=>{
 await withPage(dividendPage(),async(pg,win)=>{
  const route=dividendEntry.getDividendPacketRoute(snapshot());
  const out=await dividendEntry.fillDividendEntries(win,route,options());
  assert.equal(out.ok,true,JSON.stringify(out.results));
  assert.deepEqual(await rowValues(pg,"64030055"),["100000","15000",""]);
  const seen=await clicks(pg);assert.ok(seen.includes("Other Sources"));assert.ok(seen.includes("Tax Deductions"));
  assert.equal(seen.some(label=>/Employment|Save|Submit|Calculate|Delete|Payment|Regime/i.test(label)),false);
  assert.ok(out.results.every(row=>row.sectionId==="other_sources_tax_deductions"));
 });
});
test("Dividend dispatch identity failure writes nothing",async()=>{
 await withPage(dividendPage(),async(pg,win)=>{
  const out=await dividendEntry.fillDividendEntries(win,dividendEntry.getDividendPacketRoute(snapshot()),options({verifyDocument:async()=>({ok:false,status:"wrong_taxpayer"})}));
  assert.equal(out.ok,false);assert.equal((await clicks(pg)).length,0);assert.equal(await rowValues(pg,"64030055"),null);
 });
});
test("Dividend navigation registry and row allowlist do not admit bonus shares, CG or Business codes",()=>{
 assert.ok(navigation.ALL_SECTION_TOUR.some(s=>s.id==="other_sources_tax_deductions"&&s.group==="Other Sources"));
 assert.equal(navigation.ALL_SECTION_TOUR.some(s=>s.id==="capital_gain_tax_deductions"),false);
 for(const code of ["64151351","64220158","64060116"])assert.equal(navigation.isAllowedTaxDeductionTarget(code,"final tax","other_sources_tax_deductions"),false);
 assert.equal(navigation.isAllowedTaxDeductionTarget("64030055","final tax","other_sources_tax_deductions"),true);
});
test("new Other Sources probe verifies exact 999919 header in a synthetic browser fixture",async()=>{
 const html=dividendPage({panelsOpen:true}).replace('class="data-tab-left-btn " onclick="left(this)">Tax Deductions','class="data-tab-left-btn active" onclick="left(this)">Tax Deductions');
 await withPage(html,async(pg)=>{
  await pg.locator('#nav-business > mat-expansion-panel-header').click();
  await pg.getByRole('button',{name:'Tax Deductions',exact:true}).click();
  const result=await pg.evaluate(source=>(new Function(`return (${source})`))()({openReturn:true,taxYear:2026}),navigation.portalProbe.toString());
  assert.equal(result.section?.id,"other_sources_tax_deductions");
  assert.equal(result.section?.otherSourcesTaxDeductions?.verified,true,JSON.stringify(result.section));
 });
});
test("Dividend Wealth readback never treats absent 7033 or 703000 as zero or success",()=>{
 const route=dividendEntry.getDividendPacketRoute(snapshot());
 assert.equal(dividendEntry.checkDividendWealth(route,{"7033":"100,000","703000":"0"}).ok,true);
 for(const totals of [{},{"7033":"85000","703000":"0"},{"7033":"100000"},{"7033":"100000","703000":"15000"}])assert.equal(dividendEntry.checkDividendWealth(route,totals).ok,false);
});
test("main navigation and autofill both refuse stale Dividend envelopes before acquiring worker window",async()=>{
 const source=fs.readFileSync(require("node:path").join(__dirname,"../electron-connect/main.js"),"utf8");
 const ast=ts.createSourceFile("main.js",source,ts.ScriptTarget.Latest,true,ts.ScriptKind.JS);
 for(const name of ["runLocalIrisNavigationCheck","runRealIrisAutofill"]){
  const fn=ast.statements.find(node=>ts.isFunctionDeclaration(node)&&node.name?.text===name).getText(ast);
  let windows=0;
  const context=vm.createContext({console,Date,Promise,assertNavigatorBuild:()=>{},pensionEntryHold:()=>null,getServicesPacketRoute:()=>({incomeSources:["dividend"]}),irisDividendEntry:dividendEntry,ensureWorkerWindow:async()=>{windows++;throw new Error("worker must not open");}});
  vm.runInContext(fn,context);
  const s=snapshot();delete s.otherSources;
  const out=await context[name]({filingPacket:{snapshot:s}},{id:"test-job"},"live");
  assert.equal(out.paused,true);assert.equal(windows,0);assert.match(out.pauseMessage,/Dividend packet refused/);
 }
});
